const { createClient } = require('@supabase/supabase-js');
const { promptAnalise, promptRefinamento, promptPadrao, promptMemoria } = require('./lib/prompts');
const { verificarEDebitarCreditos, registrarUsoTokens } = require('./lib/creditos');

const requestCache = new Map();
const MODEL_TIERS = {
  padrao: { primary: 'gemini-3.8-flash', fallback: ['gemini-3.5-flash-lite'] },
  refinamento: { primary: 'gemini-3.8-flash', fallback: ['gemini-3.5-flash-lite'] },
  leitura: { primary: 'gemini-3.8-pro', fallback: ['gemini-3.8-flash'] }
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

        if (!response.ok) throw new Error(JSON.stringify(await response.json()));

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let tokensInfo = null;
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.replace('data: ', '').trim();
              if (dataStr === '[DONE]') continue;
              try {
                const data = JSON.parse(dataStr);
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) res.write(text);

                if (data.usageMetadata) {
                    tokensInfo = {
                        prompt: data.usageMetadata.promptTokenCount || 0,
                        output: data.usageMetadata.candidatesTokenCount || 0
                    };
                }
              } catch (e) {}
            }
          }
        }

        if (tokensInfo) {
            res.write(`\n\n<TOKENS_INFO>${JSON.stringify(tokensInfo)}</TOKENS_INFO>`);
        }

        res.end();
        return tokensInfo; 
      } catch (err) {
        ultimoErro = err;
        const msg = err.message || '';
        if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('429')) {
          await new Promise(r => setTimeout(r, Math.pow(tentativa, 2) * 1000));
          continue;
        }
        break; 
      }
    }
  }
  
  if (!res.headersSent) res.status(500).json({ error: 'Todos os modelos falharam', details: ultimoErro.message });
  else res.end();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.URL_SUPABASE;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Configuração do servidor incompleta (Faltando chaves)." });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

  try {
    const { message, fileText, systemPrompt, mode, history, userId, images, memory } = req.body;

    // 1. Rate Limiting
    const limitKey = userId || req.headers['x-forwarded-for'] || 'anonimo';
    const now = Date.now();
    const windowMs = 60000; 
    const maxRequests = 15; 

    if (!requestCache.has(limitKey)) requestCache.set(limitKey, []);
    const timestamps = requestCache.get(limitKey).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) return res.status(429).json({ error: 'Aguarde um minuto.' });
    timestamps.push(now);
    requestCache.set(limitKey, timestamps);

    // 2. Verificação de Créditos (Arquivo lib/creditos.js)
    const { profile, custoEstimado, error } = await verificarEDebitarCreditos(supabaseAdmin, userId, fileText, images);
    if (error) return res.status(403).json({ error });

    if (!message && (!fileText || fileText.trim() === '') && (!images || images.length === 0)) {
        return res.status(400).json({ error: 'Mensagem vazia' });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Chave do Gemini não configurada.' });

    // 3. Seleção de Prompts (Arquivo lib/prompts.js)
    let basePrompt = "";
    let tierSelecionado = MODEL_TIERS.padrao;

    if (mode === 'memoria') {
      basePrompt = promptMemoria;
    } else if (mode === 'leitura') {
      basePrompt = promptAnalise;
      tierSelecionado = (profile && profile.plan === 'free') ? MODEL_TIERS.padrao : MODEL_TIERS.leitura;
    } else if (mode === 'refinamento') {
      basePrompt = promptRefinamento;
      tierSelecionado = MODEL_TIERS.refinamento;
    } else {
      basePrompt = promptPadrao;
    }

    // 4. Montagem do Conteúdo
    let memoriaTexto = (memory && Array.isArray(memory) && memory.length > 0) ? "\n\nO que você já sabe sobre este usuário: " + memory.join(", ") + "." : "";
    let avisoPlano = (profile && profile.plan === 'free') ? "\n\nAVISO DO SISTEMA: O usuário está no plano gratuito. Se o documento for muito complexo, finalize a resposta com: '💡 Dica: Para análises mais profundas, faça upgrade para o Plano Pro.'" : "";
    const finalInstruction = (systemPrompt ? basePrompt + "\n\nPreferências do usuário: " + systemPrompt : basePrompt) + memoriaTexto + avisoPlano;

    let contentsArray = [];
    let historyToUse = history || [];
    if (historyToUse.length > 0 && historyToUse[historyToUse.length - 1].role === 'user') historyToUse.pop();

    historyToUse.forEach(msg => {
        contentsArray.push({ role: msg.role === 'ai' ? 'model' : 'user', parts: [{ text: msg.content }] });
    });

    let promptFinal = message || "Por favor, analise o conteúdo enviado.";
    if (fileText && fileText.trim().length > 0) {
        promptFinal = "O usuário enviou o(s) seguinte(s) documento(s):\n\n" + fileText.substring(0, 300000) + "\n\nInstrução do usuário: " + (message || "Analise e compare os documentos.");
    }
    
    let userParts = [{ text: promptFinal }];
    if (images && images.length > 0) {
        images.forEach(imgUrl => {
            const match = imgUrl.match(/^data:(image\/[a-zA-Z]*);base64,(.*)$/);
            if (match) userParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        });
    }

    contentsArray.push({ role: 'user', parts: userParts });

    // 5. Chamada da IA e registro dos tokens
    const tokensInfo = await chamarModeloIA(apiKey, tierSelecionado, contentsArray, finalInstruction, res);
    
    // 6. Registra o uso real (Arquivo lib/creditos.js)
    if (tokensInfo) {
      await registrarUsoTokens(supabaseAdmin, userId, tokensInfo, custoEstimado, profile);
    }

  } catch (error) {
    console.error('Erro geral no handler:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor', details: error.message });
    else res.end();
  }
};
