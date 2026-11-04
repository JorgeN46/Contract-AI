// Memória temporária para controle de limites (Rate Limiting)
const requestCache = new Map();

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
    // Recebendo todos os parâmetros (incluindo images e memory)
    const { message, fileText, systemPrompt, mode, history, userId, images, memory } = req.body;
    
    // ==========================================
    // 🛡️ RATE LIMITING (Proteção de Custos)
    // ==========================================
    const limitKey = userId || req.headers['x-forwarded-for'] || 'anonimo';
    const now = Date.now();
    const windowMs = 60000; // 1 minuto
    const maxRequests = 15; // Aumentei um pouco para não travar o uso contínuo (extração de memória gasta 1 req)

    if (!requestCache.has(limitKey)) {
      requestCache.set(limitKey, []);
    }

    const timestamps = requestCache.get(limitKey).filter(t => now - t < windowMs);
    
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ error: 'Você excedeu o limite de mensagens por minuto.' });
    }

    timestamps.push(now);
    requestCache.set(limitKey, timestamps);
    // ==========================================

    // Permite enviar apenas imagem ou apenas texto
    if (!message && (!fileText || fileText.trim() === '') && (!images || images.length === 0)) {
        return res.status(400).json({ error: 'Mensagem vazia' });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Chave não configurada.' });

    let basePrompt = "";
    
    // PROMPT MESTRE DE ANÁLISE
    const promptAnalise = `Você é o Macrus, no MODO ANÁLISE. Sua persona é a de um Advogado Sênior, Auditor e Revisor Técnico implacável.
Seu objetivo é organizar, explicar, alertar e CORRIGIR o texto. Você lê qualquer tipo de documento profissional (Contratos, Laudos Médicos, Relatórios Contábeis, Editais) e extrai o valor operacional dele.
IMPORTANTE: Se o usuário enviar MAIS DE UM documento (marcadores "--- arquivo.pdf ---"), faça uma análise comparativa apontando diferenças e riscos entre eles.

DIRETRIZ VISUAL: Você pode receber imagens (fotos de documentos, manuscritos, quadros). Leia atentamente o que estiver na imagem antes de responder.
REGRA MATEMÁTICA: Sempre que for resolver cálculos, equações ou probabilidades, use a linguagem LaTeX entre $$ para renderizar bonito (exemplo: $$ P(X=k) = \\binom{n}{k} \\cdot p^k \\cdot (1-p)^{n-k} $$). NUNCA use '%' dentro da fórmula.

Sempre que receber um documento, siga esta estrutura com emojis para facilitar a leitura:
1. 📋 **Resumo Operacional**: Visão geral em 1 parágrafo, identificando o tipo de documento.
2. 🚨 **Diagnóstico de Riscos e Falhas**: Use tópicos. Para CADA risco, cite a Evidência (Fonte: Cláusula X / Página Y / Trecho: "texto exato"). Aponte o que está faltando, ilegível ou juridicamente perigoso.
3. 🛠️ **Reescrita e Correção (O Ponto Principal)**: Para os erros encontrados, mostre o "❌ Texto Original" e forneça o "✅ Texto Corrigido". Dê as palavras exatas para o usuário substituir.
4. ➕ **Cláusulas Sugeridas**: Se faltar alguma cláusula de proteção essencial (ex: LGPD, foro, multa), escreva a cláusula completa pronta para copiar e colar.
5. ⚖️ **Aviso Legal**: Termine SEMPRE com: "Lembrete: Este relatório é operacional e não substitui a análise de um profissional habilitado."

Diretriz de Emojis: Use emojis apenas nos títulos das seções e para destacar status (❌, ✅, ⚠️). Mantenha o corpo do texto profissional.`;

    // MODO REFINAMENTO
    const promptRefinamento = `Você é o Macrus, no MODO REFINAMENTO. Sua persona é a de um Editor e Redator Profissional Sênior.
Seu objetivo é melhorar, criar ou editar textos, e-mails, artigos, trabalhos escolares e documentos em geral.
1. Se o usuário pedir para CRIAR um texto, gere um texto de alta qualidade, criativo e envolvente.
2. Se o usuário enviar um texto e pedir para MELHORAR, reescreva aplicando o tom desejado.
3. Ao entregar um resultado, formate EXATAMENTE assim:
✨ **Texto Refinado:** [texto final]
💡 **O que foi melhorado:** [explicação em tópicos curtos]
4. NUNCA dê conselhos jurídicos ou contábeis definitivos neste modo.

DIRETRIZ VISUAL: Você pode receber imagens. Leia o texto da imagem e aplique as regras de refinamento sobre ele.
Diretriz de Emojis: Use emojis de forma amigável para separar os blocos (✨, 💡, 📝). Pode usar 1 ou 2 emojis no meio do texto refinado se o tom do texto permitir, mas mantenha o profissionalismo.`;

    // MODO PADRÃO
    const promptPadrao = `Você é o Macrus, no MODO PADRÃO. Sua persona é a de um assistente conversacional inteligente, descontraído, empático e muito prestativo.
Suas capacidades incluem: conversar sobre qualquer assunto, criar e-mails, planejar apresentações, planos de aula, tirar dúvidas e ler documentos anexados.
DIRETRIZ VISUAL: Você pode receber imagens (fotos de documentos, manuscritos, quadros, objetos). Leia atentamente o que estiver na imagem antes de responder.
REGRA MATEMÁTICA: Sempre que for resolver cálculos, equações ou probabilidades, use a linguagem LaTeX entre $$ para renderizar bonito (exemplo: $$ P(X=k) = \\binom{n}{k} \\cdot p^k \\cdot (1-p)^{n-k} $$). NUNCA use '%' dentro da fórmula.
REGRA DE EXPORTAÇÃO: NUNCA diga "use a função imprimir" ou "não consigo gerar PDF". Apenas entregue o texto puro e formatado. O sistema já possui botões de download.
ATENÇÃO: Só mude para o comportamento do "Modo Análise" se o usuário pedir EXPLICITAMENTE para analisar riscos ou revisar juridicamente.

Diretriz de Emojis: Sinta-se livre para usar emojis no seu dia a dia (ex: 😊, 🚀, 🤔, 👋) para tornar a conversa mais humana e menos robótica. Use-os para expressar emoção, mas não exagere (máximo 1 ou 2 por parágrafo).`;

    // MODO MEMÓRIA (Usado para extrair fatos em background)
    const promptMemoria = `Analise as últimas mensagens e extraia FATOS permanentes sobre o usuário (ex: "É advogado", "Gosta de respostas curtas", "Estuda exatas").
Retorne APENAS um array JSON de strings, sem mais nenhum texto antes ou depois. Exemplo: ["É advogado", "Prefere respostas diretas"]. Se não houver fatos novos, retorne estritamente [].`;
    
    let tierSelecionado = MODEL_TIERS.padrao;

    if (mode === 'memoria') {
      basePrompt = promptMemoria;
      tierSelecionado = MODEL_TIERS.padrao; // Flash é suficiente e mais rápido para isso
    } else if (mode === 'leitura') {
      basePrompt = promptAnalise;
      tierSelecionado = MODEL_TIERS.leitura;
    } else if (mode === 'refinamento') {
      basePrompt = promptRefinamento;
      tierSelecionado = MODEL_TIERS.refinamento;
    } else {
      basePrompt = promptPadrao;
      tierSelecionado = MODEL_TIERS.padrao;
    }

    // ==========================================
    // 🧠 INJETANDO A MEMÓRIA NO PROMPT
    // ==========================================
    let memoriaTexto = "";
    if (memory && Array.isArray(memory) && memory.length > 0) {
      memoriaTexto = "\n\nO que você já sabe sobre este usuário (Memórias de conversas passadas): " + memory.join(", ") + ". Use isso para personalizar a resposta se for relevante.";
    }

    const finalInstruction = (systemPrompt ? basePrompt + "\n\nPreferências do usuário: " + systemPrompt : basePrompt) + memoriaTexto;

    let contentsArray = [];
    let historyToUse = history || [];

    if (historyToUse.length > 0 && historyToUse[historyToUse.length - 1].role === 'user') historyToUse.pop();

    historyToUse.forEach(msg => {
        contentsArray.push({
            role: msg.role === 'ai' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    });

    let promptFinal = message || "Por favor, analise o conteúdo enviado.";
    if (fileText && fileText.trim().length > 0) {
        promptFinal = "O usuário enviou o(s) seguinte(s) documento(s):\n\n" + fileText.substring(0, 300000) + "\n\nInstrução do usuário: " + (message || "Analise e compare os documentos.");
    }
    
    // ==========================================
    // 👁️ PROCESSAMENTO MULTIMODAL (TEXTO + IMAGEM)
    // ==========================================
    let userParts = [{ text: promptFinal }];

    if (images && images.length > 0) {
        images.forEach(imgUrl => {
            const match = imgUrl.match(/^data:(image\/[a-zA-Z]*);base64,(.*)$/);
            if (match) {
                userParts.push({
                    inlineData: {
                        mimeType: match[1],
                        data: match[2]
                    }
                });
            }
        });
    }

    contentsArray.push({ role: 'user', parts: userParts });

    // Chama a função com o tier selecionado
    await chamarModeloIA(apiKey, tierSelecionado, contentsArray, finalInstruction, res);

  } catch (error) {
    console.error('Erro geral:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor', details: error.message });
    else res.end();
  }
};
