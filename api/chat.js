// REGISTRO DE MODELOS (MODEL TIERS)
const MODEL_TIERS = {
  padrao: {
    primary: 'gemini-3.8-flash',
    fallback: ['gemini-3.5-flash-lite']
  },
  refinamento: {
    primary: 'gemini-3.8-flash',
    fallback: ['gemini-3.5-flash-lite']
  },
  leitura: {
    primary: 'gemini-3.8-pro',
    fallback: ['gemini-3.8-flash']
  }
};

async function chamarModeloIA(apiKey, tierConfig, contentsArray, systemInstruction, res) {
  const modelosParaTentar = [tierConfig.primary, ...tierConfig.fallback];
  let ultimoErro = null;

  for (const modelo of modelosParaTentar) {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:streamGenerateContent?alt=sse&key=${apiKey}`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: contentsArray,
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
                if (text) res.write(text); 
              } catch (e) {}
            }
          }
        }
        res.end();
        return; 

      } catch (err) {
        ultimoErro = err;
        const msg = err.message || '';
        if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('429')) {
          await new Promise(r => setTimeout(r, Math.pow(2, tentativa - 1) * 1000));
          continue;
        }
        break; // Se for erro de modelo inválido, pula para o próximo fallback
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
    const { message, fileText, systemPrompt, mode, history } = req.body;
    if (!message && (!fileText || fileText.trim() === '')) return res.status(400).json({ error: 'Mensagem vazia' });

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Chave não configurada.' });

    let basePrompt = "";
    
    // PROMPT MESTRE DE ANÁLISE
    const promptAnalise = `Você é o Contract AI, no MODO ANÁLISE. Seu objetivo é organizar, explicar, alertar e encaminhar. Você lê qualquer tipo de documento profissional (Contratos, Laudos Técnicos/Médicos, Relatórios Contábeis, Materiais Didáticos) e extrai o valor operacional dele.
IMPORTANTE: Se o texto fornecido contiver MAIS DE UM documento (separados por marcadores como "--- arquivo.pdf ---"), você deve fazer uma análise comparativa, apontando diferenças, semelhanças e riscos entre eles.

Sempre que receber um documento, siga ESTRITAMENTE esta estrutura:
1. **Resumo Operacional**: Visão geral em 2 parágrafos, identificando o tipo de documento.
2. **Limitações da Extração**: Avise o que está FALTANDO ou ilegível no documento.
3. **Pontos Positivos/Conclusões**: O que está bem redigido ou quais são as conclusões principais.
4. **Riscos e Pontos de Atenção**: Use tópicos. Para CADA risco, cite a Evidência (Fonte: Cláusula X / Página Y / Trecho: "texto exato").
5. **Próximos Passos (Ação Direta)**: Dê direções práticas.
6. **Aviso Legal**: Termine SEMPRE com: "Lembrete: Este relatório é operacional e não substitui a análise de um profissional habilitado."`;

    // MODO REFINAMENTO
    const promptRefinamento = `Você é o Contract AI, no MODO REFINAMENTO. Sua especialidade é ser um Editor e Redator Profissional Sênior.
Seu objetivo é melhorar, criar ou editar textos, e-mails, artigos, trabalhos escolares e documentos em geral.
1. Se o usuário pedir para CRIAR um texto, gere um texto de alta qualidade.
2. Se o usuário enviar um texto e pedir para MELHORAR, reescreva aplicando o tom desejado.
3. Ao entregar um resultado, formate como: **Texto Refinado:** [texto] e **O que foi melhorado:** [explicação].
4. NUNCA dê conselhos jurídicos ou contábeis definitivos neste modo.`;

    // MODO PADRÃO
    const promptPadrao = `Você é o Contract AI, no MODO PADRÃO.
Aja como um assistente conversacional inteligente, descontraído e muito prestativo. 
Suas capacidades incluem: conversar sobre qualquer assunto, criar e-mails, trabalhos escolares, planos de aula e ler documentos anexados.
REGRA MATEMÁTICA: Se for usar fórmulas (LaTeX), NUNCA use '%'. Escreva '\\%'.
REGRA DE EXPORTAÇÃO: NUNCA diga "use a função imprimir" ou "não consigo gerar PDF". Apenas entregue o texto puro e formatado. O sistema já possui botões de download.
ATENÇÃO: Só mude para o comportamento do "Modo Análise" se o usuário pedir EXPLICITAMENTE para analisar riscos ou revisar juridicamente.`;
    
    let tierSelecionado = MODEL_TIERS.padrao;

    if (mode === 'leitura') {
      basePrompt = promptAnalise;
      tierSelecionado = MODEL_TIERS.leitura;
    } else if (mode === 'refinamento') {
      basePrompt = promptRefinamento;
      tierSelecionado = MODEL_TIERS.refinamento;
    } else {
      basePrompt = promptPadrao;
      tierSelecionado = MODEL_TIERS.padrao;
    }

    const finalInstruction = systemPrompt ? basePrompt + "\n\nPreferências do usuário: " + systemPrompt : basePrompt;

    let contentsArray = [];
    let historyToUse = history || [];

    if (historyToUse.length > 0 && historyToUse[historyToUse.length - 1].role === 'user') historyToUse.pop();

    historyToUse.forEach(msg => {
        contentsArray.push({
            role: msg.role === 'ai' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    });

    let promptFinal = message || "Por favor, analise o texto do arquivo em anexo.";
    if (fileText && fileText.trim().length > 0) {
        promptFinal = "O usuário enviou o(s) seguinte(s) documento(s):\n\n" + fileText.substring(0, 30000) + "\n\nInstrução do usuário: " + (message || "Analise e compare os documentos.");
    }
    
    contentsArray.push({ role: 'user', parts: [{ text: promptFinal }] });

    // Chama a função com o tier selecionado
    await chamarModeloIA(apiKey, tierSelecionado, contentsArray, finalInstruction, res);

  } catch (error) {
    console.error('Erro geral:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor', details: error.message });
    else res.end();
  }
};
