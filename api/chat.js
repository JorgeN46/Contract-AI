const { GoogleGenAI } = require('@google/genai');

async function chamarGemini(ai, message, fileText, systemInstruction) {
  const tentarModelo = async (modelo) => {
    const response = await ai.models.generateContent({
      model: modelo,
      contents: message,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.7,
      },
    });
    return response.text;
  };

  const modelos = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
  let ultimoErro = null;

  for (const modelo of modelos) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const texto = await tentarModelo(modelo);
        return { texto, modeloUsado: modelo };
      } catch (err) {
        ultimoErro = err;
        const msg = err.message || '';
        if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand')) {
          await new Promise(r => setTimeout(r, Math.pow(2, tentativa - 1) * 1000));
          continue;
        }
        break;
      }
    }
  }
  throw ultimoErro;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, fileText, systemPrompt } = req.body;

    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });

    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const systemInstruction = systemPrompt || 'Você é o Contract AI...';

    let promptFinal = message;
    if (fileText && fileText.trim().length > 0) {
        promptFinal = "Aqui está o texto do contrato para análise:\n\n" + fileText.substring(0, 30000) + "\n\nInstrução do usuário: " + message;
    }

    const { texto, modeloUsado } = await chamarGemini(ai, promptFinal, fileText, systemInstruction);
    res.status(200).json({ reply: texto, modelo: modeloUsado });

  } catch (error) {
    console.error('Erro na API Gemini:', error);
    res.status(500).json({ error: 'Erro: ' + error.message });
  }
};
