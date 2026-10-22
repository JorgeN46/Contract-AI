const { GoogleGenAI } = require('@google/genai');

async function chamarGemini(ai, message, fileText, systemInstruction, usePro) {
  // BANCO DE MODELOS: 2.5 Pro para Análise, 2.5 Flash para o resto
  const modeloPrincipal = usePro ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
  
  const tentarModelo = async (modelo) => {
    const response = await ai.models.generateContent({
      model: modelo,
      contents: message,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.5, 
      },
    });
    return response.text;
  };

  // Fallbacks (Planos B caso o modelo principal falhe)
  const modelos = usePro 
    ? [modeloPrincipal, 'gemini-2.5-flash'] // Se o Pro falhar, tenta o Flash
    : [modeloPrincipal, 'gemini-2.0-flash-lite']; // Se o Flash falhar, tenta o Lite

  let ultimoErro = null;

  for (const modelo of modelos) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const texto = await tentarModelo(modelo);
        return { texto, modeloUsado: modelo };
      } catch (err) {
        ultimoErro = err;
        const msg = err.message || '';
        // Retry automático em caso de sobrecarga (503) ou limite de cota (429)
        if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('429')) {
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

    if (!message && (!fileText || fileText.trim() === '')) {
        return res.status(400).json({ error: 'Mensagem ou arquivo vazio' });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    
    let basePrompt = "";
    let usarModeloPro = false; 

    // MODO ANÁLISE (Rigoroso - Usa o Pro)
    const promptAnalise = `Você é o Contract AI, no MODO ANÁLISE. Seu objetivo é organizar, explicar, alertar e encaminhar.
Sempre que receber um documento, siga ESTRITAMENTE esta estrutura:
1. **Resumo Operacional**: Visão geral em 2 parágrafos.
2. **Limitações da Extração**: Avise o que está FALTANDO no documento.
3. **Pontos Positivos**: O que está bem redigido.
4. **Riscos e Pontos de Atenção**: Use tópicos. Para CADA risco, cite a Evidência (Ex: Fonte: Cláusula X / Trecho: "texto exato").
5. **Próximos Passos (Ação Direta)**: Dê direções práticas e sugira redações recomendadas.
6. **Aviso Legal**: Termine SEMPRE com: "Lembrete: Este relatório é operacional e não substitui a análise de um advogado habilitado."`;

    // MODO REFINAMENTO (Editor de textos gerais - Usa o Flash)
    const promptRefinamento = `Você é o Contract AI, no MODO REFINAMENTO. Sua especialidade é ser um Editor e Redator Profissional Sênior.
Seu objetivo é melhorar, criar ou editar textos, e-mails, artigos, trabalhos escolares e documentos em geral.
REGRAS DE OPERAÇÃO:
1. Se o usuário pedir para CRIAR um texto, gere um texto de alta qualidade, estruturado e pronto para uso.
2. Se o usuário enviar um texto ou arquivo e pedir para MELHORAR/EDITAR, reescreva o texto aplicando o tom desejado (formal, humano, acadêmico).
3. Se o usuário pedir para EXPORTAR, BAIXAR ou GERAR UM ARQUIVO (PDF, Word, Excel, etc.), você deve responder EXATAMENTE a seguinte frase: "A funcionalidade de exportação de arquivos estará disponível em breve! Por enquanto, aqui está o texto completo para você copiar e colar onde precisar." Em seguida, forneça o texto.
4. Ao entregar um resultado de edição, formate assim:
   - **Texto Refinado:** [Insira o texto completo reescrito, pronto para copiar]
   - **O que foi melhorado:** [Explique em 2 tópicos o porquê das mudanças]
5. NUNCA dê conselhos jurídicos neste modo. Foque 100% na qualidade da escrita e comunicação.`;

    // MODO PADRÃO (Assistente geral - Usa o Flash)
    const promptPadrao = `Você é o Contract AI, no MODO PADRÃO. Aja como um assistente conversacional inteligente, prestativo e amigável.
Você é uma ferramenta de produtividade versátil. Suas capacidades incluem:
1. Conversar normalmente sobre qualquer assunto.
2. Ajudar a criar trabalhos escolares, artigos, e-mails e textos gerais do zero.
3. LER E MELHORAR DOCUMENTOS ANEXADOS: Se o usuário enviar um PDF ou documento de texto (como um trabalho de escola, uma redação ou um e-mail) e pedir para editá-lo, corrigi-lo ou melhorá-lo, você deve ler o conteúdo e gerar o texto aprimorado na tela.
4. Se o usuário pedir para EXPORTAR, BAIXAR ou GERAR UM ARQUIVO (PDF, Word, Excel, etc.), você deve responder EXATAMENTE a seguinte frase: "A funcionalidade de exportação de arquivos estará disponível em breve! Por enquanto, aqui está o texto completo para você copiar e colar onde precisar." Em seguida, forneça o texto.

ATENÇÃO: Se o usuário enviar um documento (PDF/TXT) e pedir EXPLICITAMENTE uma análise de riscos, cláusulas contratuais ou revisão jurídica, mude para o comportamento do "Modo Análise" (comece avisando: "🤖 *Ativei o Modo Análise automaticamente para te ajudar com isso.*" e siga a estrutura de 6 passos).`;

    // Roteamento de qual Prompt usar
    if (mode === 'leitura') {
      basePrompt = promptAnalise;
      usarModeloPro = true; // <--- Ativa o Gemini 2.5 Pro
    } else if (mode === 'refinamento') {
      basePrompt = promptRefinamento;
    } else {
      basePrompt = promptPadrao;
    }

    const finalInstruction = systemPrompt ? basePrompt + "\n\nPreferências do usuário: " + systemPrompt : basePrompt;

    let promptFinal = message || "Por favor, analise o texto do arquivo em anexo.";
    if (fileText && fileText.trim().length > 0) {
        promptFinal = "Texto/Documento fornecido:\n\n" + fileText.substring(0, 30000) + "\n\nInstrução do usuário: " + (message || "Refine ou edite este texto.");
    }

    // Chama a IA passando a flag de qual modelo usar
    const { texto, modeloUsado } = await chamarGemini(ai, promptFinal, fileText, finalInstruction, usarModeloPro);
    
    res.status(200).json({ reply: texto, modelo: modeloUsado });

  } catch (error) {
    console.error('Erro na API Gemini:', error);
    res.status(500).json({ error: 'Erro: ' + error.message });
  }
};
