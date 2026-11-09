const { createClient } = require('@supabase/supabase-js');

// Memória temporária para controle de limites (Rate Limiting básico)
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
        let tokensInfo = null; // 👈 Variável para guardar os tokens

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

                // 👇 CAPTURA OS DADOS DE TOKENS DA API DO GEMINI
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

        // 👇 ENVIA O MARCADOR SECRETO NO FINAL COM OS TOKENS
        if (tokensInfo) {
            res.write(`\n\n<TOKENS_INFO>${JSON.stringify(tokensInfo)}</TOKENS_INFO>`);
        }

        res.end();
        return; 

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
  
  if (!res.headersSent) {
    res.status(500).json({ error: 'Todos os modelos falharam', details: ultimoErro.message });
  } else {
    res.end();
  }
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
    let profile = null;

    // ==========================================
    // 🛡️ RATE LIMITING
    // ==========================================
    const limitKey = userId || req.headers['x-forwarded-for'] || 'anonimo';
    const now = Date.now();
    const windowMs = 60000; 
    const maxRequests = 15; 

    if (!requestCache.has(limitKey)) requestCache.set(limitKey, []);
    const timestamps = requestCache.get(limitKey).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) return res.status(429).json({ error: 'Aguarde um minuto.' });
    timestamps.push(now);
    requestCache.set(limitKey, timestamps);

    // ==========================================
    // 💳 CONTROLE DE CRÉDITOS
    // ==========================================
    if (userId) {
      try {
        let { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).maybeSingle();
        if (error) console.error("Erro ao buscar perfil:", error.message);
        profile = data;

        if (profile) {
          const temUpload = (fileText && fileText.trim().length > 0) || (images && images.length > 0);
          let custo = temUpload ? 5 : 1; // 5 créditos para upload, 1 para texto

          // Verifica se tem saldo
          if (profile.credits < custo) {
            return res.status(403).json({ error: 'Créditos insuficientes. Faça upgrade para continuar.' });
          }

          // Debita do banco
          await supabaseAdmin.from('profiles').update({ 
             credits: profile.credits - custo
          }).eq('id', userId);
          
          profile.credits = profile.credits - custo;
        }
      } catch (dbError) {
        console.error("⚠️ Falha na checagem de créditos, o chat continuará:", dbError.message);
      }
    }

    if (!message && (!fileText || fileText.trim() === '') && (!images || images.length === 0)) {
        return res.status(400).json({ error: 'Mensagem vazia' });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Chave do Gemini não configurada.' });

    let basePrompt = "";
    
    // PROMPTS
    const promptAnalise = `Você é o Macrus, no MODO ANÁLISE. Sua persona é a de um Advogado Sênior, Auditor e Revisor Técnico implacável.
Seu objetivo é organizar, explicar, alertar e CORRIGIR o texto. Você lê qualquer tipo de documento profissional.
DIRETRIZ VISUAL: Leia atentamente o que estiver na imagem.
REGRA MATEMÁTICA: Use LaTeX entre $$ (exemplo: $$ P(X=k) = \\binom{n}{k} \\cdot p^k \\cdot (1-p)^{n-k} $$). NUNCA use '%' dentro da fórmula.
Estrutura: 1. 📋 Resumo Operacional. 2. 🚨 Diagnóstico de Riscos (com Evidências). 3. 🛠️ Reescrita e Correção (❌ Original / ✅ Corrigido). 4. ➕ Cláusulas Sugeridas. 5. ⚖️ Aviso Legal.`;

    const promptRefinamento = `Você é o Macrus, no MODO REFINAMENTO. Sua persona é a de um Editor e Redator Profissional Sênior.
1. Se pedir para CRIAR, gere um texto de alta qualidade.
2. Se pedir para MELHORAR, reescreva aplicando o tom desejado.
3. Formate como: ✨ **Texto Refinado:** [texto] e 💡 **O que foi melhorado:** [explicação].
DIRETRIZ VISUAL: Leia o texto da imagem e aplique as regras de refinamento.`;

    const promptPadrao = `Você é o Macrus, no MODO PADRÃO. Sua persona é a de um assistente conversacional inteligente e muito prestativo.
DIRETRIZ VISUAL CRÍTICA: Se receber uma imagem, leia o que está nela. NUNCA invente um contrato se a imagem contiver cálculos, anotações ou textos aleatórios.
REGRA MATEMÁTICA: Use LaTeX entre $$ (exemplo: $$ x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a} $$). NUNCA use '%' dentro da fórmula.
ATENÇÃO: NUNCA use a estrutura de "Resumo Operacional" ou "Aviso Legal" neste modo. Seja natural e conversacional.`;

    const promptMemoria = `Analise as últimas mensagens e extraia FATOS permanentes sobre o usuário. Retorne APENAS um array JSON de strings. Exemplo: ["É advogado"]. Se não houver, retorne [].`;
    
    let tierSelecionado = MODEL_TIERS.padrao;

    if (mode === 'memoria') {
      basePrompt = promptMemoria;
      tierSelecionado = MODEL_TIERS.padrao;
    } else if (mode === 'leitura') {
      basePrompt = promptAnalise;
      if (profile && profile.plan === 'free') {
          tierSelecionado = MODEL_TIERS.padrao; 
      } else {
          tierSelecionado = MODEL_TIERS.leitura; 
      }
    } else if (mode === 'refinamento') {
      basePrompt = promptRefinamento;
      tierSelecionado = MODEL_TIERS.refinamento;
    } else {
      basePrompt = promptPadrao;
      tierSelecionado = MODEL_TIERS.padrao;
    }

    let memoriaTexto = "";
    if (memory && Array.isArray(memory) && memory.length > 0) {
      memoriaTexto = "\n\nO que você já sabe sobre este usuário: " + memory.join(", ") + ".";
    }

    let avisoPlano = "";
    if (profile && profile.plan === 'free') {
        avisoPlano = "\n\nAVISO DO SISTEMA: O usuário está no plano gratuito. Se o documento for muito complexo, finalize a resposta com a frase em itálico: '💡 Dica: Para análises mais profundas com IA de última geração, faça upgrade para o Plano Pro.'";
    }

    const finalInstruction = (systemPrompt ? basePrompt + "\n\nPreferências do usuário: " + systemPrompt : basePrompt) + memoriaTexto + avisoPlano;

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
    
    let userParts = [{ text: promptFinal }];
    if (images && images.length > 0) {
        images.forEach(imgUrl => {
            const match = imgUrl.match(/^data:(image\/[a-zA-Z]*);base64,(.*)$/);
            if (match) {
                userParts.push({
                    inlineData: { mimeType: match[1], data: match[2] }
                });
            }
        });
    }

    contentsArray.push({ role: 'user', parts: userParts });

    await chamarModeloIA(apiKey, tierSelecionado, contentsArray, finalInstruction, res);

  } catch (error) {
    console.error('Erro geral no handler:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor', details: error.message });
    else res.end();
  }
};
