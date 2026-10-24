async function chamarGemini(apiKey, message, systemInstruction, usePro) {
  // BANCO DE MODELOS ATUALIZADO
  const modeloPrincipal = usePro ? 'gemini-3.8-pro' : 'gemini-3.8-flash';
  
  const modelos = usePro 
    ? [modeloPrincipal, 'gemini-3.8-flash'] 
    : [modeloPrincipal, 'gemini-3.5-flash-lite']; 

  let ultimoErro = null;

  for (const modelo of modelos) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
        
        const body = {
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [{
            role: 'user',
            parts: [{ text: message }]
          }],
          generationConfig: {
            temperature: 0.5
          }
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(JSON.stringify(errData));
        }

        const data = await response.json();
        
        const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sem resposta gerada.";
        return { texto, modeloUsado: modelo };

      } catch (err) {
        ultimoErro = err;
        const msg = err.message || '';
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

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Chave de API não configurada na Vercel.' });

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

    // MODO REFINAMENTO (Flash)
    const promptRefinamento = `Você é o Contract AI, no MODO REFINAMENTO. Sua especialidade é ser um Editor e Redator Profissional Sênior.
Seu objetivo é melhorar, criar ou editar textos, e-mails, artigos, trabalhos escolares e documentos em geral.
REGRAS DE OPERAÇÃO:
1. Se o usuário pedir para CRIAR um texto, gere um texto de alta qualidade, estruturado e pronto para uso.
2. Se o usuário enviar um texto ou arquivo e pedir para MELHORAR/EDITAR, reescreva o texto aplicando o tom desejado.
3. Se o usuário pedir para EXPORTAR ou BAIXAR um arquivo, responda: "A funcionalidade de exportação de arquivos estará disponível em breve! Por enquanto, aqui está o texto completo para você copiar e colar onde precisar." Em seguida, forneça o texto.
4. Ao entregar um resultado de edição, formate assim:
   - **Texto Refinado:** [Insira o texto completo]
   - **O que foi melhorado:** [Explique em 2 tópicos]
5. NUNCA dê conselhos jurídicos neste modo.`;

    // MODO PADRÃO (Flash - Com a personalidade nova)
    const promptPadrao = `Você é o Contract AI, no MODO PADRÃO.
Aja como um assistente conversacional inteligente, descontraído e muito prestativo. 
Fale como um colega de trabalho moderno e confiável: seja direto, use um tom amigável (mas sem exagerar nos emojis) e demonstre empatia.
Suas capacidades incluem:
1. Conversar naturalmente sobre qualquer assunto (tecnologia, negócios, dúvidas do dia a dia).
2. Ajudar a criar e-mails, trabalhos escolares, artigos e roteiros.
3. LER E MELHORAR DOCUMENTOS ANEXADOS: Se o usuário enviar um PDF e pedir para editar, leia e entregue o texto aprimorado.

Se o usuário pedir para EXPORTAR ou BAIXAR um arquivo, responda: "A exportação estará disponível em breve! Por enquanto, aqui está o texto completo para você copiar."
ATENÇÃO: Só mude para o comportamento do "Modo Análise" se o usuário pedir EXPLICITAMENTE para analisar riscos ou revisar juridicamente.
REGRA MATEMÁTICA: Se for usar fórmulas matemáticas (LaTeX), NUNCA use o caractere '%' diretamente. Sempre escreva '\\%' (com a barra invertida).`;

    if (mode === 'leitura') {
      basePrompt = promptAnalise;
      usarModeloPro = true; 
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

    const { texto, modeloUsado } = await chamarGemini(apiKey, promptFinal, finalInstruction, usarModeloPro);
    
    res.status(200).json({ reply: texto, model: modeloUsado });

  } catch (error) {
    console.error('Erro na API Gemini:', error.message);
    res.status(500).json({ error: 'Erro interno no servidor', details: error.message });
  }
};
