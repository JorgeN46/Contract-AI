const { GoogleGenAI } = require('@google/genai');

async function tentarModelo(ai, modelName, message, systemInstruction) {
  const response = await ai.models.generateContent({
    model: modelName,
    contents: message,
    config: {
      systemInstruction: systemInstruction,
      temperature: 0.7,
    },
  });
  return response.text;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, systemPrompt } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Mensagem vazia' });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

    const systemInstruction = systemPrompt || 'Você é o Contract AI, um assistente que organiza informações de contratos. Nunca dá conclusões jurídicas. Sempre usa linguagem operacional e destaca itens para revisão humana.';

    const modelos = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
    let ultimoErro = null;

    for (const modelo of modelos) {
      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
          const texto = await tentarModelo(ai, modelo, message, systemInstruction);
          return res.status(200).json({ reply: texto, modelo_usado: modelo });
        } catch (err) {
          ultimoErro = err;
          const msg = err.message || '';
          if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand')) {
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          break;
        }
      }
    }

    return res.status(500).json({
      error: 'Todos os modelos estavam ocupados. Tente novamente em alguns segundos.',
      detalhes: ultimoErro ? ultimoErro.message : 'sem detalhes'
    });

  } catch (error) {
    console.error('Erro na API Gemini:', error);
    res.status(500).json({ error: 'Erro: ' + (error.message || 'desconhecido') });
  }
};
