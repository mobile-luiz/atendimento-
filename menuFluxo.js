// menuFluxo.js
// Menu numérico (1-4) que aparece logo depois da saudação inicial da IA.
// Diferente do resto do atendimento (que é livre, gerado pela IA), esse
// fluxo é 100% determinístico — sempre manda o MESMO texto pra cada opção,
// pra nunca errar preço/condição de plano.
//
// Estado da conversa (em qual "tela" do menu a pessoa está) fica só em
// memória (Map), igual ao histórico de conversa da IA — se o bot reiniciar,
// a pessoa volta a cair no fluxo livre da IA na próxima mensagem, o que é
// aceitável pra esse tipo de menu.

const db = require("./db");

const estados = new Map(); // numero -> estado atual (string) | undefined

function obterEstado(numero) {
  return estados.get(numero) || null;
}

function definirEstado(numero, estado) {
  if (!estado) estados.delete(numero);
  else estados.set(numero, estado);
}

// ---------------------------------------------------------------------
// Motivos de transferência p/ humano — usam o mesmo nome da opção do
// menu que o cliente escolheu, pra aparecer certinho no painel de
// "Motivos de transferência" (em vez de um "GERAL" genérico).
// ---------------------------------------------------------------------

const MOTIVO_CLINICA = "Clínica PAD Saúde Caruaru";
const MOTIVO_CARTAO = "Cartão PAD Saúde+";
const MOTIVO_SERVICOS = "Nossos serviços";

// ---------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------

// Rodapé lembrando do comando de saída — aparece em toda tela do menu,
// pra pessoa saber a qualquer momento que pode encerrar sem precisar
// navegar até uma opção específica.
const RODAPE_SAIR = `\n\nDigite _Sair_ a qualquer momento se quiser encerrar seu atendimento.`;

const MENU_PRINCIPAL = `Como posso te ajudar? Escolha uma opção digitando o número:

1️⃣ Clínica PAD Saúde Caruaru
2️⃣ Cartão PAD Saúde+
3️⃣ Nossos serviços
4️⃣ Sobre a PAD Saúde
5️⃣ Falar com o atendente${RODAPE_SAIR}`;

const TEXTO_ATENDENTE_MODALIDADE = `🧑‍💼 *Falar com o atendente*

Com qual recepção você quer falar?

1️⃣ Recepção da Clínica PAD Saúde Caruaru
2️⃣ Recepção do Cartão PAD Saúde+

0️⃣ Voltar ao menu principal${RODAPE_SAIR}`;

const TEXTO_MODALIDADE_CARTAO = `💳 *Cartão PAD Saúde+*

Pra qual modalidade você quer ver os preços?

1️⃣ Pessoa Física — para você
2️⃣ Família — para sua família
3️⃣ Empresa — para sua equipe

0️⃣ Voltar ao menu principal${RODAPE_SAIR}`;

const TEXTO_FAMILIA_QUANTIDADE = `Quantas pessoas da família vão entrar no plano?

1️⃣ 3 a 4 vidas
2️⃣ 5 vidas ou mais

0️⃣ Voltar ao menu principal${RODAPE_SAIR}`;

const TEXTO_EMPRESA_TIPO = `Qual modalidade empresarial?

1️⃣ PJ Adesão
2️⃣ PJ Fatura

0️⃣ Voltar ao menu principal${RODAPE_SAIR}`;

const RODAPE_PLANOS = `\n\nDigite 1, 2 ou 3 pra solicitar o Inicial, Essencial ou Confort com um atendente, ou 0 pra voltar ao menu principal.${RODAPE_SAIR}`;

const TEXTO_PLANOS_PESSOA_FISICA = `👤 *Pessoa Física — Para você*
Contratação individual, valor mensal fixo para uma pessoa.

*Inicial — R$ 25,00/mês*
O primeiro passo pra cuidar da saúde com previsibilidade e economia, sem pesar no orçamento mensal.
• Acesso à rede PAD Saúde
• Descontos exclusivos em consultas e exames

*Essencial — R$ 59,90/mês* (inclui Médico na Tela)
Pra quem busca mais benefícios, atendimento online imediato e condições especiais na rede de parceiros.
• Tudo do Inicial
• Médico na Tela: 3 atendimentos online por mês
• Rede de Parceiros com descontos especiais
• Acesso à rede própria de clínicas PAD

*Confort — R$ 89,90/mês*
A solução mais completa, com cuidado presencial e atendimento no conforto de casa.
• Tudo do Essencial
• Rede própria de clínicas PAD com tabela diferenciada
• Médico em Casa: 1 atendimento por mês

_Valores definitivos. A utilização depende da ativação, da disponibilidade regional, da rede e das condições previstas no regulamento._${RODAPE_PLANOS}`;

const TEXTO_PLANOS_FAMILIA_3A4 = `👨‍👩‍👧 *Família — 3 a 4 vidas*
Condição familiar para grupos de três ou quatro pessoas, valor mensal calculado por vida.

*Inicial — R$ 22,00/vida/mês*
O primeiro passo pra cuidar da saúde com previsibilidade e economia, sem pesar no orçamento mensal.
• Acesso à rede PAD Saúde
• Descontos exclusivos em consultas e exames

*Essencial — R$ 45,90/vida/mês* (inclui Médico na Tela)
Pra quem busca mais benefícios, atendimento online imediato e condições especiais na rede de parceiros.
• Tudo do Inicial
• Médico na Tela: 3 atendimentos online por mês
• Rede de Parceiros com descontos especiais
• Acesso à rede própria de clínicas PAD

*Confort — R$ 69,90/vida/mês*
A solução mais completa, com cuidado presencial e atendimento no conforto de casa.
• Tudo do Essencial
• Rede própria de clínicas PAD com tabela diferenciada
• Médico em Casa: 1 atendimento por mês

_Valores definitivos, mensais e cobrados por vida — o total mensal é o valor multiplicado pelo número de pessoas incluídas. A utilização depende da ativação, da disponibilidade regional, da rede e das condições previstas no regulamento._${RODAPE_PLANOS}`;

const TEXTO_PLANOS_EMPRESA_PJ_ADESAO = `🏢 *Empresa — PJ Adesão*
Valores empresariais da modalidade PJ Adesão, cobrados mensalmente por vida.

*Inicial — R$ 22,00/vida/mês*
O primeiro passo pra cuidar da saúde com previsibilidade e economia, sem pesar no orçamento mensal.
• Acesso à rede PAD Saúde
• Descontos exclusivos em consultas e exames

*Essencial — R$ 49,90/vida/mês* (inclui Médico na Tela)
Pra quem busca mais benefícios, atendimento online imediato e condições especiais na rede de parceiros.
• Tudo do Inicial
• Médico na Tela: 3 atendimentos online por mês
• Rede de Parceiros com descontos especiais
• Acesso à rede própria de clínicas PAD

*Confort — R$ 69,90/vida/mês*
A solução mais completa, com cuidado presencial e atendimento no conforto de casa.
• Tudo do Essencial
• Rede própria de clínicas PAD com tabela diferenciada
• Médico em Casa: 1 atendimento por mês

_Valores definitivos, mensais e cobrados por vida — as condições operacionais são formalizadas na proposta comercial. A utilização depende da ativação, da disponibilidade regional, da rede e das condições previstas no regulamento._${RODAPE_PLANOS}`;

const TEXTO_NOSSA_HISTORIA = `📖 *Nossa história*

*Um propósito pernambucano*
A PAD Saúde nasceu para ampliar o acesso ao cuidado em saúde com uma jornada mais simples, próxima e compreensível.

*Um ecossistema em evolução*
Ao longo de mais de 10 anos, diferentes formas de atendimento passaram a fazer parte da mesma experiência de cuidado.

*Cuidado onde fizer sentido*
Hoje, conectamos assistência domiciliar, clínicas, telessaúde e benefícios para acompanhar diferentes necessidades.

Digite 1, 2, 3, 4 ou 5 pra ver outra opção do menu.${RODAPE_SAIR}`;

const AVISO_TRANSFERENCIA_CLINICA =
  "Vou te transferir para um atendente da nossa clínica em Caruaru. Só um instante! 😊";
const AVISO_TRANSFERENCIA_SERVICOS =
  "Vou te passar para um atendente da clínica pra falar sobre nossos serviços. Só um instante! 😊";
const AVISO_TRANSFERENCIA_5_VIDAS =
  "Pra grupos de 5 vidas ou mais, os valores são combinados direto com um atendente. Vou te transferir agora!";
const AVISO_TRANSFERENCIA_PJ_FATURA =
  "Pra modalidade PJ Fatura, um atendente vai te passar as condições certinhas. Vou te transferir agora!";
const AVISO_TRANSFERENCIA_RECEPCAO_CARTAO =
  "Vou te transferir para um atendente da recepção do Cartão PAD Saúde+. Só um instante! 😊";

const TEXTO_SAIR =
  "Tudo bem, atendimento encerrado por aqui! 👋 Se precisar de algo, é só me chamar de novo a qualquer momento.";

// ---------------------------------------------------------------------
// Envio / registro
// ---------------------------------------------------------------------

async function enviarTexto(sock, destino, numeroCliente, texto, ctx) {
  const enviada = await sock.sendMessage(destino, { text: texto });
  if (enviada?.key?.id && enviada?.message) {
    ctx.guardarParaRetry(enviada.key.id, enviada.message);
    ctx.marcarComoEnviadoPeloSistema(enviada.key.id);
  }
  db.registrarMensagem(numeroCliente, "ia", texto);
  return enviada;
}

async function transferirHumano(sock, destino, numeroCliente, textoAviso, motivo, ctx) {
  await enviarTexto(sock, destino, numeroCliente, textoAviso, ctx);
  db.marcarEncaminhadoHumano(numeroCliente);
  db.definirMotivoTransferencia(numeroCliente, motivo);
  db.definirAssunto(numeroCliente, motivo);
  definirEstado(numeroCliente, null);
}

/** Manda o menu principal e marca a conversa como "esperando escolha do menu". */
async function enviarMenuPrincipal(sock, destino, numeroCliente, ctx) {
  await enviarTexto(sock, destino, numeroCliente, MENU_PRINCIPAL, ctx);
  definirEstado(numeroCliente, "PRINCIPAL");
}

/**
 * Encerra o atendimento a pedido do próprio cliente (comando "Sair").
 * Manda a despedida, marca a conversa como finalizada (mesmo efeito do
 * "#finalizar" usado pela recepção) e limpa o estado do menu — se a
 * pessoa escrever de novo depois, a conversa reabre normalmente e ela
 * recebe o menu principal do zero.
 */
async function encerrarAtendimento(sock, destino, numeroCliente, ctx) {
  await enviarTexto(sock, destino, numeroCliente, TEXTO_SAIR, ctx);
  db.marcarFinalizada(numeroCliente);
  definirEstado(numeroCliente, null);
}

/**
 * Tenta tratar a mensagem do cliente como resposta a um menu em andamento.
 * Retorna true se tratou (e portanto a IA NÃO deve responder essa mensagem),
 * ou false se não havia menu ativo / a resposta não bateu com nenhuma opção
 * válida (nesse caso cai pro fluxo normal da IA, sem travar a pessoa).
 */
async function tratarFluxoMenu(sock, destino, numeroCliente, textoRecebido, ctx) {
  const opcao = textoRecebido.trim();

  // "Sair" funciona a qualquer momento — dentro de qualquer tela do menu
  // numérico, já que essa função roda pra toda mensagem do cliente antes
  // do fluxo livre da IA. Checado antes do estado pra não depender de
  // estar numa etapa específica do menu.
  if (/^sair$/i.test(opcao)) {
    await encerrarAtendimento(sock, destino, numeroCliente, ctx);
    return true;
  }

  const estadoAtual = obterEstado(numeroCliente);
  if (!estadoAtual) return false;

  if (estadoAtual === "PRINCIPAL") {
    if (opcao === "1") {
      await transferirHumano(sock, destino, numeroCliente, AVISO_TRANSFERENCIA_CLINICA, MOTIVO_CLINICA, ctx);
      return true;
    }
    if (opcao === "2") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_MODALIDADE_CARTAO, ctx);
      definirEstado(numeroCliente, "CARTAO_MODALIDADE");
      return true;
    }
    if (opcao === "3") {
      await transferirHumano(sock, destino, numeroCliente, AVISO_TRANSFERENCIA_SERVICOS, MOTIVO_SERVICOS, ctx);
      return true;
    }
    if (opcao === "4") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_NOSSA_HISTORIA, ctx);
      // permanece no menu principal — a pessoa pode digitar outra opção
      return true;
    }
    if (opcao === "5") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_ATENDENTE_MODALIDADE, ctx);
      definirEstado(numeroCliente, "ATENDENTE_MODALIDADE");
      return true;
    }
    return false;
  }

  if (estadoAtual === "ATENDENTE_MODALIDADE") {
    if (opcao === "1") {
      await transferirHumano(sock, destino, numeroCliente, AVISO_TRANSFERENCIA_CLINICA, MOTIVO_CLINICA, ctx);
      return true;
    }
    if (opcao === "2") {
      await transferirHumano(sock, destino, numeroCliente, AVISO_TRANSFERENCIA_RECEPCAO_CARTAO, MOTIVO_CARTAO, ctx);
      return true;
    }
    if (opcao === "0") {
      await enviarMenuPrincipal(sock, destino, numeroCliente, ctx);
      return true;
    }
    return false;
  }

  if (estadoAtual === "CARTAO_MODALIDADE") {
    if (opcao === "1") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_PLANOS_PESSOA_FISICA, ctx);
      definirEstado(numeroCliente, "CARTAO_PLANOS");
      return true;
    }
    if (opcao === "2") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_FAMILIA_QUANTIDADE, ctx);
      definirEstado(numeroCliente, "CARTAO_FAMILIA_QUANTIDADE");
      return true;
    }
    if (opcao === "3") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_EMPRESA_TIPO, ctx);
      definirEstado(numeroCliente, "CARTAO_EMPRESA_TIPO");
      return true;
    }
    if (opcao === "0") {
      await enviarMenuPrincipal(sock, destino, numeroCliente, ctx);
      return true;
    }
    return false;
  }

  if (estadoAtual === "CARTAO_FAMILIA_QUANTIDADE") {
    if (opcao === "1") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_PLANOS_FAMILIA_3A4, ctx);
      definirEstado(numeroCliente, "CARTAO_PLANOS");
      return true;
    }
    if (opcao === "2") {
      await transferirHumano(sock, destino, numeroCliente, AVISO_TRANSFERENCIA_5_VIDAS, MOTIVO_CARTAO, ctx);
      return true;
    }
    if (opcao === "0") {
      await enviarMenuPrincipal(sock, destino, numeroCliente, ctx);
      return true;
    }
    return false;
  }

  if (estadoAtual === "CARTAO_EMPRESA_TIPO") {
    if (opcao === "1") {
      await enviarTexto(sock, destino, numeroCliente, TEXTO_PLANOS_EMPRESA_PJ_ADESAO, ctx);
      definirEstado(numeroCliente, "CARTAO_PLANOS");
      return true;
    }
    if (opcao === "2") {
      await transferirHumano(sock, destino, numeroCliente, AVISO_TRANSFERENCIA_PJ_FATURA, MOTIVO_CARTAO, ctx);
      return true;
    }
    if (opcao === "0") {
      await enviarMenuPrincipal(sock, destino, numeroCliente, ctx);
      return true;
    }
    return false;
  }

  if (estadoAtual === "CARTAO_PLANOS") {
    const nomesPlano = { "1": "Inicial", "2": "Essencial", "3": "Confort" };
    if (nomesPlano[opcao]) {
      await transferirHumano(
        sock,
        destino,
        numeroCliente,
        `Perfeito! Vou te transferir para um atendente finalizar a solicitação do ${nomesPlano[opcao]}. Só um instante! 😊`,
        MOTIVO_CARTAO,
        ctx
      );
      return true;
    }
    if (opcao === "0") {
      await enviarMenuPrincipal(sock, destino, numeroCliente, ctx);
      return true;
    }
    return false;
  }

  return false;
}

module.exports = { enviarMenuPrincipal, tratarFluxoMenu, obterEstado, definirEstado };

