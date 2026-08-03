// insightsIA.js
// Gera insights em texto natural sobre o atendimento, usando a IA da
// Anthropic pra ANALISAR dados reais já calculados pelo sistema (db.js).
// A IA nunca recebe permissão pra inventar números — só interpreta e opina
// em cima do que realmente aconteceu.

const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `Você é um analista de dados que ajuda a gestão de uma clínica (PAD Saúde,
Caruaru-PE) a entender o desempenho do atendimento via WhatsApp (bot de IA + recepção humana).

Você vai receber um resumo em JSON com números REAIS do sistema (tempos de resposta, volume de
conversas, motivos de transferência, satisfação, horários de pico, etc.).

Sua tarefa: escrever de 4 a 7 insights curtos (uma frase cada, em português, tom profissional
mas direto — como um gestor experiente comentaria os números com a equipe).

Regras OBRIGATÓRIAS:
- Baseie-se SOMENTE nos números do JSON recebido. NUNCA invente ou estime um número que não
  esteja lá.
- Se um campo tiver poucos dados pra dizer algo com confiança (ex: amostra pequena, valor null,
  ou zero), simplesmente não comente sobre esse campo — não force um insight fraco.
- Pode e deve comparar números entre si (ex: semana atual vs anterior), calcular percentuais
  simples a partir do que foi dado, e fazer recomendações práticas baseadas em padrões reais
  (ex: se o volume é maior de manhã, sugerir reforçar a equipe nesse período).
- Não repita o mesmo dado em dois insights diferentes.
- Não enrole com introduções tipo "Aqui estão os insights"; vá direto às frases.
- Se os dados forem insuficientes pra qualquer insight minimamente confiável, retorne uma lista
  vazia — não force conteúdo.

Responda ESTRITAMENTE em formato JSON: uma lista de strings, sem nenhum texto antes ou depois,
sem markdown, sem crases. Exemplo do formato exato esperado:
["Primeira frase.", "Segunda frase.", "Terceira frase."]`;

/**
 * Pede pra IA analisar o resumo de dados e escrever os insights.
 * @param {object} resumoDados - objeto com os números reais (de db.montarResumoParaInsights())
 * @returns {Promise<string[]>} lista de frases de insight (pode vir vazia)
 */
async function gerarInsights(resumoDados) {
  const resposta = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Dados do atendimento:\n\n${JSON.stringify(resumoDados, null, 2)}`,
      },
    ],
  });

  const textoResposta = resposta.content
    .filter((bloco) => bloco.type === "text")
    .map((bloco) => bloco.text)
    .join("\n")
    .trim();

  try {
    // Remove eventuais crases de markdown (```json ... ```) caso a IA adicione por engano
    const textoLimpo = textoResposta.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const lista = JSON.parse(textoLimpo);
    if (!Array.isArray(lista)) return [];
    return lista.filter((item) => typeof item === "string" && item.trim().length > 0);
  } catch (erro) {
    console.error("Não consegui interpretar a resposta da IA como lista de insights:", erro);
    return [];
  }
}

module.exports = { gerarInsights };
