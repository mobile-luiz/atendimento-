// db.js
// Banco de dados local (SQLite) que registra cada lead (número que interagiu
// com o bot) e o histórico completo das conversas, para alimentar o painel
// gerenciaL.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

// Mesma lógica do bot.js: em produção (Render), o banco fica no disco
// persistente (DADOS_DIR); local, continua na pasta do projeto.
const CAMINHO_DB = process.env.DADOS_DIR
  ? path.join(process.env.DADOS_DIR, "atendimento.db")
  : path.join(__dirname, "atendimento.db");

const db = new DatabaseSync(CAMINHO_DB);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    numero TEXT PRIMARY KEY,
    nome TEXT,
    primeira_mensagem_em TEXT NOT NULL,
    ultima_mensagem_em TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ativo', -- 'ativo' | 'encaminhado_humano'
    total_mensagens INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    remetente TEXT NOT NULL, -- 'cliente' | 'ia' | 'humano'
    texto TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    FOREIGN KEY (numero) REFERENCES leads(numero)
  );

  CREATE INDEX IF NOT EXISTS idx_mensagens_numero ON mensagens(numero);

  CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE IF NOT EXISTS falhas_ia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    criado_em TEXT NOT NULL
  );
`);

// Migração segura: motivo pelo qual a conversa foi encaminhada pra humano
// (categorizado pela própria IA na hora de encaminhar).
try {
  db.exec(`ALTER TABLE leads ADD COLUMN motivo_transferencia TEXT`);
} catch (e) {}

// Migração segura: assunto geral da conversa, classificado pela IA em toda
// resposta (não só quando encaminha) — usado na lista de "conversas recentes".
try {
  db.exec(`ALTER TABLE leads ADD COLUMN assunto TEXT`);
} catch (e) {}

// Migração segura: cidade do paciente, informada por ele mesmo na conversa
// (a IA pergunta educadamente no início, sem insistir depois).
try {
  db.exec(`ALTER TABLE leads ADD COLUMN cidade TEXT`);
} catch (e) {}

// Migração segura: adiciona a coluna "atendente" nas mensagens — guarda o
// nome de quem respondeu manualmente (painel ou WhatsApp direto), pra saber
// quem atendeu cada conversa.
try {
  db.exec(`ALTER TABLE mensagens ADD COLUMN atendente TEXT`);
} catch (e) {
  // coluna já existe — ok, ignora.
}

// Migração segura: adiciona a coluna jid_envio se ainda não existir (guarda
// o destino de WhatsApp já validado desse lead, pra recepção conseguir
// responder direto pelo painel sem repetir a resolução do número toda vez).
try {
  db.exec(`ALTER TABLE leads ADD COLUMN jid_envio TEXT`);
} catch (e) {
  // coluna já existe — ok, ignora.
}

// Migração segura: adiciona a coluna finalizada (0 = em aberto, 1 = encerrada).
try {
  db.exec(`ALTER TABLE leads ADD COLUMN finalizada INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // coluna já existe — ok, ignora.
}

// Migração segura: guarda se a conversa JÁ passou por um humano em algum
// momento (nunca é resetada depois). Diferente da coluna "status", que
// reflete o estado ATUAL (e volta pra 'ativo' quando a conversa é
// finalizada) — sem essa coluna separada, uma conversa finalizada "esquecia"
// que precisou de atendente, fazendo a taxa de encaminhamento pra humano
// cair errado (inclusive zerar) assim que as conversas eram encerradas.
try {
  db.exec(`ALTER TABLE leads ADD COLUMN passou_por_humano INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // coluna já existe — ok, ignora.
}
// Corrige o histórico já existente: qualquer lead que tenha uma mensagem
// "humana" registrada, ou que já esteja com status 'encaminhado_humano'
// agora, com certeza passou por humano em algum momento.
try {
  db.exec(`
    UPDATE leads SET passou_por_humano = 1
    WHERE status = 'encaminhado_humano'
       OR numero IN (SELECT DISTINCT numero FROM mensagens WHERE remetente = 'humano')
  `);
} catch (e) {}

// Migrações seguras: colunas da pesquisa de satisfação enviada ao finalizar.
try {
  db.exec(`ALTER TABLE leads ADD COLUMN pesquisa_pendente INTEGER NOT NULL DEFAULT 0`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE leads ADD COLUMN pesquisa_resposta TEXT`); // 'resolvido' | 'nao_resolvido'
} catch (e) {}
try {
  db.exec(`ALTER TABLE leads ADD COLUMN pesquisa_enviada_em TEXT`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE leads ADD COLUMN pesquisa_respondida_em TEXT`);
} catch (e) {}

// Migração segura: número de protocolo gerado toda vez que a conversa é
// encaminhada pra atendimento humano — dá pro cliente algo concreto pra
// referenciar (e aparece no histórico/painel).
try {
  db.exec(`ALTER TABLE leads ADD COLUMN protocolo TEXT`);
} catch (e) {}

/**
 * Converte duas datas (início do dia "desde" até o fim do dia "ate") num
 * intervalo ISO [inicioISO, fimISO) pronto pra usar em cláusulas SQL
 * "coluna >= ? AND coluna < ?". Retorna null se desde/ate não foram informados
 * (nesse caso, quem usa o helper deve tratar como "sem filtro", todo o histórico).
 */
/**
 * Recebe "desde"/"ate" como veio da requisição — string "YYYY-MM-DD" (o
 * caminho normal, vindo do seletor de período) ou, por segurança, um objeto
 * Date (chamadas antigas) — e devolve sempre o dia de calendário de Caruaru
 * correspondente, como string "YYYY-MM-DD".
 */
function paraDiaLocalRecife(valor) {
  return typeof valor === "string" ? valor.slice(0, 10) : new Date(valor).toLocaleDateString("sv-SE", { timeZone: "America/Recife" });
}

function prepararIntervaloPeriodo(desde, ate) {
  if (!desde || !ate) return null;
  const diaInicio = paraDiaLocalRecife(desde);
  const diaFimSelecionado = paraDiaLocalRecife(ate); // "ate" é inclusivo
  const { inicioISO } = obterLimitesDiaRecife(diaInicio);
  const { inicioISO: fimISO } = obterLimitesDiaRecife(proximoDiaISO(diaFimSelecionado));
  return { inicioISO, fimISO };
}

/**
 * Registra uma mensagem (do cliente, da IA ou da recepção) e atualiza/cria
 * o lead correspondente. `jidEnvio`, quando informado, é o destino de
 * WhatsApp já validado (número real, não o "@lid") — guardado no lead pra
 * a recepção conseguir responder direto pelo painel depois. `atendente`,
 * quando informado, guarda o nome de quem mandou a mensagem manualmente
 * (recepção pelo painel ou alguém digitando direto no WhatsApp).
 */
function registrarMensagem(numero, remetente, texto, nome = null, jidEnvio = null, atendente = null, manterFinalizada = false) {
  const agora = new Date().toISOString();

  const leadExistente = db.prepare("SELECT numero FROM leads WHERE numero = ?").get(numero);

  if (leadExistente) {
    db.prepare(
      `UPDATE leads
       SET ultima_mensagem_em = ?, total_mensagens = total_mensagens + 1,
           nome = COALESCE(?, nome),
           jid_envio = COALESCE(?, jid_envio)
       WHERE numero = ?`
    ).run(agora, nome, jidEnvio, numero);

    // Se o cliente escreveu de novo numa conversa que já tinha sido
    // finalizada, reabre automaticamente — senão a mensagem nova passaria
    // despercebida numa conversa "fechada". Exceção: a resposta da própria
    // pesquisa de satisfação (manterFinalizada=true) não conta como "voltou
    // a conversar" — sem essa exceção, responder a pesquisa já reabria a
    // conversa sozinha, fazendo o sistema achar que ela nunca tinha sido
    // finalizada quando o cliente mandava uma mensagem de verdade depois.
    if (remetente === "cliente" && !manterFinalizada) {
      db.prepare(`UPDATE leads SET finalizada = 0 WHERE numero = ?`).run(numero);
    }
  } else {
    db.prepare(
      `INSERT INTO leads (numero, nome, primeira_mensagem_em, ultima_mensagem_em, status, total_mensagens, jid_envio)
       VALUES (?, ?, ?, ?, 'ativo', 1, ?)`
    ).run(numero, nome, agora, agora, jidEnvio);
  }

  db.prepare(
    `INSERT INTO mensagens (numero, remetente, texto, criado_em, atendente) VALUES (?, ?, ?, ?, ?)`
  ).run(numero, remetente, texto, agora, atendente);
}

/** Retorna o destino de WhatsApp validado (número real) desse lead, se já conhecido. */
function obterJidEnvio(numero) {
  const linha = db.prepare(`SELECT jid_envio FROM leads WHERE numero = ?`).get(numero);
  return linha?.jid_envio || null;
}

/** Guarda um valor de configuração simples (chave/valor), tipo "quem tá respondendo pelo WhatsApp agora". */
function definirConfiguracao(chave, valor) {
  db.prepare(
    `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`
  ).run(chave, valor);
}

/** Lê um valor de configuração salvo (ou null se nunca foi definido). */
function obterConfiguracao(chave) {
  const linha = db.prepare(`SELECT valor FROM configuracoes WHERE chave = ?`).get(chave);
  return linha?.valor ?? null;
}

/**
 * Gera o próximo número de protocolo em ordem sequencial (1, 2, 3...),
 * guardando o último valor usado na tabela configuracoes. Diferente de
 * pegar MAX(protocolo) nos leads, esse contador nunca "anda pra trás"
 * mesmo que um protocolo antigo seja apagado ou um lead removido.
 */
function proximoProtocolo() {
  const atual = parseInt(obterConfiguracao("ultimo_protocolo") || "0", 10) || 0;
  const proximo = atual + 1;
  definirConfiguracao("ultimo_protocolo", String(proximo));
  return String(proximo);
}

/**
 * Marca um lead como encaminhado para atendimento humano e gera um novo
 * número de protocolo sequencial (1, 2, 3...) pra essa transferência.
 * Retorna o protocolo gerado, pra quem chamou poder mostrar pro cliente
 * na hora (ex: "Nº do Protocolo: #4").
 */
function marcarEncaminhadoHumano(numero) {
  const protocolo = proximoProtocolo();
  db.prepare(
    `UPDATE leads SET status = 'encaminhado_humano', passou_por_humano = 1, protocolo = ? WHERE numero = ?`
  ).run(protocolo, numero);
  return protocolo;
}

/** Guarda o motivo (categorizado pela IA) pelo qual a conversa foi encaminhada. */
function definirMotivoTransferencia(numero, motivo) {
  db.prepare(`UPDATE leads SET motivo_transferencia = ? WHERE numero = ?`).run(motivo, numero);
}

/** Guarda o assunto geral da conversa (classificado pela IA em toda resposta). */
function definirAssunto(numero, assunto) {
  db.prepare(`UPDATE leads SET assunto = ? WHERE numero = ?`).run(assunto, numero);
}

/** Guarda a cidade do paciente, quando ele mesmo informa na conversa. */
function definirCidade(numero, cidade) {
  db.prepare(`UPDATE leads SET cidade = ? WHERE numero = ?`).run(cidade, numero);
}

/** Guarda o nome do paciente quando ele mesmo informa na conversa (prioridade sobre o nome do WhatsApp). */
function definirNomeInformado(numero, nome) {
  db.prepare(`UPDATE leads SET nome = ? WHERE numero = ?`).run(nome, numero);
}

/** Registra uma falha da IA ao tentar responder (erro técnico, não recusa de conteúdo). */
function registrarFalhaIA(numero) {
  db.prepare(`INSERT INTO falhas_ia (numero, criado_em) VALUES (?, ?)`).run(numero, new Date().toISOString());
}

/** Volta o status do lead para "ativo" (ex: humano encerrou e devolveu pra IA). */
function marcarAtivo(numero) {
  db.prepare(`UPDATE leads SET status = 'ativo' WHERE numero = ?`).run(numero);
}

/**
 * Marca a conversa como finalizada (atendimento encerrado) E devolve o
 * controle pra IA — "finalizar" significa "terminei, pode voltar ao
 * automático" se o cliente escrever de novo. Se quiser manter sob controle
 * humano mesmo depois de finalizada, use marcarEncaminhadoHumano à parte.
 */
function marcarFinalizada(numero) {
  db.prepare(`UPDATE leads SET finalizada = 1, status = 'ativo' WHERE numero = ?`).run(numero);
}

/** Reabre uma conversa que tinha sido finalizada. */
function reabrirConversa(numero) {
  db.prepare(`UPDATE leads SET finalizada = 0 WHERE numero = ?`).run(numero);
}

/** Marca que a pesquisa de satisfação foi mandada e está esperando resposta. */
function marcarPesquisaPendente(numero) {
  const agora = new Date().toISOString();
  db.prepare(
    `UPDATE leads SET pesquisa_pendente = 1, pesquisa_resposta = NULL, pesquisa_enviada_em = ? WHERE numero = ?`
  ).run(agora, numero);
}

/** Registra a resposta da pesquisa ('resolvido' ou 'nao_resolvido'). */
function registrarRespostaPesquisa(numero, resposta) {
  const agora = new Date().toISOString();
  db.prepare(
    `UPDATE leads SET pesquisa_pendente = 0, pesquisa_resposta = ?, pesquisa_respondida_em = ? WHERE numero = ?`
  ).run(resposta, agora, numero);
}

/** Estatísticas da pesquisa de satisfação, pra mostrar no painel gerencial. */
function obterEstatisticasPesquisa(desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);

  const resolvidos = intervalo
    ? db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE pesquisa_resposta = 'resolvido' AND pesquisa_respondida_em >= ? AND pesquisa_respondida_em < ?`
        )
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE pesquisa_resposta = 'resolvido'`).get().c;

  const naoResolvidos = intervalo
    ? db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE pesquisa_resposta = 'nao_resolvido' AND pesquisa_respondida_em >= ? AND pesquisa_respondida_em < ?`
        )
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE pesquisa_resposta = 'nao_resolvido'`).get().c;

  const totalRespondidas = resolvidos + naoResolvidos;
  const percentualResolvido =
    totalRespondidas > 0 ? Math.round((resolvidos / totalRespondidas) * 100) : null;

  return { totalRespondidas, resolvidos, naoResolvidos, percentualResolvido };
}

/** Retorna os dados atuais de um lead específico (ou undefined se não existir). */
function obterLead(numero) {
  return db.prepare(`SELECT * FROM leads WHERE numero = ?`).get(numero);
}

/**
 * Encontra um lead tanto pela chave "numero" (pode ser um "@lid") quanto
 * pelo "jid_envio" (o número de telefone real já validado) — útil quando
 * um comando digitado no WhatsApp passa um número de telefone, que pode não
 * bater exatamente com a chave original do lead.
 */
function obterLeadPorJidOuNumero(valor) {
  return db
    .prepare(`SELECT * FROM leads WHERE numero = ? OR jid_envio = ?`)
    .get(valor, valor);
}

/** Retorna a conversa em aberto (não finalizada) com mensagem mais recente. */
function obterConversaAbertaMaisRecente() {
  return db
    .prepare(`SELECT * FROM leads WHERE finalizada = 0 ORDER BY ultima_mensagem_em DESC LIMIT 1`)
    .get();
}

/** Lista todos os leads, mais recentes primeiro. */
function listarLeads() {
  return db
    .prepare(`SELECT * FROM leads ORDER BY ultima_mensagem_em DESC`)
    .all();
}

/** Retorna o histórico completo de mensagens de um número. */
function listarMensagens(numero) {
  return db
    .prepare(`SELECT * FROM mensagens WHERE numero = ? ORDER BY criado_em ASC`)
    .all(numero);
}

/**
 * Início e fim (exclusivo), em UTC, de um dia de calendário no fuso de
 * Caruaru (America/Recife, sempre UTC-3). Base de todo cálculo "por dia"
 * que precisa bater com o fuso local, já que os timestamps no banco são
 * salvos em UTC.
 */
function obterLimitesDiaRecife(dataLocalYYYYMMDD) {
  const inicioUTC = new Date(`${dataLocalYYYYMMDD}T00:00:00.000-03:00`);
  const fimUTC = new Date(inicioUTC.getTime() + 24 * 60 * 60 * 1000);
  return { inicioISO: inicioUTC.toISOString(), fimISO: fimUTC.toISOString() };
}

function obterLimitesHojeRecife() {
  const hojeLocal = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Recife" });
  return obterLimitesDiaRecife(hojeLocal);
}

/** Devolve a data local (Recife) do dia seguinte a `diaISO` ("YYYY-MM-DD"). */
function proximoDiaISO(diaISO) {
  const d = new Date(`${diaISO}T12:00:00Z`); // meio-dia UTC evita qualquer risco de virar o dia errado
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve uma lista de dias de calendário de Caruaru (Recife) — usado pelas
 * funções que bucketizam algo "por dia" (mensagens, evolução de conversas).
 * Com `desde`/`ate`, usa esse intervalo (ambos inclusivos); senão, usa os
 * últimos `dias` dias terminando hoje. Devolve também o intervalo UTC
 * correspondente pronto pra consulta no banco.
 */
function resolverIntervaloDiasRecife(dias, desde, ate) {
  let diaInicio, totalDias;

  if (desde && ate) {
    diaInicio = paraDiaLocalRecife(desde);
    const diaFim = paraDiaLocalRecife(ate);
    const diffMs = new Date(`${diaFim}T12:00:00Z`) - new Date(`${diaInicio}T12:00:00Z`);
    totalDias = Math.max(1, Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1);
  } else {
    const hojeLocal = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Recife" });
    const d = new Date(`${hojeLocal}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (dias - 1));
    diaInicio = d.toISOString().slice(0, 10);
    totalDias = dias;
  }

  const listaDias = [];
  let cursor = diaInicio;
  for (let i = 0; i < totalDias; i++) {
    listaDias.push(cursor);
    cursor = proximoDiaISO(cursor);
  }
  // "cursor" agora é o dia seguinte ao último dia do intervalo (limite exclusivo).

  const { inicioISO } = obterLimitesDiaRecife(diaInicio);
  const { fimISO } = obterLimitesDiaRecife(cursor);

  return { listaDias, inicioISO, fimISO };
}

/** Estatísticas gerais para os cards do painel. */
function obterEstatisticas() {
  const totalLeads = db.prepare(`SELECT COUNT(*) AS c FROM leads`).get().c;

  const { inicioISO, fimISO } = obterLimitesHojeRecife();

  // Conta leads que tiveram QUALQUER atividade hoje (mensagem nova ou
  // continuação de conversa antiga), não só quem mandou a primeira
  // mensagem hoje — senão o card fica zerado em dias sem lead novo,
  // mesmo com dezenas de mensagens indo e voltando.
  const leadsHoje = db
    .prepare(`SELECT COUNT(*) AS c FROM leads WHERE ultima_mensagem_em >= ? AND ultima_mensagem_em < ?`)
    .get(inicioISO, fimISO).c;

  const mensagensHoje = db
    .prepare(`SELECT COUNT(*) AS c FROM mensagens WHERE criado_em >= ? AND criado_em < ?`)
    .get(inicioISO, fimISO).c;

  const precisandoHumano = db
    .prepare(`SELECT COUNT(*) AS c FROM leads WHERE status = 'encaminhado_humano'`)
    .get().c;

  return { totalLeads, leadsHoje, mensagensHoje, precisandoHumano };
}

/**
 * Helper genérico: tempo médio (em segundos) entre uma mensagem do cliente
 * e a próxima resposta de um remetente específico ('ia' ou 'humano').
 * Ignora pares com mais de 5 minutos de intervalo (provavelmente reinícios
 * do bot ou demora real de alguém sair pra almoçar, não tempo de resposta
 * "de atendimento" de verdade).
 */
function calcularTempoMedioResposta(remetenteAlvo, desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);
  const todas = intervalo
    ? db
        .prepare(
          `SELECT numero, remetente, criado_em FROM mensagens
           WHERE criado_em >= ? AND criado_em < ? ORDER BY numero, criado_em ASC`
        )
        .all(intervalo.inicioISO, intervalo.fimISO)
    : db.prepare(`SELECT numero, remetente, criado_em FROM mensagens ORDER BY numero, criado_em ASC`).all();

  const porNumero = {};
  for (const m of todas) {
    if (!porNumero[m.numero]) porNumero[m.numero] = [];
    porNumero[m.numero].push(m);
  }

  let somaSegundos = 0;
  let contagem = 0;

  for (const numero in porNumero) {
    let aguardandoDesde = null;
    for (const m of porNumero[numero]) {
      if (m.remetente === "cliente") {
        aguardandoDesde = new Date(m.criado_em).getTime();
      } else if (m.remetente === remetenteAlvo && aguardandoDesde !== null) {
        const diffSegundos = (new Date(m.criado_em).getTime() - aguardandoDesde) / 1000;
        if (diffSegundos >= 0 && diffSegundos < 300) {
          somaSegundos += diffSegundos;
          contagem += 1;
        }
        aguardandoDesde = null;
      }
    }
  }

  return contagem > 0 ? Math.round(somaSegundos / contagem) : null;
}

/** Tempo médio de resposta da IA. */
function obterTempoMedioRespostaSegundos(desde = null, ate = null) {
  return calcularTempoMedioResposta("ia", desde, ate);
}

/** Tempo médio de resposta da recepção (mensagens manuais/painel). */
function obterTempoMedioRespostaHumanoSegundos(desde = null, ate = null) {
  return calcularTempoMedioResposta("humano", desde, ate);
}

/** Percentual de leads que precisaram ser encaminhados para atendimento humano. */
function obterTaxaEncaminhamentoHumano(desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);

  const total = intervalo
    ? db
        .prepare(`SELECT COUNT(*) AS c FROM leads WHERE primeira_mensagem_em >= ? AND primeira_mensagem_em < ?`)
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads`).get().c;
  if (total === 0) return 0;

  const humano = intervalo
    ? db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE passou_por_humano = 1 AND primeira_mensagem_em >= ? AND primeira_mensagem_em < ?`
        )
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE passou_por_humano = 1`).get().c;

  return Math.round((humano / total) * 100);
}

/**
 * Volume de mensagens por dia. Sem argumentos, usa os últimos 7 dias (padrão
 * do painel). Se `inicioCustom`/`fimCustom` forem passados (do seletor de
 * período), usa esse intervalo exato em vez do padrão.
 *
 * Agrupa pelos dias de calendário de Caruaru (America/Recife), não em UTC —
 * antes, uma mensagem enviada às 22h/23h local (já é outro dia em UTC) podia
 * cair no dia errado do gráfico, ou tudo ficar empilhado num dia só.
 */
function obterMensagensPorDia(dias = 7, inicioCustom = null, fimCustom = null) {
  const { listaDias, inicioISO, fimISO } = resolverIntervaloDiasRecife(dias, inicioCustom, fimCustom);

  const contagemPorDia = {};
  for (const dia of listaDias) contagemPorDia[dia] = 0;

  const linhas = db
    .prepare(`SELECT criado_em FROM mensagens WHERE criado_em >= ? AND criado_em < ?`)
    .all(inicioISO, fimISO);

  for (const linha of linhas) {
    const diaLocal = new Date(linha.criado_em).toLocaleDateString("sv-SE", { timeZone: "America/Recife" });
    if (diaLocal in contagemPorDia) contagemPorDia[diaLocal] += 1;
  }

  return Object.entries(contagemPorDia).map(([dia, total]) => ({ dia, total }));
}

// Palavras muito comuns em português (artigos, preposições, pronomes,
// saudações) que não ajudam a entender do que o cliente está falando —
// são descartadas da contagem de palavras mais usadas.
const STOPWORDS_PT = new Set([
  "a","o","os","as","um","uma","uns","umas","de","do","da","dos","das","em","no","na","nos","nas",
  "por","pra","para","com","sem","sob","sobre","entre","até","após","desde","perante",
  "e","ou","mas","porém","contudo","todavia","entretanto","logo","pois","portanto","que","se",
  "quando","como","porque","porquê","já","só","também","ainda","muito","mais","menos","bem","mal","tão","tanto",
  "eu","tu","ele","ela","nós","vós","eles","elas","me","te","lhe","vos","lhes",
  "meu","minha","meus","minhas","teu","tua","teus","tuas","seu","sua","seus","suas",
  "nosso","nossa","nossos","nossas","este","esta","estes","estas","esse","essa","esses","essas",
  "aquele","aquela","aqueles","aquelas","isto","isso","aquilo",
  "é","são","foi","foram","ser","estar","está","estão","estava","estavam","tem","têm","tinha","tinham","ter","há",
  "sou","somos","não","sim","oi","olá","ola","tudo","bem","obrigado","obrigada","favor",
  "vc","você","vcs","voces","pode","poderia","gostaria","queria","quero","preciso","boa","bom","tarde","noite","dia",
  "ao","aos","à","às","qual","quais","quem","onde","cada","todo","toda","todos","todas","num","numa","pelo","pela","pelos","pelas",
]);

/** Palavras mais usadas pelos clientes nas mensagens (pra entender do que mais perguntam). */
function obterPalavrasMaisUsadas(limite = 15, desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);
  const linhas = intervalo
    ? db
        .prepare(
          `SELECT texto FROM mensagens WHERE remetente = 'cliente' AND criado_em >= ? AND criado_em < ?`
        )
        .all(intervalo.inicioISO, intervalo.fimISO)
    : db.prepare(`SELECT texto FROM mensagens WHERE remetente = 'cliente'`).all();

  const contagem = {};
  for (const linha of linhas) {
    const palavras = (linha.texto.toLowerCase().match(/[a-zà-úçãõ]+/gi) || []);
    for (const palavra of palavras) {
      if (palavra.length < 3) continue;
      if (STOPWORDS_PT.has(palavra)) continue;
      contagem[palavra] = (contagem[palavra] || 0) + 1;
    }
  }

  return Object.entries(contagem)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limite)
    .map(([palavra, total]) => ({ palavra, total }));
}

/**
 * Funil de atendimento: quantas conversas começaram, quantas a IA resolveu
 * sozinha (sem precisar de humano) e quantas foram transferidas.
 * Obs: como o bot nunca agenda consulta, não existe uma etapa de
 * "consulta marcada" ou "pagamento" pra incluir aqui — só o que o sistema
 * realmente sabe: conversa iniciada, resolvida pela IA, ou transferida.
 */
function obterFunilAtendimento(desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);

  const conversasIniciadas = intervalo
    ? db
        .prepare(`SELECT COUNT(*) AS c FROM leads WHERE primeira_mensagem_em >= ? AND primeira_mensagem_em < ?`)
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads`).get().c;

  // Usa passou_por_humano (permanente) em vez de status = 'encaminhado_humano'
  // (que volta pra 'ativo' quando a conversa é finalizada) — senão uma
  // conversa que precisou de atendente e depois foi encerrada contava
  // errado aqui como "resolvida só pela IA". Mesmo motivo documentado na
  // migração da coluna passou_por_humano, lá em cima.
  const transferidasHumano = intervalo
    ? db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE passou_por_humano = 1 AND primeira_mensagem_em >= ? AND primeira_mensagem_em < ?`
        )
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE passou_por_humano = 1`).get().c;

  const resolvidasPelaIA = conversasIniciadas - transferidasHumano;

  return { conversasIniciadas, resolvidasPelaIA, transferidasHumano };
}

/**
 * Evolução diária: quantas conversas novas começaram em cada dia, e quantas
 * dessas (pelo status atual) ficaram só com a IA, sem precisar de humano.
 * É uma aproximação com base no status ATUAL do lead — não um retrato exato
 * do que aconteceu naquele dia específico, já que o status pode mudar depois.
 */
function obterEvolucaoConversas(dias = 7, desde = null, ate = null) {
  const { listaDias, inicioISO, fimISO } = resolverIntervaloDiasRecife(dias, desde, ate);

  const leads = db
    .prepare(`SELECT primeira_mensagem_em, passou_por_humano FROM leads WHERE primeira_mensagem_em >= ? AND primeira_mensagem_em < ?`)
    .all(inicioISO, fimISO);

  const porDia = {};
  for (const dia of listaDias) porDia[dia] = { total: 0, resolvidasIA: 0 };

  for (const lead of leads) {
    const diaLocal = new Date(lead.primeira_mensagem_em).toLocaleDateString("sv-SE", { timeZone: "America/Recife" });
    if (!(diaLocal in porDia)) continue;
    porDia[diaLocal].total += 1;
    // passou_por_humano (permanente) em vez de status — que volta pra
    // 'ativo' quando a conversa é finalizada e faria uma conversa
    // transferida aparecer aqui como "resolvida só pela IA".
    if (!lead.passou_por_humano) porDia[diaLocal].resolvidasIA += 1;
  }

  return Object.entries(porDia).map(([dia, valores]) => ({ dia, ...valores }));
}

/**
 * Percentual de conversas "abandonadas": leads que nunca foram finalizados
 * E não têm nenhuma mensagem nova há mais de `horasLimite` horas (padrão:
 * 24h). Isso é uma APROXIMAÇÃO — o WhatsApp não avisa quando alguém desiste
 * de esperar resposta, então usamos "ficou muito tempo parado, sem ser
 * finalizado" como sinal indireto de abandono.
 */
function obterTaxaAbandono(horasLimite = 24) {
  const total = db.prepare(`SELECT COUNT(*) AS c FROM leads`).get().c;
  if (total === 0) return 0;

  const limite = new Date();
  limite.setHours(limite.getHours() - horasLimite);

  const abandonadas = db
    .prepare(`SELECT COUNT(*) AS c FROM leads WHERE finalizada = 0 AND ultima_mensagem_em < ?`)
    .get(limite.toISOString()).c;

  return Math.round((abandonadas / total) * 100);
}

/**
 * Conjunto de indicadores operacionais do dia a dia, pra acompanhar a saúde
 * do atendimento (tempos de resposta, quanto está indo pra humano, quantos
 * estão parados sem finalizar, fila atual e taxa de resolução da IA).
 */
function obterIndicadoresOperacionais(desde = null, ate = null) {
  const funil = obterFunilAtendimento(desde, ate);
  const taxaResolucaoIA =
    funil.conversasIniciadas > 0
      ? Math.round((funil.resolvidasPelaIA / funil.conversasIniciadas) * 100)
      : null;

  const filaAtual = db
    .prepare(`SELECT COUNT(*) AS c FROM leads WHERE status = 'encaminhado_humano' AND finalizada = 0`)
    .get().c;

  return {
    tempoMedioIASegundos: obterTempoMedioRespostaSegundos(desde, ate),
    tempoMedioHumanoSegundos: obterTempoMedioRespostaHumanoSegundos(desde, ate),
    transferenciaIAHumanoPercentual: obterTaxaEncaminhamentoHumano(desde, ate),
    conversasAbandonadasPercentual: obterTaxaAbandono(24),
    filaAtual,
    taxaResolucaoIAPercentual: taxaResolucaoIA,
  };
}

/**
 * Mapa de calor: quantas mensagens de clientes chegam em cada combinação de
 * dia da semana x hora do dia, com base no histórico real. Retorna uma
 * matriz 7 (dias, começando na segunda) x 24 (horas).
 */
function obterHeatmapHorarios(desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);
  const linhas = intervalo
    ? db
        .prepare(
          `SELECT criado_em FROM mensagens WHERE remetente = 'cliente' AND criado_em >= ? AND criado_em < ?`
        )
        .all(intervalo.inicioISO, intervalo.fimISO)
    : db.prepare(`SELECT criado_em FROM mensagens WHERE remetente = 'cliente'`).all();

  const matriz = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const linha of linhas) {
    const d = new Date(linha.criado_em);
    const diaJS = d.getDay(); // 0 = domingo, 1 = segunda, ... 6 = sábado
    const diaIndex = (diaJS + 6) % 7; // remapeia pra 0 = segunda ... 6 = domingo
    const hora = d.getHours();
    matriz[diaIndex][hora] += 1;
  }

  return { matriz, totalMensagens: linhas.length };
}

/** Motivos de transferência pra humano, categorizados pela própria IA. */
function obterMotivosTransferencia(desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);
  return intervalo
    ? db
        .prepare(
          `SELECT motivo_transferencia AS motivo, COUNT(*) AS total
           FROM leads
           WHERE motivo_transferencia IS NOT NULL AND primeira_mensagem_em >= ? AND primeira_mensagem_em < ?
           GROUP BY motivo_transferencia
           ORDER BY total DESC`
        )
        .all(intervalo.inicioISO, intervalo.fimISO)
    : db
        .prepare(
          `SELECT motivo_transferencia AS motivo, COUNT(*) AS total
           FROM leads
           WHERE motivo_transferencia IS NOT NULL
           GROUP BY motivo_transferencia
           ORDER BY total DESC`
        )
        .all();
}

/**
 * Performance geral da IA: quanto ela consegue resolver sozinha, satisfação
 * das conversas concluídas (via pesquisa), e falhas técnicas reais (erros
 * ao tentar gerar resposta — não é "precisão de conteúdo", que não temos
 * como medir sem alguém avaliar cada resposta manualmente).
 */
function obterPerformanceIA(desde = null, ate = null) {
  const funil = obterFunilAtendimento(desde, ate);
  const taxaResolucaoIA =
    funil.conversasIniciadas > 0
      ? Math.round((funil.resolvidasPelaIA / funil.conversasIniciadas) * 100)
      : null;

  const intervalo = prepararIntervaloPeriodo(desde, ate);
  const totalMensagensCliente = intervalo
    ? db
        .prepare(`SELECT COUNT(*) AS c FROM mensagens WHERE remetente = 'cliente' AND criado_em >= ? AND criado_em < ?`)
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM mensagens WHERE remetente = 'cliente'`).get().c;
  const totalFalhas = intervalo
    ? db
        .prepare(`SELECT COUNT(*) AS c FROM falhas_ia WHERE criado_em >= ? AND criado_em < ?`)
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM falhas_ia`).get().c;
  const taxaFalhaPercentual =
    totalMensagensCliente > 0 ? Math.round((totalFalhas / totalMensagensCliente) * 1000) / 10 : 0;

  return {
    taxaResolucaoIAPercentual: taxaResolucaoIA,
    taxaTransferenciaPercentual: obterTaxaEncaminhamentoHumano(desde, ate),
    satisfacao: obterEstatisticasPesquisa(desde, ate),
    totalFalhas,
    taxaFalhaPercentual,
  };
}

/**
 * Performance por atendente: conversas atendidas, tempo médio de resposta e
 * taxa de resolução (via pesquisa de satisfação, atribuída ao último
 * atendente humano que participou daquela conversa).
 */
function obterPerformanceAtendentes(desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);
  const todasMsgs = intervalo
    ? db
        .prepare(
          `SELECT numero, remetente, atendente, criado_em FROM mensagens
           WHERE criado_em >= ? AND criado_em < ? ORDER BY numero, criado_em ASC`
        )
        .all(intervalo.inicioISO, intervalo.fimISO)
    : db.prepare(`SELECT numero, remetente, atendente, criado_em FROM mensagens ORDER BY numero, criado_em ASC`).all();

  const porNumero = {};
  for (const m of todasMsgs) {
    if (!porNumero[m.numero]) porNumero[m.numero] = [];
    porNumero[m.numero].push(m);
  }

  const porAtendente = {}; // nome -> { conversas: Set, somaSegundos, contagemTempo, primeiraAtividade, ultimaAtividade, janelaPorConversa }

  function garantirAtendente(nome) {
    if (!porAtendente[nome]) {
      porAtendente[nome] = {
        conversas: new Set(),
        somaSegundos: 0,
        contagemTempo: 0,
        primeiraAtividade: null,
        ultimaAtividade: null,
        // Primeira/última mensagem DESSE atendente em cada conversa (numero
        // -> {inicio, fim} em ms) — usado pra calcular só o tempo que ele
        // mesmo ficou ativo ali, não a conversa inteira.
        janelaPorConversa: {},
      };
    }
    return porAtendente[nome];
  }

  for (const numero in porNumero) {
    let aguardandoDesde = null;
    for (const m of porNumero[numero]) {
      if (m.remetente === "cliente") {
        aguardandoDesde = new Date(m.criado_em).getTime();
      } else if (m.remetente === "humano" && m.atendente) {
        const registro = garantirAtendente(m.atendente);
        registro.conversas.add(numero);

        // Rastreia a atividade desse atendente (primeira e última mensagem
        // que ele mandou, em qualquer conversa).
        if (!registro.primeiraAtividade || m.criado_em < registro.primeiraAtividade) {
          registro.primeiraAtividade = m.criado_em;
        }
        if (!registro.ultimaAtividade || m.criado_em > registro.ultimaAtividade) {
          registro.ultimaAtividade = m.criado_em;
        }

        // Janela de atividade desse atendente NESSA conversa específica.
        const tempoMs = new Date(m.criado_em).getTime();
        if (!registro.janelaPorConversa[numero]) {
          registro.janelaPorConversa[numero] = { inicio: tempoMs, fim: tempoMs };
        } else {
          if (tempoMs < registro.janelaPorConversa[numero].inicio) registro.janelaPorConversa[numero].inicio = tempoMs;
          if (tempoMs > registro.janelaPorConversa[numero].fim) registro.janelaPorConversa[numero].fim = tempoMs;
        }

        if (aguardandoDesde !== null) {
          const diff = (new Date(m.criado_em).getTime() - aguardandoDesde) / 1000;
          if (diff >= 0 && diff < 300) {
            registro.somaSegundos += diff;
            registro.contagemTempo += 1;
          }
          aguardandoDesde = null;
        }
      }
    }
  }

  // Taxa de resolução: atribuída ao último atendente humano que mexeu na
  // conversa antes da pesquisa de satisfação ser respondida.
  const leadsComPesquisa = intervalo
    ? db
        .prepare(
          `SELECT numero, pesquisa_resposta FROM leads
           WHERE pesquisa_resposta IS NOT NULL AND pesquisa_respondida_em >= ? AND pesquisa_respondida_em < ?`
        )
        .all(intervalo.inicioISO, intervalo.fimISO)
    : db.prepare(`SELECT numero, pesquisa_resposta FROM leads WHERE pesquisa_resposta IS NOT NULL`).all();

  const resolucaoPorAtendente = {}; // nome -> { resolvidos, naoResolvidos }
  for (const lead of leadsComPesquisa) {
    const mensagensDoLead = porNumero[lead.numero] || [];
    let ultimoAtendente = null;
    for (const m of mensagensDoLead) {
      if (m.remetente === "humano" && m.atendente) ultimoAtendente = m.atendente;
    }
    if (!ultimoAtendente) continue;

    if (!resolucaoPorAtendente[ultimoAtendente]) {
      resolucaoPorAtendente[ultimoAtendente] = { resolvidos: 0, naoResolvidos: 0 };
    }
    if (lead.pesquisa_resposta === "resolvido") resolucaoPorAtendente[ultimoAtendente].resolvidos += 1;
    else resolucaoPorAtendente[ultimoAtendente].naoResolvidos += 1;
  }

  return Object.entries(porAtendente)
    .map(([nome, dados]) => {
      const resolucao = resolucaoPorAtendente[nome];
      const totalAvaliacoes = resolucao ? resolucao.resolvidos + resolucao.naoResolvidos : 0;

      // Soma, pra cada conversa que esse atendente participou, só o tempo
      // entre a primeira e a última mensagem QUE ELE MESMO mandou ali —
      // não a conversa inteira (que pode incluir outros atendentes ou
      // horas de espera antes/depois da parte dele).
      let tempoAtendimentoTotalSegundos = 0;
      for (const numero of dados.conversas) {
        const janela = dados.janelaPorConversa[numero];
        if (janela) {
          tempoAtendimentoTotalSegundos += Math.max(0, Math.round((janela.fim - janela.inicio) / 1000));
        }
      }

      return {
        nome,
        conversas: dados.conversas.size,
        tempoMedioSegundos: dados.contagemTempo > 0 ? Math.round(dados.somaSegundos / dados.contagemTempo) : null,
        taxaResolucaoPercentual:
          totalAvaliacoes > 0 ? Math.round((resolucao.resolvidos / totalAvaliacoes) * 100) : null,
        totalAvaliacoes,
        inicio: dados.primeiraAtividade,
        termino: dados.ultimaAtividade,
        tempoAtendimentoTotalSegundos,
      };
    })
    .sort((a, b) => b.conversas - a.conversas);
}

/**
 * Lista as conversas mais recentes, formatadas pra tabela "Conversas
 * recentes" do painel: quem atendeu (nome do humano, ou "IA"), assunto
 * classificado, quando começou/terminou, duração e status visual.
 */
function obterConversasRecentes(limite = 15, desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);
  const leads = intervalo
    ? db
        .prepare(
          `SELECT numero, nome, assunto, status, finalizada, primeira_mensagem_em, ultima_mensagem_em
           FROM leads WHERE primeira_mensagem_em >= ? AND primeira_mensagem_em < ?
           ORDER BY ultima_mensagem_em DESC LIMIT ?`
        )
        .all(intervalo.inicioISO, intervalo.fimISO, limite)
    : db
        .prepare(
          `SELECT numero, nome, assunto, status, finalizada, primeira_mensagem_em, ultima_mensagem_em
           FROM leads ORDER BY ultima_mensagem_em DESC LIMIT ?`
        )
        .all(limite);

  return leads.map((lead) => {
    let atendenteOuIA = "IA";
    if (lead.status === "encaminhado_humano") {
      const ultimaMsgHumana = db
        .prepare(
          `SELECT atendente FROM mensagens
           WHERE numero = ? AND remetente = 'humano' AND atendente IS NOT NULL
           ORDER BY criado_em DESC LIMIT 1`
        )
        .get(lead.numero);
      atendenteOuIA = ultimaMsgHumana?.atendente || "Humano";
    }

    const statusVisual = lead.status === "encaminhado_humano" && !lead.finalizada ? "em_andamento" : "resolvido";

    // Duração: do início até a última mensagem registrada (se ainda estiver
    // em andamento, isso é "quanto tempo já durou até agora", não um
    // fechamento definitivo).
    const duracaoSegundos = Math.max(
      0,
      Math.round((new Date(lead.ultima_mensagem_em) - new Date(lead.primeira_mensagem_em)) / 1000)
    );

    return {
      numero: lead.numero,
      nome: lead.nome,
      assunto: lead.assunto,
      atendenteOuIA,
      inicio: lead.primeira_mensagem_em,
      termino: lead.ultima_mensagem_em,
      duracaoSegundos,
      statusVisual,
    };
  });
}

/**
 * Origem dos pacientes por cidade (só entre quem informou a cidade na
 * conversa). Agrupa as cidades menores em "Outras cidades", e mostra
 * separadamente quantos ainda não informaram — pra não esconder esse dado.
 */
function obterOrigemPacientes(limiteCidades = 4, desde = null, ate = null) {
  const intervalo = prepararIntervaloPeriodo(desde, ate);

  const totalLeads = intervalo
    ? db
        .prepare(`SELECT COUNT(*) AS c FROM leads WHERE primeira_mensagem_em >= ? AND primeira_mensagem_em < ?`)
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads`).get().c;
  if (totalLeads === 0) return [];

  const porCidade = intervalo
    ? db
        .prepare(
          `SELECT cidade, COUNT(*) AS total FROM leads
           WHERE cidade IS NOT NULL AND cidade != '' AND primeira_mensagem_em >= ? AND primeira_mensagem_em < ?
           GROUP BY cidade ORDER BY total DESC`
        )
        .all(intervalo.inicioISO, intervalo.fimISO)
    : db
        .prepare(
          `SELECT cidade, COUNT(*) AS total FROM leads
           WHERE cidade IS NOT NULL AND cidade != ''
           GROUP BY cidade ORDER BY total DESC`
        )
        .all();

  const semCidade = intervalo
    ? db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE (cidade IS NULL OR cidade = '') AND primeira_mensagem_em >= ? AND primeira_mensagem_em < ?`
        )
        .get(intervalo.inicioISO, intervalo.fimISO).c
    : db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE cidade IS NULL OR cidade = ''`).get().c;

  const principais = porCidade.slice(0, limiteCidades);
  const restante = porCidade.slice(limiteCidades).reduce((soma, c) => soma + c.total, 0);

  const resultado = principais.map((c) => ({
    cidade: c.cidade,
    total: c.total,
    percentual: Math.round((c.total / totalLeads) * 100),
  }));

  if (restante > 0) {
    resultado.push({
      cidade: "Outras cidades",
      total: restante,
      percentual: Math.round((restante / totalLeads) * 100),
    });
  }
  if (semCidade > 0) {
    resultado.push({
      cidade: "Não informado",
      total: semCidade,
      percentual: Math.round((semCidade / totalLeads) * 100),
    });
  }

  return resultado;
}

const ROTULOS_ASSUNTO_TEXTO = {
  AGENDAMENTO: "Agendamento",
  FINANCEIRO: "Financeiro",
  CONVENIO: "Convênio",
  EXAMES: "Exames",
  URGENCIA: "Urgência",
  GERAL: "Geral",
  OUTROS: "Outros",
};

/** Tempo médio de resposta de um remetente, só dentro de uma janela de datas. */
function calcularTempoMedioRespostaPeriodo(remetenteAlvo, desde, ate) {
  const todas = db
    .prepare(
      `SELECT numero, remetente, criado_em FROM mensagens
       WHERE criado_em >= ? AND criado_em < ?
       ORDER BY numero, criado_em ASC`
    )
    .all(desde.toISOString(), ate.toISOString());

  const porNumero = {};
  for (const m of todas) {
    if (!porNumero[m.numero]) porNumero[m.numero] = [];
    porNumero[m.numero].push(m);
  }

  let somaSegundos = 0;
  let contagem = 0;
  for (const numero in porNumero) {
    let aguardandoDesde = null;
    for (const m of porNumero[numero]) {
      if (m.remetente === "cliente") {
        aguardandoDesde = new Date(m.criado_em).getTime();
      } else if (m.remetente === remetenteAlvo && aguardandoDesde !== null) {
        const diff = (new Date(m.criado_em).getTime() - aguardandoDesde) / 1000;
        if (diff >= 0 && diff < 300) {
          somaSegundos += diff;
          contagem += 1;
        }
        aguardandoDesde = null;
      }
    }
  }
  return { mediaSegundos: contagem > 0 ? somaSegundos / contagem : null, contagem };
}

/**
 * Monta um resumo compacto e 100% real dos números do atendimento, pra
 * mandar pra IA analisar e escrever os insights em texto natural. Aqui só
 * junta FATOS (números calculados) — quem interpreta e opina é a IA, não
 * essa função.
 */
function montarResumoParaInsights() {
  const agora = new Date();
  const inicioSemanaAtual = new Date(agora);
  inicioSemanaAtual.setDate(agora.getDate() - 7);
  const inicioSemanaAnterior = new Date(agora);
  inicioSemanaAnterior.setDate(agora.getDate() - 14);

  const contarPorAssunto = (desde, ate) => {
    const linhas = db
      .prepare(
        `SELECT assunto, COUNT(*) AS total FROM leads
         WHERE assunto IS NOT NULL AND primeira_mensagem_em >= ? AND primeira_mensagem_em < ?
         GROUP BY assunto`
      )
      .all(desde.toISOString(), ate.toISOString());
    const mapa = {};
    for (const l of linhas) mapa[l.assunto] = l.total;
    return mapa;
  };

  const tempoHumanoSemanaAtual = calcularTempoMedioRespostaPeriodo("humano", inicioSemanaAtual, agora);
  const tempoHumanoSemanaAnterior = calcularTempoMedioRespostaPeriodo("humano", inicioSemanaAnterior, inicioSemanaAtual);

  const limite24h = new Date();
  limite24h.setHours(limite24h.getHours() - 24);
  const conversasParadas = db
    .prepare(`SELECT COUNT(*) AS c FROM leads WHERE finalizada = 0 AND ultima_mensagem_em < ?`)
    .get(limite24h.toISOString()).c;

  const mensagensCliente = db.prepare(`SELECT criado_em FROM mensagens WHERE remetente = 'cliente'`).all();
  const mensagensPorHora = new Array(24).fill(0);
  for (const m of mensagensCliente) mensagensPorHora[new Date(m.criado_em).getHours()] += 1;

  return {
    assuntosSemanaAtual: contarPorAssunto(inicioSemanaAtual, agora),
    assuntosSemanaAnterior: contarPorAssunto(inicioSemanaAnterior, inicioSemanaAtual),
    tempoMedioRespostaHumanaSegundos: {
      semanaAtual: tempoHumanoSemanaAtual.mediaSegundos,
      amostrasSemanaAtual: tempoHumanoSemanaAtual.contagem,
      semanaAnterior: tempoHumanoSemanaAnterior.mediaSegundos,
      amostrasSemanaAnterior: tempoHumanoSemanaAnterior.contagem,
    },
    tempoMedioRespostaIASegundos: obterTempoMedioRespostaSegundos(),
    conversasParadasMais24h: conversasParadas,
    funilAtendimento: obterFunilAtendimento(),
    motivosTransferencia: obterMotivosTransferencia(),
    mensagensClienteTotal: mensagensCliente.length,
    mensagensClientePorHoraDoDia: mensagensPorHora,
    performanceAtendentes: obterPerformanceAtendentes(),
    origemPacientesPorCidade: obterOrigemPacientes(6),
    pesquisaSatisfacao: obterEstatisticasPesquisa(),
    palavrasMaisUsadas: obterPalavrasMaisUsadas(10),
    totalLeads: db.prepare(`SELECT COUNT(*) AS c FROM leads`).get().c,
  };
}

/** Guarda os insights gerados pela IA (texto + quando foram gerados). */
function salvarInsightsGerados(textos) {
  definirConfiguracao("insights_ia_textos", JSON.stringify(textos));
  definirConfiguracao("insights_ia_gerado_em", new Date().toISOString());
}

/** Lê os últimos insights gerados pela IA (ou lista vazia se nunca gerou). */
function obterInsightsGerados() {
  const textosBrutos = obterConfiguracao("insights_ia_textos");
  const geradoEm = obterConfiguracao("insights_ia_gerado_em");
  let textos = [];
  try {
    textos = textosBrutos ? JSON.parse(textosBrutos) : [];
  } catch (e) {
    textos = [];
  }
  return { textos, geradoEm };
}

/**
 * Conjunto de métricas gerenciais, pra tomada de decisão no painel.
 * @param {Date|null} inicioPeriodo - início do período escolhido no seletor (opcional)
 * @param {Date|null} fimPeriodo - fim do período escolhido no seletor (opcional)
 */
function obterMetricasGerenciais(inicioPeriodo = null, fimPeriodo = null) {
  return {
    tempoMedioRespostaSegundos: obterTempoMedioRespostaSegundos(inicioPeriodo, fimPeriodo),
    taxaEncaminhamentoHumano: obterTaxaEncaminhamentoHumano(inicioPeriodo, fimPeriodo),
    mensagensPorDia: obterMensagensPorDia(7, inicioPeriodo, fimPeriodo),
    palavrasMaisUsadas: obterPalavrasMaisUsadas(15, inicioPeriodo, fimPeriodo),
    funilAtendimento: obterFunilAtendimento(inicioPeriodo, fimPeriodo),
    evolucaoConversas: obterEvolucaoConversas(7, inicioPeriodo, fimPeriodo),
    pesquisaSatisfacao: obterEstatisticasPesquisa(inicioPeriodo, fimPeriodo),
    indicadoresOperacionais: obterIndicadoresOperacionais(inicioPeriodo, fimPeriodo),
    motivosTransferencia: obterMotivosTransferencia(inicioPeriodo, fimPeriodo),
    performanceIA: obterPerformanceIA(inicioPeriodo, fimPeriodo),
    performanceAtendentes: obterPerformanceAtendentes(inicioPeriodo, fimPeriodo),
    conversasRecentes: obterConversasRecentes(15, inicioPeriodo, fimPeriodo),
    origemPacientes: obterOrigemPacientes(4, inicioPeriodo, fimPeriodo),
    insightsIA: obterInsightsGerados(),
    heatmapHorarios: obterHeatmapHorarios(inicioPeriodo, fimPeriodo),
  };
}

module.exports = {
  registrarMensagem,
  marcarEncaminhadoHumano,
  marcarAtivo,
  listarLeads,
  listarMensagens,
  obterEstatisticas,
  obterMetricasGerenciais,
  obterJidEnvio,
  marcarFinalizada,
  reabrirConversa,
  obterLead,
  marcarPesquisaPendente,
  registrarRespostaPesquisa,
  obterLeadPorJidOuNumero,
  obterConversaAbertaMaisRecente,
  definirConfiguracao,
  obterConfiguracao,
  definirMotivoTransferencia,
  definirAssunto,
  definirCidade,
  definirNomeInformado,
  registrarFalhaIA,
  montarResumoParaInsights,
  salvarInsightsGerados,
  obterInsightsGerados,
};

