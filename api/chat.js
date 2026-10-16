const { GoogleGenAI } = require('@google/genai');

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

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: message,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.7,
      },
    });

    res.status(200).json({ reply: response.text });
  } catch (error) {
    console.error('Erro na API Gemini:', error);
    res.status(500).json({ error: 'Erro: ' + (error.message || JSON.stringify(error)) });
  }
};
