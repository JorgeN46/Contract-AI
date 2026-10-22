async function chamarGemini(apiKey, message, systemInstruction, usePro) {
  // BANCO DE MODELOS
  const modeloPrincipal = usePro ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
  
  // Fallbacks
  const modelos = usePro 
    ? [modeloPrincipal, 'gemini-2.5-flash'] 
    : [modeloPrincipal, 'gemini-2.0-flash-lite'];

  let ultimoErro = null;

  for (const modelo of modelos) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        // Passamos a chave diretamente na URL (?key=), que é 100% aceito e evita o erro 401 de Bearer Token
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
        
        // Extraindo o texto da resposta do Google
        const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sem resposta gerada.";
        return { texto, modeloUsado: modelo };

      } catch (err) {
        ultimoErro = err;
        const msg = err.message || '';
        // Retry automático para erros de sobrecarga (503) ou limite temporário (429)
        if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('429')) {
          await new Promise(r => setTimeout(r, Math.pow(2, tentativa - 1) * 1000));
          continue;
        }
        break; // Se for erro 401/400, para de tentar este modelo
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

    // MODO ANÁLISE (Pro)
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

    // MODO PADRÃO (Flash)
    const promptPadrao = `Você é o Contract AI, no MODO PADRÃO. Aja como um assistente conversacional inteligente, prestativo e amigável.
Suas capacidades incluem:
1. Conversar normalmente sobre qualquer assunto.
2. Ajudar a criar trabalhos escolares, artigos, e-mails e textos gerais do zero.
3. LER E MELHORAR DOCUMENTOS ANEXADOS: Se o usuário enviar um PDF e pedir para editá-lo, leia e gere o texto aprimorado.
4. Se o usuário pedir para EXPORTAR ou BAIXAR um arquivo, responda: "A funcionalidade de exportação de arquivos estará disponível em breve! Por enquanto, aqui está o texto completo para você copiar e colar onde precisar."

ATENÇÃO: Se o usuário enviar um documento e pedir EXPLICITAMENTE uma análise de riscos ou revisão jurídica, mude para o comportamento do "Modo Análise" (comece avisando: "🤖 *Ativei o Modo Análise automaticamente para te ajudar com isso.*" e siga a estrutura de 6 passos).`;

    if (mode === 'leitura') {
      basePrompt = promptAnalise;
      usarModeloPro = true; // Ativa o 2.5 Pro
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
