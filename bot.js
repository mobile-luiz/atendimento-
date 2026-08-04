// bot.js
// Bot WhatsApp independente para a IA de atendimento da PAD Saúde Caruaru.
// Roda separado do central-disparo, com seu próprio número/sessão WhatsApp.

require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  isJidNewsletter,
  isJidGroup,
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const path = require("path");
const { gerarResposta, limparHistorico } = require("./iaAtendimento");
const menuFluxo = require("./menuFluxo");
const db = require("./db");
const iniciarPainel = require("./server");

// Em produção (Render), a sessão do WhatsApp precisa ficar num disco
// persistente — o resto do sistema de arquivos é apagado a cada novo
// deploy. Se a variável de ambiente DADOS_DIR estiver definida (ex:
// "/data", apontando pro disco persistente), a sessão fica lá dentro;
// rodando local, sem essa variável, continua usando a pasta do projeto
// como sempre.
const PASTA_AUTH = process.env.DADOS_DIR
  ? path.join(process.env.DADOS_DIR, "auth_info_baileys")
  : "auth_info_baileys";

const logger = pino({ level: "silent" }); // troque para "info" se quiser ver logs do Baileys

// Cache de retentativa de mensagens (evita loop de reenvio quando o
// WhatsApp pede a mensagem de novo por falha na entrega) e um pequeno
// "armazém" das últimas mensagens enviadas, que o Baileys usa para
// reenviar automaticamente quando o destinatário sinaliza que não
// conseguiu decifrar (isso é uma causa comum de mensagem "sumir" sem erro).
const msgRetryCounterCache = new NodeCache();
const mensagensEnviadasRecentemente = new Map(); // id da mensagem -> conteúdo

function guardarParaRetry(id, mensagem) {
  mensagensEnviadasRecentemente.set(id, mensagem);
  // Evita crescer pra sempre: guarda só as últimas ~500 mensagens
  if (mensagensEnviadasRecentemente.size > 500) {
    const primeiraChave = mensagensEnviadasRecentemente.keys().next().value;
    mensagensEnviadasRecentemente.delete(primeiraChave);
  }
}

// Guarda o ID de toda mensagem que O PRÓPRIO SISTEMA mandou (seja resposta
// da IA, seja mensagem digitada pela recepção no painel). Serve pra
// distinguir: quando chega um evento de mensagem "enviada por nós" cujo ID
// NÃO está aqui, só pode ser alguém digitando manualmente no WhatsApp
// conectado (celular ou WhatsApp Web do número do bot) — nesse caso, o bot
// pausa a IA sozinho pra essa conversa.
const idsEnviadosPeloSistema = new Set();
function marcarComoEnviadoPeloSistema(id) {
  if (!id) return;
  idsEnviadosPeloSistema.add(id);
  if (idsEnviadosPeloSistema.size > 1000) {
    const primeiro = idsEnviadosPeloSistema.values().next().value;
    idsEnviadosPeloSistema.delete(primeiro);
  }
}

// Guarda o ID de toda mensagem RECEBIDA que já foi processada. O WhatsApp
// (via Baileys) às vezes reenvia o mesmo evento de mensagem mais de uma vez
// — principalmente depois de reconexões, que já vimos acontecer com
// frequência. Sem essa trava, a mesma pergunta do cliente seria processada
// duas vezes e a IA mandaria a resposta duplicada.
const idsMensagensProcessadas = new Set();
function jaProcessadaOuMarcar(id) {
  if (!id) return false; // sem ID, deixa passar (melhor processar do que travar por engano)
  if (idsMensagensProcessadas.has(id)) return true;
  idsMensagensProcessadas.add(id);
  if (idsMensagensProcessadas.size > 1000) {
    const primeiro = idsMensagensProcessadas.values().next().value;
    idsMensagensProcessadas.delete(primeiro);
  }
  return false;
}

// Contexto compartilhado com o painel (server.js): a conexão ativa do
// WhatsApp (que muda a cada reconexão) e a função de resolução de número,
// pra a recepção conseguir mandar mensagem direto pelo painel.
const contextoEnvio = {
  sock: null,
  resolverDestinoValido: null, // atribuída mais abaixo, depois de declarada
  marcarComoEnviadoPeloSistema,
};

// Valida a chave de API antes de tudo, com uma mensagem clara caso esteja
// faltando ou mal formatada (ex: com quebra de linha por causa de copiar/colar)
function validarApiKey() {
  const chave = process.env.ANTHROPIC_API_KEY;

  if (!chave) {
    console.error(
      "\n❌ ANTHROPIC_API_KEY não encontrada. Crie um arquivo .env (veja .env.example) com sua chave.\n"
    );
    process.exit(1);
  }

  if (/\s/.test(chave)) {
    console.error(
      "\n❌ ANTHROPIC_API_KEY contém espaço ou quebra de linha — provavelmente foi colada errado. Verifique o arquivo .env.\n"
    );
    process.exit(1);
  }
}

// Controla o intervalo entre tentativas de reconexão: cresce a cada falha
// seguida (1s, 2s, 4s... até 30s no máximo), pra não martelar reconexão
// sem parar quando o WhatsApp está rejeitando repetidamente — isso só
// pioraria os problemas de sessão. Reseta assim que a conexão fica estável.
let tentativasReconexaoSeguidas = 0;
const INTERVALO_MAXIMO_RECONEXAO_MS = 30000;

async function iniciarBot() {
  validarApiKey();
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // vamos desenhar o QR manualmente com qrcode-terminal
    auth: {
      creds: state.creds,
      // O keystore "cacheável" evita que o Baileys tenha que reler as
      // chaves do disco toda hora — isso reduz muito os casos de sessão
      // ficando "dessincronizada" (os "Closing session..." que apareciam).
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ["IA Atendimento PAD", "Chrome", "1.0.0"],
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
    // Ignora grupos, listas de transmissão e newsletters de uma vez,
    // antes mesmo de a mensagem chegar no listener.
    shouldIgnoreJid: (jid) =>
      isJidBroadcast(jid) || isJidNewsletter(jid) || isJidGroup(jid),
    // Quando o WhatsApp pede uma mensagem de novo (porque não conseguiu
    // decifrar da primeira vez), o Baileys chama essa função pra saber o
    // que reenviar. Sem isso, a mensagem simplesmente se perde nesse caso.
    getMessage: async (key) => {
      return mensagensEnviadasRecentemente.get(key.id) || undefined;
    },
  });

  sock.ev.on("creds.update", saveCreds);
  contextoEnvio.sock = sock;

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nEscaneie o QR code abaixo com o WhatsApp que vai atender:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      contextoEnvio.sock = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `Conexão encerrada (status ${statusCode}). Reconectar? ${deveReconectar}`
      );

      if (deveReconectar) {
        const espera = Math.min(1000 * 2 ** tentativasReconexaoSeguidas, INTERVALO_MAXIMO_RECONEXAO_MS);
        tentativasReconexaoSeguidas += 1;
        console.log(`Tentando reconectar em ${Math.round(espera / 1000)}s...`);
        setTimeout(() => iniciarBot(), espera);
      } else {
        console.log(
          "Sessão deslogada. Apague a pasta 'auth_info_baileys' e rode novamente para gerar um novo QR code."
        );
      }
    } else if (connection === "open") {
      tentativasReconexaoSeguidas = 0;
      console.log("✅ Bot conectado ao WhatsApp com sucesso!");
    }
  });

  registrarListenerDeAtendimento(sock);
}

function normalizarDigitos(jidOuNumero) {
  // Remove o domínio ("@s.whatsapp.net"/"@lid") E o sufixo de dispositivo
  // (ex: ":12" no jid do próprio bot), deixando só os dígitos do número.
  return String(jidOuNumero).split("@")[0].split(":")[0].replace(/\D/g, "");
}

/**
 * Descobre o JID (destino) realmente válido pra mandar mensagem, em vez de
 * confiar direto no que o evento trouxe. Isso corrige um bug conhecido em
 * que o número de telefone resolvido a partir de um "@lid" chega com um
 * dígito faltando (comum com números brasileiros), fazendo a mensagem ser
 * enviada pra um número que não existe — sem nenhum erro aparente.
 */
async function resolverDestinoValido(sock, key) {
  const candidatos = [];

  // Números de celular brasileiros SEMPRE têm 9 dígitos após o DDD (o "9"
  // seguido de 8 números). O WhatsApp às vezes resolve o "@lid" pro formato
  // antigo, sem esse 9 — e embora o WhatsApp "valide" essa versão truncada
  // como existente (é a mesma conta, reconhecida por compatibilidade), o
  // envio de mensagem só funciona de verdade pro número completo. Por isso
  // testamos a versão CORRETA (com o 9) primeiro, antes da truncada.
  if (key.senderPn) {
    const digitos = normalizarDigitos(key.senderPn);
    if (digitos.startsWith("55") && digitos.length === 12) {
      const ddd = digitos.slice(2, 4);
      const numeroLocal = digitos.slice(4);
      candidatos.push(`55${ddd}9${numeroLocal}@s.whatsapp.net`);
    }
    candidatos.push(key.senderPn);
  }
  if (key.remoteJid) candidatos.push(key.remoteJid);

  for (const candidato of candidatos) {
    try {
      const [resultado] = await sock.onWhatsApp(candidato);
      if (resultado?.exists && resultado?.jid) {
        return resultado.jid;
      }
    } catch (_) {
      // ignora e tenta o próximo candidato
    }
  }

  // Se nada foi confirmado como válido, usa o remoteJid original como
  // última tentativa (mantém o comportamento anterior como fallback).
  return key.senderPn || key.remoteJid;
}
contextoEnvio.resolverDestinoValido = resolverDestinoValido;

/**
 * Confirma no WhatsApp se um número digitado à mão (num comando, por
 * exemplo) existe de verdade — testando também a variante com o 9º dígito,
 * já que o mesmo bug de número incompleto vale aqui.
 */
async function validarNumeroDigitado(sock, numeroDigitado) {
  const digitos = normalizarDigitos(numeroDigitado).startsWith("55")
    ? normalizarDigitos(numeroDigitado)
    : `55${normalizarDigitos(numeroDigitado)}`;

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
    } catch (_) {}
  }
  return null;
}

/**
 * Finaliza a conversa e manda a pesquisa de satisfação — usada tanto pelo
 * botão do painel quanto pelo comando "#finalizar" no chat "Você".
 */
async function finalizarConversaEEnviarPesquisa(sock, numero) {
  db.marcarFinalizada(numero);

  if (!sock) return { ok: true, pesquisaEnviada: false };

  try {
    let destino = db.obterJidEnvio(numero);
    if (!destino) {
      destino = await resolverDestinoValido(sock, { remoteJid: numero });
    }

    const textoPesquisa =
      "Esse atendimento foi finalizado! 🙂\n\nSeu problema foi resolvido?\n\n*1* - Sim, foi resolvido\n*2* - Não foi resolvido\n\nResponda só com o número da opção.";

    const enviada = await sock.sendMessage(destino, { text: textoPesquisa });
    if (enviada?.key?.id) marcarComoEnviadoPeloSistema(enviada.key.id);

    db.registrarMensagem(numero, "sistema", textoPesquisa);
    db.marcarPesquisaPendente(numero);

    return { ok: true, pesquisaEnviada: true };
  } catch (erro) {
    console.error("Erro ao enviar pesquisa de satisfação:", erro);
    return { ok: true, pesquisaEnviada: false };
  }
}
contextoEnvio.finalizarConversaEEnviarPesquisa = finalizarConversaEEnviarPesquisa;

const CHAVE_ATENDENTE_ATIVO = "atendente_ativo_whatsapp";

/**
 * Trata comandos digitados no chat "Você" (mensagem pra si mesmo) do
 * WhatsApp conectado ao bot — um jeito de dar comandos que NUNCA aparece
 * pro cliente, já que não é a conversa com ele.
 *
 * Comandos disponíveis:
 *   #finalizar [número]   -> finaliza a conversa em aberto (mais recente,
 *                             ou a de um número específico) e manda a pesquisa.
 *   #nome <nome>           -> define quem está respondendo manualmente pelo
 *                             WhatsApp a partir de agora (fica salvo até
 *                             alguém trocar de novo, mesmo se o bot reiniciar).
 *
 * Retorna true se o texto era um comando reconhecido (mesmo que tenha
 * falhado), false se não era comando nenhum.
 */
async function tratarComandoSelfChat(sock, meuJid, texto) {
  const textoLimpo = texto.trim();

  const matchNome = textoLimpo.match(/^#nome\s*(.*)$/i);
  if (matchNome) {
    const nomeInformado = matchNome[1].trim();

    if (!nomeInformado) {
      const atual = db.obterConfiguracao(CHAVE_ATENDENTE_ATIVO);
      await sock.sendMessage(meuJid, {
        text: atual
          ? `👤 Atendente ativo agora: ${atual}`
          : "👤 Nenhum atendente definido ainda. Use \"#nome Seu Nome\" pra definir.",
      });
      return true;
    }

    db.definirConfiguracao(CHAVE_ATENDENTE_ATIVO, nomeInformado);
    await sock.sendMessage(meuJid, {
      text: `✅ Atendente ativo agora: ${nomeInformado}. Suas próximas mensagens digitadas aqui no WhatsApp vão ficar registradas com esse nome, até alguém trocar de novo com "#nome".`,
    });
    return true;
  }

  const matchFinalizar = textoLimpo.match(/^#finalizar\s*(.*)$/i);
  if (matchFinalizar) {
    const argumento = matchFinalizar[1].trim();
    let lead = null;

    if (argumento) {
      const jidValidado = await validarNumeroDigitado(sock, argumento);
      if (jidValidado) lead = db.obterLeadPorJidOuNumero(jidValidado);
    } else {
      lead = db.obterConversaAbertaMaisRecente();
    }

    if (!lead) {
      await sock.sendMessage(meuJid, {
        text: argumento
          ? `⚠️ Não encontrei nenhuma conversa com o número "${argumento}". Confira o DDD e os dígitos.`
          : "⚠️ Não encontrei nenhuma conversa em aberto pra finalizar agora.",
      });
      return true;
    }

    await finalizarConversaEEnviarPesquisa(sock, lead.numero);
    await sock.sendMessage(meuJid, {
      text: `✅ Conversa com ${lead.nome || normalizarDigitos(lead.numero)} finalizada. Pesquisa de satisfação enviada pra ela.`,
    });
    return true;
  }

  return false;
}

// Garante que mensagens do MESMO número sejam processadas uma de cada vez,
// em ordem — sem isso, se o cliente manda duas mensagens rápido (antes da
// IA terminar de responder a primeira), as duas seriam processadas ao
// mesmo tempo e uma poderia sobrescrever o histórico de conversa da outra.
const filaPorNumero = new Map();
function enfileirarPorNumero(numero, tarefa) {
  const anterior = filaPorNumero.get(numero) || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa); // roda mesmo se a tarefa anterior tiver falhado
  filaPorNumero.set(
    numero,
    atual.catch(() => {})
  );
  return atual;
}

function registrarListenerDeAtendimento(sock) {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.remoteJid?.endsWith("@g.us")) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      try {
        // --- Chat "Você" (mensagem pra si mesmo) ---
        // É o canal de comando privado: nada digitado aqui chega ao
        // cliente, porque não é a conversa com ele.
        const meuJid = sock.user?.id;
        const ehChatComigoMesmo =
          meuJid && msg.key.remoteJid && normalizarDigitos(meuJid) === normalizarDigitos(msg.key.remoteJid);

        if (ehChatComigoMesmo && msg.key.fromMe) {
          const textoComando =
            msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
          // Só marca como "processado" quando tem conteúdo de verdade — se
          // a descriptografia falhou nessa tentativa (texto vazio), deixa o
          // ID livre pra quando o WhatsApp reenviar/reconseguir decifrar.
          if (textoComando) {
            if (jaProcessadaOuMarcar(msg.key.id)) continue;
            await tratarComandoSelfChat(sock, meuJid, textoComando);
          }
          continue; // chat "Você" não segue o fluxo normal de atendimento
        }

        // --- Mensagem enviada "por nós mesmos" (fromMe) ---
        // Isso acontece em dois casos: (1) foi o próprio bot que mandou
        // (resposta da IA ou mensagem da recepção pelo painel) — nesse caso
        // o ID já está em idsEnviadosPeloSistema e a gente ignora, porque
        // já foi tratada no momento do envio. (2) alguém digitou e mandou
        // manualmente no WhatsApp conectado (celular ou WhatsApp Web) — o
        // ID NÃO está na lista, e isso é o sinal de que um humano assumiu a
        // conversa por fora do painel. Nesse caso, registramos e pausamos a IA.
        if (msg.key.fromMe) {
          if (!idsEnviadosPeloSistema.has(msg.key.id)) {
            const numeroCliente = msg.key.remoteJid;
            const textoHumano =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              "";

            if (textoHumano && numeroCliente) {
              // Só marca como "processado" com conteúdo confirmado — mesma
              // lógica: falha de descriptografia não deve travar retentativa.
              if (jaProcessadaOuMarcar(msg.key.id)) continue;

              // Comando "#finalizar" digitado DIRETO na conversa com o
              // cliente (não no chat "Você"). Diferente do chat "Você", essa
              // mensagem já foi entregue pro celular do cliente antes do bot
              // conseguir reagir — por isso, em vez de tratá-la como uma
              // resposta normal, EDITAMOS ela pra "#finalizada" (em vez de
              // apagar, que deixaria o aviso "mensagem apagada" visível pro
              // cliente) e mandamos a pesquisa de satisfação em seguida. Se o
              // WhatsApp não deixar editar (passou do prazo, ou o cliente já
              // tinha lido), a pesquisa é enviada do mesmo jeito — só o
              // "#finalizar" original pode ficar visível pro cliente nesse
              // caso raro.
              if (/^#finalizar$/i.test(textoHumano.trim())) {
                try {
                  await sock.sendMessage(msg.key.remoteJid, {
                    text: "#finalizada",
                    edit: msg.key,
                  });
                } catch (erroEditar) {
                  console.error("Não consegui editar o '#finalizar' digitado na conversa:", erroEditar);
                }
                await finalizarConversaEEnviarPesquisa(sock, numeroCliente);
                continue;
              }

              // Comando "#<nome> <mensagem>" digitado DIRETO na conversa com
              // o cliente — ex: "#luiz teste". Isso faz três coisas de uma
              // vez: (1) define esse nome como atendente ativo, do mesmo
              // jeito que o "#nome" no chat "Você", valendo pras próximas
              // mensagens digitadas direto também; (2) EDITA a mensagem pra
              // aparecer formatada como "*Luiz:* teste" pro cliente, então
              // ele já vê quem está falando com ele; (3) salva no sistema com
              // esse atendente, pra entrar certinho na Performance dos
              // Atendentes. Se digitar só "#luiz" sem nada depois, vira um
              // aviso genérico de início de atendimento. "#finalizar" fica de
              // fora dessa regra (é tratado acima, à parte).
              const matchNomeDireto = textoHumano.trim().match(/^#([a-zA-ZÀ-ÿ0-9_]+)(?:\s+([\s\S]+))?$/);
              if (matchNomeDireto && matchNomeDireto[1].toLowerCase() !== "finalizar") {
                const nomeFormatado =
                  matchNomeDireto[1].charAt(0).toUpperCase() + matchNomeDireto[1].slice(1).toLowerCase();
                const restoMensagem = (matchNomeDireto[2] || "").trim();
                const textoParaCliente = restoMensagem
                  ? `*${nomeFormatado}:* ${restoMensagem}`
                  : `🧑‍⚕️ ${nomeFormatado} iniciou o atendimento.`;

                db.definirConfiguracao(CHAVE_ATENDENTE_ATIVO, nomeFormatado);

                try {
                  await sock.sendMessage(msg.key.remoteJid, { text: textoParaCliente, edit: msg.key });
                } catch (erroEditarNome) {
                  console.error("Não consegui editar a mensagem com o nome do atendente:", erroEditarNome);
                }

                console.log(`[Humano (${nomeFormatado}) digitou direto no WhatsApp -> ${numeroCliente}] ${textoParaCliente}`);
                db.registrarMensagem(numeroCliente, "humano", textoParaCliente, null, null, nomeFormatado);
                db.marcarEncaminhadoHumano(numeroCliente);
                limparHistorico(numeroCliente);
                continue;
              }

              const atendenteAtivo = db.obterConfiguracao(CHAVE_ATENDENTE_ATIVO);
              console.log(
                `[Humano${atendenteAtivo ? ` (${atendenteAtivo})` : ""} digitou direto no WhatsApp -> ${numeroCliente}] ${textoHumano}`
              );
              db.registrarMensagem(numeroCliente, "humano", textoHumano, null, null, atendenteAtivo);
              db.marcarEncaminhadoHumano(numeroCliente);
              limparHistorico(numeroCliente);
            }
          }
          continue;
        }
      } catch (erro) {
        // Erro fora do fluxo de atendimento ao cliente (comando, mensagem
        // manual etc.) — só loga. NÃO manda mensagem de desculpa pra
        // ninguém aqui, porque nem sempre há um "cliente" envolvido nesse
        // ponto (ex: erro processando um comando no chat "Você").
        console.error("Erro processando evento de mensagem:", erro);
        continue;
      }

      // O WhatsApp às vezes identifica o cliente com um "@lid" (id
      // anônimo) em vez do número de telefone, e o número de telefone
      // que vem junto (senderPn) pode chegar incompleto/truncado (bug
      // conhecido de resolução de @lid). Por isso, em vez de confiar
      // cegamente nesse número, perguntamos pro próprio WhatsApp qual é
      // o destino válido antes de enviar.
      const numeroCliente = msg.key.remoteJid;

      // A partir daqui é fluxo de atendimento real ao cliente — processado
      // dentro da fila por número, pra nunca deixar duas mensagens da
      // mesma pessoa serem tratadas ao mesmo tempo (o que poderia fazer
      // uma sobrescrever o histórico de conversa da outra).
      enfileirarPorNumero(numeroCliente, async () => {
        let numeroParaEnviar = numeroCliente; // fallback, ajustado logo abaixo
        try {
          numeroParaEnviar = await resolverDestinoValido(sock, msg.key);
          const textoRecebido =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";

          if (!textoRecebido) return; // ignora mídia sem legenda, áudio, figurinha, etc.

          // Só a partir daqui marcamos o ID como "processado". Se essa
          // mesma mensagem tinha chegado antes com falha de descriptografia
          // (texto vazio), aquela tentativa nunca foi marcada — então essa,
          // com conteúdo de verdade, ainda passa normalmente.
          if (jaProcessadaOuMarcar(msg.key.id)) return;

          console.log(`[Cliente ${numeroCliente}] ${textoRecebido}`);

          const leadAtual = db.obterLead(numeroCliente);

          // Se tem uma pesquisa de satisfação esperando resposta e o cliente
          // mandou "1" ou "2", trata isso como resposta da pesquisa — não
          // como uma pergunta nova pra IA responder.
          if (leadAtual?.pesquisa_pendente) {
            const respostaLimpa = textoRecebido.trim();
            if (respostaLimpa === "1" || respostaLimpa === "2") {
              db.registrarMensagem(numeroCliente, "cliente", textoRecebido, msg.pushName || null, numeroParaEnviar, null, true);

              const resultado = respostaLimpa === "1" ? "resolvido" : "nao_resolvido";
              db.registrarRespostaPesquisa(numeroCliente, resultado);

              const textoAgradecimento =
                resultado === "resolvido"
                  ? "Que ótimo! Muito obrigado pelo retorno 😊"
                  : "Poxa, sentimos muito que não tenha resolvido. Já registramos isso e vamos verificar. Obrigado por avisar!";

              const enviadaAgradecimento = await sock.sendMessage(numeroParaEnviar, { text: textoAgradecimento });
              if (enviadaAgradecimento?.key?.id) {
                marcarComoEnviadoPeloSistema(enviadaAgradecimento.key.id);
              }
              db.registrarMensagem(numeroCliente, "sistema", textoAgradecimento);

              console.log(`📋 [Pesquisa] ${numeroCliente} respondeu: ${resultado}`);
              return;
            }
            // Se a mensagem não for "1" nem "2", deixa passar pro fluxo
            // normal abaixo (não trava o cliente esperando uma resposta exata).
          }

          db.registrarMensagem(numeroCliente, "cliente", textoRecebido, msg.pushName || null, numeroParaEnviar);

          // Se um humano (recepção pelo painel, ou alguém digitando direto
          // no WhatsApp) já assumiu essa conversa, a IA fica quieta — só
          // registra a mensagem do cliente e deixa o humano ver e responder.
          if (leadAtual?.status === "encaminhado_humano") {
            console.log(`⏸️  IA pausada nessa conversa (aguardando humano) — não respondeu.`);
            return;
          }

          // Se o cliente está no meio do menu numérico (1-4 e submenus),
          // trata a resposta aqui — com textos fixos, sem passar pela IA —
          // pra nunca errar preço/condição de plano. Se a mensagem não bater
          // com nenhuma opção válida do menu atual, cai pro fluxo livre da
          // IA normalmente (não trava a pessoa num menu que ela não quer).
          const tratadoPeloMenu = await menuFluxo.tratarFluxoMenu(
            sock,
            numeroParaEnviar,
            numeroCliente,
            textoRecebido,
            { marcarComoEnviadoPeloSistema, guardarParaRetry }
          );
          if (tratadoPeloMenu) return;

          // Mostra "digitando..." pro cliente enquanto a IA processa
          await sock.presenceSubscribe(numeroParaEnviar).catch(() => {});
          await sock.sendPresenceUpdate("composing", numeroParaEnviar).catch(() => {});

          // Só pede nome/cidade se ainda não sabe E se for bem no início da
          // conversa (poucas mensagens trocadas) — pra não ficar insistindo
          // numa conversa mais longa se a pessoa não quis responder antes.
          const conversaRecente = (leadAtual?.total_mensagens ?? 0) <= 2;
          const contextoIdentificacao = {
            pedirNome: conversaRecente && !leadAtual?.nome,
            pedirCidade: conversaRecente && !leadAtual?.cidade,
          };

          const { resposta, encaminharHumano, assunto, motivoTransferencia, nomeInformado, cidadeInformada } =
            await gerarResposta(numeroCliente, textoRecebido, contextoIdentificacao);

          const enviada = await sock.sendMessage(numeroParaEnviar, { text: resposta });
          if (enviada?.key?.id && enviada?.message) {
            guardarParaRetry(enviada.key.id, enviada.message);
            marcarComoEnviadoPeloSistema(enviada.key.id);
          }
          console.log(`[IA -> ${numeroParaEnviar}] ${resposta}`);
          db.registrarMensagem(numeroCliente, "ia", resposta);
          if (assunto) db.definirAssunto(numeroCliente, assunto);
          if (nomeInformado) db.definirNomeInformado(numeroCliente, nomeInformado);
          if (cidadeInformada) db.definirCidade(numeroCliente, cidadeInformada);

          if (encaminharHumano) {
            console.log(`⚠️  [ENCAMINHAR HUMANO] Conversa com ${numeroCliente} precisa de atendente (motivo: ${motivoTransferencia}).`);
            limparHistorico(numeroCliente);
            db.marcarEncaminhadoHumano(numeroCliente);
            if (motivoTransferencia) db.definirMotivoTransferencia(numeroCliente, motivoTransferencia);
            if (!leadAtual) {
              console.log(`ℹ️  [MENU] Não enviado — primeira mensagem já foi encaminhada direto pra humano.`);
            }
            // TODO (opcional): notificar um número/grupo interno aqui, ex:
            // await sock.sendMessage("SEU_NUMERO@s.whatsapp.net", { text: `Cliente ${numeroCliente} precisa de atendimento humano.` });
          } else if (!leadAtual || leadAtual?.finalizada) {
            // Manda o menu numérico (1-4) quando: (a) é a primeira mensagem
            // dessa pessoa, ou (b) a conversa dela já tinha sido finalizada
            // antes e essa mensagem a reabriu — pro cliente, reiniciar uma
            // conversa encerrada deve se sentir como começar do zero de novo.
            if (leadAtual?.finalizada) {
              console.log(`🔁 [MENU] Conversa com ${numeroCliente} estava finalizada e foi reaberta — reenviando menu.`);
            }
            await menuFluxo.enviarMenuPrincipal(sock, numeroParaEnviar, numeroCliente, {
              marcarComoEnviadoPeloSistema,
              guardarParaRetry,
            });
          } else {
            console.log(`ℹ️  [MENU] Não enviado — ${numeroCliente} já tinha conversa registrada antes (não é lead novo).`);
          }
        } catch (erro) {
          console.error("Erro ao processar mensagem do cliente:", erro);
          // Registra a falha técnica de verdade (pra métrica real de
          // "falhas da IA" no painel — não é uma estimativa, é toda vez
          // que isso caiu aqui).
          try {
            db.registrarFalhaIA(numeroCliente);
          } catch (_) {}
          try {
            const enviadaErro = await sock.sendMessage(numeroParaEnviar, {
              text: "Desculpe, tive um problema para responder agora. Em instantes um atendente vai continuar por aqui.",
            });
            if (enviadaErro?.key?.id) marcarComoEnviadoPeloSistema(enviadaErro.key.id);
          } catch (_) {}
        }
      });
    }
  });
}

iniciarPainel(contextoEnvio);

iniciarBot().catch((erro) => {
  console.error("Erro fatal ao iniciar o bot:", erro);
  process.exit(1);
});
