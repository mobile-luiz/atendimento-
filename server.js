// server.js
// Servidor web do painel gerencial: expõe a API que o dashboard consome e
// serve os arquivos estáticos (public/). Roda junto com o bot, na mesma
// aplicação, numa porta separada.

// Fixa o fuso horário do processo Node pra Caruaru/Recife (UTC-3), antes de
// qualquer outro código rodar. Sem isso, o servidor usa o fuso do host onde
// está hospedado (geralmente UTC), e cálculos como "hoje", "T00:00:00" dos
// filtros de período, etc. ficam até 3h deslocados do horário local.
process.env.TZ = "America/Recife";

const express = require("express");
const path = require("path");
const db = require("./db");
const insightsIA = require("./insightsIA");

let gerandoInsights = false; // evita duas chamadas à API rodando ao mesmo tempo

/**
 * Gera insights novos via IA e salva no banco. Cada chamada consome crédito
 * da API da Anthropic, por isso a geração automática só roda uma vez por dia
 * (às 23:59, horário de Caruaru) — o botão "Atualizar com IA" do painel
 * continua disponível pra gerar na hora, sob demanda, quando precisar.
 */
async function regenerarInsights() {
  if (gerandoInsights) return;
  gerandoInsights = true;
  try {
    const resumo = db.montarResumoParaInsights();
    const textos = await insightsIA.gerarInsights(resumo);
    db.salvarInsightsGerados(textos);
  } catch (erro) {
    console.error("Erro ao gerar insights com IA:", erro);
  } finally {
    gerandoInsights = false;
  }
}

/** Data (YYYY-MM-DD) e hora/minuto atuais no fuso de Caruaru (America/Recife). */
function agoraEmCaruaru() {
  const agora = new Date();
  const dataHoje = agora.toLocaleDateString("sv-SE", { timeZone: "America/Recife" });
  const [hora, minuto] = agora
    .toLocaleTimeString("sv-SE", {
      timeZone: "America/Recife",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .split(":")
    .map(Number);
  return { dataHoje, hora, minuto };
}

/**
 * Dispara a regeneração automática dos insights só uma vez por dia, às 23:59
 * (horário de Caruaru) — assim ela resume o dia inteiro de uma vez, em vez de
 * gastar crédito da API a cada poll do painel (que atualiza sozinho a cada
 * poucos segundos).
 */
function regenerarInsightsSeNecessario() {
  const { geradoEm } = db.obterInsightsGerados();
  const { dataHoje, hora, minuto } = agoraEmCaruaru();
  const dataUltimaGeracao = geradoEm
    ? new Date(geradoEm).toLocaleDateString("sv-SE", { timeZone: "America/Recife" })
    : null;

  const jaGerouHoje = dataUltimaGeracao === dataHoje;
  const passouDas2359 = hora === 23 && minuto >= 59;

  if (!jaGerouHoje && passouDas2359) {
    regenerarInsights(); // não usa await de propósito — roda em segundo plano, não trava a resposta
  }
}

/** Junta os dígitos e garante o código do Brasil (55) na frente. */
function normalizarNumeroBR(numeroDigitado) {
  const digitos = String(numeroDigitado).replace(/\D/g, "");
  return digitos.startsWith("55") ? digitos : `55${digitos}`;
}

/**
 * Confirma no próprio WhatsApp se um número digitado manualmente existe de
 * verdade, testando também a variante com o 9º dígito (mesmo ajuste feito
 * pro bot, já que esse bug de número incompleto também vale aqui).
 */
async function encontrarJidValido(sock, numeroDigitado) {
  const digitos = normalizarNumeroBR(numeroDigitado);
  const candidatos = [];

  if (digitos.length === 12) {
    const ddd = digitos.slice(2, 4);
    const numeroLocal = digitos.slice(4);
    candidatos.push(`55${ddd}9${numeroLocal}@s.whatsapp.net`);
  }
  candidatos.push(`${digitos}@s.whatsapp.net`);

  for (const candidato of candidatos) {
    try {
      const [resultado] = await sock.onWhatsApp(candidato);
      if (resultado?.exists && resultado?.jid) return resultado.jid;
    } catch (_) {
      // tenta o próximo candidato
    }
  }
  return null;
}

/**
 * @param {{ sock: any, resolverDestinoValido: Function }} contextoEnvio
 * Referência viva à conexão do WhatsApp (muda a cada reconexão do bot) e à
 * função que valida o número certo — usadas pra recepção conseguir mandar
 * mensagem direto pelo painel.
 */
function iniciarPainel(contextoEnvio = {}) {
  const app = express();
  const PORTA = process.env.PORT || 3000;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/estatisticas", (req, res) => {
    res.json(db.obterEstatisticas());
  });

  app.get("/api/metricas", (req, res) => {
    regenerarInsightsSeNecessario();
    const { desde, ate } = req.query;
    const inicioPeriodo = desde ? new Date(`${desde}T00:00:00`) : null;
    const fimPeriodo = ate ? new Date(`${ate}T00:00:00`) : null;
    res.json(db.obterMetricasGerenciais(inicioPeriodo, fimPeriodo));
  });

  // Gera insights novos na hora (usado pelo botão "Atualizar com IA" do painel).
  app.post("/api/insights/atualizar", async (req, res) => {
    if (gerandoInsights) {
      return res.status(409).json({ erro: "Já tem uma atualização de insights em andamento. Espere um momento." });
    }
    try {
      await regenerarInsights();
      res.json(db.obterInsightsGerados());
    } catch (erro) {
      console.error("Erro ao atualizar insights:", erro);
      res.status(500).json({ erro: "Não foi possível gerar os insights agora. Tente de novo." });
    }
  });

  app.get("/api/leads", (req, res) => {
    res.json(db.listarLeads());
  });

  app.get("/api/leads/:numero/mensagens", (req, res) => {
    res.json(db.listarMensagens(req.params.numero));
  });

  // Recepção manda uma mensagem direto pelo painel, sem precisar abrir o
  // WhatsApp separado. A conversa fica registrada como "humano" no histórico.
  app.post("/api/leads/:numero/enviar", async (req, res) => {
    const { numero } = req.params;
    const texto = (req.body?.texto || "").trim();
    const atendente = (req.body?.atendente || "").trim() || null;

    if (!texto) {
      return res.status(400).json({ erro: "Digite uma mensagem antes de enviar." });
    }
    if (!contextoEnvio.sock) {
      return res.status(503).json({
        erro: "O bot não está conectado ao WhatsApp agora. Espere reconectar e tente de novo.",
      });
    }

    try {
      // Usa o destino já validado e salvo (mais confiável); se por algum
      // motivo ainda não tiver sido salvo, resolve na hora antes de enviar.
      let destino = db.obterJidEnvio(numero);
      if (!destino) {
        destino = await contextoEnvio.resolverDestinoValido(contextoEnvio.sock, {
          remoteJid: numero,
        });
      }

      const enviada = await contextoEnvio.sock.sendMessage(destino, { text: texto });
      if (enviada?.key?.id) contextoEnvio.marcarComoEnviadoPeloSistema?.(enviada.key.id);
      db.registrarMensagem(numero, "humano", texto, null, null, atendente);
      // A recepção respondeu manualmente — a IA fica pausada nessa conversa
      // até alguém clicar em "Devolver pra IA".
      db.marcarEncaminhadoHumano(numero);
      res.json({ ok: true });
    } catch (erro) {
      console.error("Erro ao enviar mensagem da recepção:", erro);
      res.status(500).json({ erro: "Não foi possível enviar a mensagem. Tente de novo." });
    }
  });

  // Recepção inicia uma conversa nova, mandando a primeira mensagem pra um
  // número que ainda não escreveu pro bot.
  app.post("/api/conversas/iniciar", async (req, res) => {
    const numeroDigitado = (req.body?.numero || "").trim();
    const nome = (req.body?.nome || "").trim() || null;
    const texto = (req.body?.texto || "").trim();
    const atendente = (req.body?.atendente || "").trim() || null;

    if (!numeroDigitado) {
      return res.status(400).json({ erro: "Informe o número de WhatsApp (com DDD)." });
    }
    if (!texto) {
      return res.status(400).json({ erro: "Digite a mensagem inicial." });
    }
    if (!contextoEnvio.sock) {
      return res.status(503).json({
        erro: "O bot não está conectado ao WhatsApp agora. Espere reconectar e tente de novo.",
      });
    }

    try {
      const jid = await encontrarJidValido(contextoEnvio.sock, numeroDigitado);
      if (!jid) {
        return res.status(404).json({
          erro: "Esse número não foi encontrado no WhatsApp. Confira o DDD e os dígitos.",
        });
      }

      const enviada = await contextoEnvio.sock.sendMessage(jid, { text: texto });
      if (enviada?.key?.id) contextoEnvio.marcarComoEnviadoPeloSistema?.(enviada.key.id);
      db.registrarMensagem(jid, "humano", texto, nome, jid, atendente);
      // Conversa iniciada pela recepção fica sob responsabilidade humana até
      // alguém explicitamente devolver pra IA.
      db.marcarEncaminhadoHumano(jid);

      res.json({ ok: true, numero: jid });
    } catch (erro) {
      console.error("Erro ao iniciar conversa:", erro);
      res.status(500).json({ erro: "Não foi possível iniciar a conversa. Tente de novo." });
    }
  });

  // Devolve a conversa pra IA responder automaticamente de novo.
  app.post("/api/leads/:numero/resolver", (req, res) => {
    db.marcarAtivo(req.params.numero);
    res.json({ ok: true });
  });

  // Marca a conversa como finalizada e manda a pesquisa de satisfação pro
  // cliente ("1" resolvido / "2" não resolvido). Mesma lógica usada pelo
  // comando "#finalizar" no chat "Você" do WhatsApp.
  app.post("/api/leads/:numero/finalizar", async (req, res) => {
    const resultado = await contextoEnvio.finalizarConversaEEnviarPesquisa(
      contextoEnvio.sock,
      req.params.numero
    );
    res.json(resultado);
  });

  // Reabre uma conversa que tinha sido finalizada.
  app.post("/api/leads/:numero/reabrir", (req, res) => {
    db.reabrirConversa(req.params.numero);
    res.json({ ok: true });
  });

  app.listen(PORTA, () => {
    console.log(`📊 Painel gerencial disponível em http://localhost:${PORTA}`);
  });
}

module.exports = iniciarPainel;
