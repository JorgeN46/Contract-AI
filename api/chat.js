const { GoogleGenAI } = require('@google/genai');

async function chamarGemini(ai, message, fileText, systemInstruction) {
  const tentarModelo = async (modelo) => {
    const response = await ai.models.generateContent({
      model: modelo,
      contents: message,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.4, 
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
    const { message, fileText, systemPrompt, mode } = req.body;

    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });

    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    
    let basePrompt = "";

    // MODO ANÁLISE (Rigoroso)
    const promptAnalise = `Você é o Contract AI, no MODO ANÁLISE. Seu objetivo é organizar, explicar, alertar e encaminhar.
Sempre que receber um documento, siga ESTRITAMENTE esta estrutura:
1. **Resumo Operacional**: Visão geral em 2 parágrafos.
2. **Limitações da Extração**: Avise o que está FALTANDO no documento.
3. **Pontos Positivos**: O que está bem redigido.
4. **Riscos e Pontos de Atenção**: Use tópicos. Para CADA risco, cite a Evidência (Ex: Fonte: Cláusula X / Trecho: "texto exato").
5. **Próximos Passos (Ação Direta)**: Dê direções práticas e sugira redações recomendadas.
6. **Aviso Legal**: Termine SEMPRE com: "Lembrete: Este relatório é operacional e não substitui a análise de um advogado habilitado."`;

    // MODO REFINAMENTO
    const promptRefinamento = `Você é o Contract AI, no MODO REFINAMENTO. Seu objetivo é ajudar o usuário a melhorar textos, deixando-os mais formais, claros ou naturais. Seja amigável, direto e foque na escrita.`;

    // MODO PADRÃO (Livre, mas com Roteamento Inteligente)
    const promptPadrao = `Você é o Contract AI, no MODO PADRÃO. Aja como um assistente conversacional e casual.
Responda de forma natural, amigável e descontraída.
IMPORTANTE: Se o usuário anexar um arquivo (PDF, imagem, etc.) ou pedir para analisar um contrato complexo, jurídico ou empresarial, VOCÊ DEVE MUDAR AUTOMATICAMENTE para o comportamento de "MODO ANÁLISE".
Quando isso acontecer, comece sua resposta EXATAMENTE com esta frase: "🤖 *Identifiquei um documento complexo. Ativei o Modo Análise automaticamente para você.*"
Depois da frase, siga a estrutura de 6 passos do Modo Análise (Resumo, Limitações, Pontos Positivos, Riscos com Evidências, Próximos Passos e Aviso Legal).`;

    if (mode === 'leitura') {
      basePrompt = promptAnalise;
    } else if (mode === 'refinamento') {
      basePrompt = promptRefinamento;
    } else {
      // Se for modo padrão, mas tiver um arquivo anexado, a IA decide trocar sozinha
      basePrompt = promptPadrao;
    }

    const finalInstruction = systemPrompt ? basePrompt + "\n\nPreferências do usuário: " + systemPrompt : basePrompt;

    let promptFinal = message;
    if (fileText && fileText.trim().length > 0) {
        promptFinal = "Texto do documento anexo:\n\n" + fileText.substring(0, 30000) + "\n\nInstrução do usuário: " + message;
    }

    const { texto, modeloUsado } = await chamarGemini(ai, promptFinal, fileText, finalInstruction);
    res.status(200).json({ reply: texto, modelo: modeloUsado });

  } catch (error) {
    console.error('Erro na API Gemini:', error);
    res.status(500).json({ error: 'Erro: ' + error.message });
  }
};
