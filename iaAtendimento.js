// iaAtendimento.js
// Módulo de IA de atendimento para a PAD Saúde Caruaru.
// Responde dúvidas de clientes via WhatsApp (mesmo número do central-disparo).
// A IA NUNCA agenda consultas sozinha — apenas informa e, quando necessário,
// avisa que um atendente humano vai continuar o atendimento.

const Anthropic = require("@anthropic-ai/sdk");
const clinicaInfo = require("./clinicaInfo");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Guarda o histórico recente de cada conversa em memória (por número de telefone).
// Em produção, isso pode ser trocado por um banco (SQLite/Postgres) para persistir
// entre reinícios do bot — ver seção "Próximos passos" no README.
const historicoConversas = new Map();
const MAX_MENSAGENS_HISTORICO = 10;

const CATEGORIAS_VALIDAS = ["AGENDAMENTO", "FINANCEIRO", "CONVENIO", "EXAMES", "URGENCIA", "GERAL", "OUTROS"];

function montarSystemPrompt({ pedirNome, pedirCidade, primeiraMensagem }) {
  let pedidoIdentificacao = "";
  if (pedirNome || pedirCidade) {
    const oQue = pedirNome && pedirCidade ? "o nome dela e de qual cidade ela é" : pedirNome ? "o nome dela" : "de qual cidade ela é";

    if (primeiraMensagem) {
      pedidoIdentificacao = `\nEssa é a PRIMEIRA mensagem dessa pessoa. Cumprimente rapidamente (uma frase curta) e já pergunte ${oQue} pra começar o atendimento — isso vem ANTES de qualquer outra coisa. Se ela já tiver feito uma pergunta específica junto com o cumprimento, responda a pergunta primeiro e pergunte ${oQue} logo em seguida, na mesma mensagem.\n`;
    } else {
      pedidoIdentificacao = `\nVocê ainda não sabe ${oQue}. Depois de responder a dúvida dela, pergunte educadamente e de forma natural (numa frase só, sem parecer formulário) ${oQue}, explicando brevemente que é pra atender melhor. Se ela já tiver respondido isso antes na conversa, não pergunte de novo.\n`;
    }
  }

  const instrucaoNomeCidade = `
Sempre que o cliente informar o PRÓPRIO NOME e/ou a CIDADE onde mora em qualquer
mensagem (seja porque você perguntou, seja espontaneamente), inclua ao final da
resposta as tags [NOME:<nome informado>] e/ou [CIDADE:<cidade informada>] — só
inclua a que foi REALMENTE informada nessa mensagem, exatamente como a pessoa
escreveu (só corrija capitalização óbvia). NUNCA invente nome ou cidade que a
pessoa não disse.`;

  return `Você é a assistente virtual de atendimento da ${clinicaInfo.nomeClinica}, uma clínica em ${clinicaInfo.cidade}.

Seu papel é APENAS:
- Tirar dúvidas sobre horários de funcionamento, convênios aceitos, especialidades, endereço e formas de contato.
- Dar orientações gerais e acolher a pessoa com simpatia e profissionalismo.
${pedidoIdentificacao}
Você NUNCA deve:
- Marcar, confirmar, remarcar ou cancelar consultas sozinha.
- Dar diagnósticos, orientações médicas específicas ou opinar sobre sintomas.
- Inventar informações que não estão nos dados da clínica abaixo.

Quando o cliente quiser AGENDAR, REMARCAR ou CANCELAR uma consulta, ou quando a dúvida
fugir do que você sabe, responda educadamente que vai encaminhar para um atendente humano
continuar, e inclua a tag [ENCAMINHAR_HUMANO] (ver formato completo abaixo).

Em TODA resposta (encaminhando ou não), finalize com esta tag, colada no final, sem nada
depois dela — isso é lido pelo sistema e nunca aparece pro cliente:

[ASSUNTO:<categoria>]

Se estiver encaminhando pra humano, coloque as duas tags juntas, nessa ordem:
[ENCAMINHAR_HUMANO][ASSUNTO:<categoria>]

Onde <categoria> é UMA destas, a que melhor descreve do que se trata a conversa:
- AGENDAMENTO: marcar, remarcar ou cancelar consulta
- FINANCEIRO: valores, pagamento, boleto, cobrança
- CONVENIO: dúvidas sobre convênios
- EXAMES: resultado de exame, pedido de exame, preparo pra exame
- URGENCIA: a pessoa descreve uma situação urgente/emergência
- GERAL: pergunta simples sobre horário, endereço, especialidades, contato
- OUTROS: qualquer outro assunto que não se encaixe acima
${instrucaoNomeCidade}
Dados da clínica:
- Nome: ${clinicaInfo.nomeClinica}
- Endereço: ${clinicaInfo.endereco}
- Horário de funcionamento: ${clinicaInfo.horarioFuncionamento}
- Convênios aceitos: ${clinicaInfo.conveniosAceitos.join(", ")}
- Especialidades: ${clinicaInfo.especialidades.join(", ")}
- Telefone/WhatsApp: ${clinicaInfo.telefone}

Responda sempre em português, de forma curta e direta (2-4 frases), como uma
mensagem de WhatsApp — sem formatação markdown, sem listas longas.`;
}

/**
 * Gera a resposta da IA para uma mensagem recebida de um cliente.
 * @param {string} numeroTelefone - número do cliente (usado como chave do histórico)
 * @param {string} mensagemCliente - texto da mensagem recebida
 * @param {{ pedirNome?: boolean, pedirCidade?: boolean }} contexto - o que ainda falta saber sobre esse paciente
 * @returns {Promise<{resposta: string, encaminharHumano: boolean, assunto: string|null, motivoTransferencia: string|null, nomeInformado: string|null, cidadeInformada: string|null}>}
 */
async function gerarResposta(numeroTelefone, mensagemCliente, contexto = {}) {
  const historico = historicoConversas.get(numeroTelefone) || [];

  const mensagens = [
    ...historico,
    { role: "user", content: mensagemCliente },
  ];

  const primeiraMensagem = historico.length === 0;

  const resposta = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: montarSystemPrompt({ ...contexto, primeiraMensagem }),
    messages: mensagens,
  });

  let textoResposta = resposta.content
    .filter((bloco) => bloco.type === "text")
    .map((bloco) => bloco.text)
    .join("\n")
    .trim();

  const encaminharHumano = textoResposta.includes("[ENCAMINHAR_HUMANO]");

  let assunto = null;
  const matchAssunto = textoResposta.match(/\[ASSUNTO:([A-Z]+)\]/);
  if (matchAssunto && CATEGORIAS_VALIDAS.includes(matchAssunto[1])) {
    assunto = matchAssunto[1];
  }
  // Se está encaminhando, o motivo da transferência é o próprio assunto —
  // e nesse caso específico não deixamos em branco: cai pra "OUTROS" se a
  // IA esqueceu de classificar, pra não perder o dado de que houve encaminhamento.
  const motivoTransferencia = encaminharHumano ? (assunto || "OUTROS") : null;

  let nomeInformado = null;
  const matchNome = textoResposta.match(/\[NOME:([^\]]+)\]/);
  if (matchNome) nomeInformado = matchNome[1].trim() || null;

  let cidadeInformada = null;
  const matchCidade = textoResposta.match(/\[CIDADE:([^\]]+)\]/);
  if (matchCidade) cidadeInformada = matchCidade[1].trim() || null;

  textoResposta = textoResposta
    .replace("[ENCAMINHAR_HUMANO]", "")
    .replace(/\[ASSUNTO:[A-Z]+\]/, "")
    .replace(/\[NOME:[^\]]+\]/, "")
    .replace(/\[CIDADE:[^\]]+\]/, "")
    .trim();

  // Atualiza histórico da conversa (limitado às últimas N mensagens)
  const novoHistorico = [
    ...mensagens,
    { role: "assistant", content: textoResposta },
  ].slice(-MAX_MENSAGENS_HISTORICO);
  historicoConversas.set(numeroTelefone, novoHistorico);

  return { resposta: textoResposta, encaminharHumano, assunto, motivoTransferencia, nomeInformado, cidadeInformada };
}

/** Limpa o histórico de uma conversa (ex: depois que um humano assume o atendimento) */
function limparHistorico(numeroTelefone) {
  historicoConversas.delete(numeroTelefone);
}

module.exports = { gerarResposta, limparHistorico };
