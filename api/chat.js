async function chamarGeminiStream(apiKey, message, systemInstruction, usePro, res) {
  const modeloPrincipal = usePro ? 'gemini-3.8-pro' : 'gemini-3.8-flash';
  const modelos = usePro 
    ? [modeloPrincipal, 'gemini-3.8-flash'] 
    : [modeloPrincipal, 'gemini-3.5-flash-lite']; 

  let ultimoErro = null;

  for (const modelo of modelos) {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:streamGenerateContent?alt=sse&key=${apiKey}`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: 'user', parts: [{ text: message }] }],
            generationConfig: { temperature: 0.5 }
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(JSON.stringify(errData));
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.replace('data: ', '').trim();
              if (dataStr === '[DONE]') continue;
              try {
                const data = JSON.parse(dataStr);
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  res.write(text);
                }
              } catch (e) {}
            }
          }
        }
        res.end();
        return; // Sucesso, sai da função

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
  
  if (!res.headersSent) {
    res.status(500).json({ error: 'Todos os modelos falharam', details: ultimoErro.message });
  } else {
    res.end();
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, fileText, systemPrompt, mode } = req.body;
    if (!message && (!fileText || fileText.trim() === '')) return res.status(400).json({ error: 'Mensagem vazia' });

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Chave não configurada.' });

    let basePrompt = "";
    let usarModeloPro = false; 

    const promptAnalise = `Você é o Contract AI, no MODO ANÁLISE. Seu objetivo é organizar, explicar, alertar e encaminhar. Você lê qualquer tipo de documento profissional (Contratos, Laudos Técnicos/Médicos, Relatórios Contábeis, Materiais Didáticos) e extrai o valor operacional dele.

Sempre que receber um documento, siga ESTRITAMENTE esta estrutura:
1. **Resumo Operacional**: Visão geral em 2 parágrafos, identificando o tipo de documento.
2. **Limitações da Extração**: Avise o que está FALTANDO ou ilegível no documento.
3. **Pontos Positivos/Conclusões**: O que está bem redigido ou quais são as conclusões principais (útil para laudos e contabilidade).
4. **Riscos e Pontos de Atenção**: Use tópicos. Para CADA risco/inconsistência, cite a Evidência (Ex: Fonte: Cláusula X / Página Y / Trecho: "texto exato"). Em contabilidade, aponte divergências. Em laudos, aponte falta de fundamentação.
5. **Próximos Passos (Ação Direta)**: Dê direções práticas. Se for um professor pedindo ajuda com material didático, sugira melhorias na estrutura da aula. Se for contrato, sugira redações. Se for contábil, sugira ajustes.
6. **Aviso Legal**: Termine SEMPRE com: "Lembrete: Este relatório é operacional e não substitui a análise de um profissional habilitado (advogado, contador, médico, etc)."`;

    const promptRefinamento = `Você é o Contract AI, no MODO REFINAMENTO. Sua especialidade é ser um Editor e Redator Profissional Sênior.
Seu objetivo é melhorar, criar ou editar textos, e-mails, artigos, trabalhos escolares e documentos em geral.
REGRAS DE OPERAÇÃO:
1. Se o usuário pedir para CRIAR um texto, gere um texto de alta qualidade, estruturado e pronto para uso.
2. Se o usuário enviar um texto ou arquivo e pedir para MELHORAR/EDITAR, reescreva o texto aplicando o tom desejado.
3. Se o usuário pedir para EXPORTAR ou BAIXAR um arquivo, responda: "A funcionalidade de exportação estará disponível em breve! Por enquanto, aqui está o texto completo para você copiar e colar onde precisar."
4. Ao entregar um resultado de edição, formate assim:
   - **Texto Refinado:** [Insira o texto completo]
   - **O que foi melhorado:** [Explique em 2 tópicos]
5. NUNCA dê conselhos jurídicos ou contábeis definitivos neste modo. Foque 100% na qualidade da escrita.`;

    const promptPadrao = `Você é o Contract AI, no MODO PADRÃO.
Aja como um assistente conversacional inteligente, descontraído e muito prestativo. 
Fale como um colega de trabalho moderno e confiável: seja direto, use um tom amigável (mas sem exagerar nos emojis) e demonstre empatia.
Suas capacidades incluem:
1. Conversar naturalmente sobre qualquer assunto (tecnologia, negócios, dúvidas do dia a dia).
2. Ajudar a criar e-mails, trabalhos escolares, artigos, roteiros e planos de aula.
3. LER E MELHORAR DOCUMENTOS ANEXADOS: Se o usuário enviar um PDF e pedir para editar, leia e entregue o texto aprimorado.
REGRA MATEMÁTICA: Se for usar fórmulas matemáticas (LaTeX), NUNCA use o caractere '%' diretamente. Sempre escreva '\\%'.

Se o usuário pedir para EXPORTAR ou BAIXAR um arquivo, responda: "A exportação estará disponível em breve! Por enquanto, aqui está o texto completo para você copiar."
ATENÇÃO: Só mude para o comportamento do "Modo Análise" se o usuário pedir EXPLICITAMENTE para analisar riscos, revisar juridicamente ou estruturar um documento técnico.`;

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

    // AQUI É ONDE A MÁGICA ACONTECE (A parte que faltava!)
    await chamarGeminiStream(apiKey, promptFinal, finalInstruction, usarModeloPro, res);

  } catch (error) {
    console.error('Erro geral:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro no servidor', details: error.message });
    } else {
      res.end();
    }
  }
};
