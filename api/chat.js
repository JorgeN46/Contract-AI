const { createClient } = require('@supabase/supabase-js');
const { promptAnalise, promptRefinamento, promptPadrao, promptMemoria } = require('./lib/prompts');
const { verificarEDebitarCreditos, registrarUsoTokens } = require('./lib/creditos');

const requestCache = new Map();

const MODEL_MATRIX = {
  free: { padrao: 'gemini-3.8-flash', leitura: 'meta-llama/llama-3.3-70b-instruct:free', refinamento: 'mistralai/mistral-7b-instruct:free', premium: 'gemini-3.8-flash' },
  essencial: { padrao: 'gemini-3.8-flash', leitura: 'deepseek/deepseek-chat', refinamento: 'openai/gpt-4o-mini', premium: 'gemini-3.8-pro' },
  profissional: { padrao: 'gemini-3.8-flash', leitura: 'anthropic/claude-3.5-haiku', refinamento: 'openai/gpt-4o', premium: 'gemini-3.8-pro' }
};

const ALLOWED_DEV_MODELS = [
  'gemini-3.8-flash', 'gemini-3.8-pro', 'openai/gpt-4o-mini', 
  'anthropic/claude-3.5-haiku', 'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct:free'
];

function decidirModelo(planoUsuario, modoSelecionado, mensagem, temArquivo) {
  const plano = planoUsuario || 'free';
  const mapaDoPlano = MODEL_MATRIX[plano] || MODEL_MATRIX.free;
  const textoCurto = mensagem.length < 200;
  const semArquivo = !temArquivo;
  const tarefaSimples = textoCurto && semArquivo;

  if (tarefaSimples && modoSelecionado !== 'premium') return mapaDoPlano.padrao;
  return mapaDoPlano[modoSelecionado] || mapaDoPlano.padrao;
}

async function chamarModeloIA(modelo, messages, systemInstruction, res, isForced = false) {
  const isGoogleDirect = !modelo.includes('/');
  const url = isGoogleDirect 
    ? `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_API_KEY}`
    : 'https://openrouter.ai/api/v1/chat/completions';

  const headers = isGoogleDirect
    ? { 'Content-Type': 'application/json' }
    : { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://macrus.app', 'X-Title': 'Macrus' };

  let body;
  if (isGoogleDirect) {
    let contentsArray = [];
    messages.forEach(msg => {
      if (msg.role === 'system') return; 
      let parts = [];
      if (typeof msg.content === 'string') parts.push({ text: msg.content });
      else if (Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'text') parts.push({ text: c.text });
          if (c.type === 'image_url') {
            const match = c.image_url.url.match(/^data:(image\/[a-zA-Z]*);base64,(.*)$/);
            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        });
      }
      contentsArray.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
    });
    body = JSON.stringify({ systemInstruction: { parts: [{ text: systemInstruction }] }, contents: contentsArray, generationConfig: { temperature: 0.5 } });
  } else {
    body = JSON.stringify({
      model: modelo,
      messages: [{ role: 'system', content: systemInstruction }, ...messages],
      stream: true, temperature: 0.5, stream_options: { include_usage: true }
    });
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    const errorData = await response.json();
    console.error(`[Erro API] Modelo: ${modelo}`, errorData);
    throw new Error(JSON.stringify(errorData));
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write(`<MODEL_USED>${modelo}</MODEL_USED>`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tokensInfo = null;
  let buffer = '';

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
          if (isGoogleDirect) {
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) res.write(text);
            if (data.usageMetadata) tokensInfo = { prompt: data.usageMetadata.promptTokenCount || 0, output: data.usageMetadata.candidatesTokenCount || 0 };
          } else {
            const text = data.choices?.[0]?.delta?.content;
            if (text) res.write(text);
            if (data.usage) tokensInfo = { prompt: data.usage.prompt_tokens || 0, output: data.usage.completion_tokens || 0 };
          }
        } catch (e) {}
      }
    }
  }

  if (tokensInfo) res.write(`\n\n<TOKENS_INFO>${JSON.stringify(tokensInfo)}</TOKENS_INFO>`);
  res.end();
  return tokensInfo;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.URL_SUPABASE;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Configuração incompleta.' });

  const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Acesso não autorizado.' });

    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Sessão expirada.' });

    const userId = user.id;
    const { message, fileText, systemPrompt, mode, history, images, memory, developerModel } = req.body;

    // 🛡️ RATE LIMITING
    const limitKey = userId;
    const now = Date.now();
    if (!requestCache.has(limitKey)) requestCache.set(limitKey, []);
    const timestamps = requestCache.get(limitKey).filter(t => now - t < 60000);
    if (timestamps.length >= 15) return res.status(429).json({ error: 'Aguarde um minuto.' });
    timestamps.push(now);
    requestCache.set(limitKey, timestamps);

    // 💳 VERIFICAÇÃO DE CRÉDITOS (Retorna o objeto 'profile' do usuário)
    const { profile, custoEstimado, error } = await verificarEDebitarCreditos(supabaseAdmin, userId, fileText, images);
    if (error) return res.status(403).json({ error });

    if (!message && (!fileText || fileText.trim() === '') && (!images || images.length === 0)) {
      return res.status(400).json({ error: 'Mensagem vazia' });
    }

    // 🧠 SELEÇÃO DE PROMPTS
    let basePrompt = '';
    let modoParaRoteamento = mode || 'padrao';
    if (mode === 'memoria') basePrompt = promptMemoria;
    else if (mode === 'leitura') basePrompt = promptAnalise;
    else if (mode === 'refinamento') basePrompt = promptRefinamento;
    else if (mode === 'premium') basePrompt = promptAnalise; 
    else { basePrompt = promptPadrao; modoParaRoteamento = 'padrao'; }

    const planoUsuario = profile?.plan || 'free';
    const temArquivo = (fileText && fileText.trim().length > 0) || (images && images.length > 0);
    
    // 👇 AQUI ESTÁ A NOVA VALIDAÇÃO DO DEV MODE 👇
    let modeloEscolhido;
    let isForced = false;

    // Verifica se o usuário é admin pela coluna 'role' ou 'is_admin' no banco de dados
    const isAdmin = profile?.role === 'admin' || profile?.is_admin === true;

    if (isAdmin && developerModel && ALLOWED_DEV_MODELS.includes(developerModel)) {
        modeloEscolhido = developerModel;
        isForced = true;
        console.log(`[DEV MODE] Admin forçou o modelo: ${modeloEscolhido}`);
    } else {
        modeloEscolhido = decidirModelo(planoUsuario, modoParaRoteamento, message || '', temArquivo);
        console.log(`[Router] Plano: ${planoUsuario} | Modo: ${modoParaRoteamento} | Modelo: ${modeloEscolhido}`);
    }

    // 📝 MONTAGEM DO CONTEÚDO
    let memoriaTexto = (memory && Array.isArray(memory) && memory.length > 0) ? "\n\nO que você já sabe sobre este usuário: " + memory.join(", ") + "." : "";
    let avisoPlano = (planoUsuario === 'free') ? "\n\nAVISO DO SISTEMA: O usuário está no plano gratuito. Se o documento for muito complexo, finalize a resposta com: '💡 Dica: Para análises mais profundas, faça upgrade para o Plano Pro.'" : "";
    const finalInstruction = (systemPrompt ? basePrompt + "\n\nPreferências do usuário: " + systemPrompt : basePrompt) + memoriaTexto + avisoPlano;

    let messages = [];
    let historyToUse = history || [];
    if (historyToUse.length > 0 && historyToUse[historyToUse.length - 1].role === 'user') historyToUse.pop();

    historyToUse.forEach(msg => {
      messages.push({ role: msg.role === 'ai' ? 'assistant' : 'user', content: msg.content });
    });

    let promptFinal = message || "Por favor, analise o conteúdo enviado.";
    if (fileText && fileText.trim().length > 0) {
      // Leitura de contratos até 200 páginas (limite de 800.000 caracteres)
      promptFinal = "O usuário enviou o(s) seguinte(s) documento(s):\n\n" + fileText.substring(0, 800000) + "\n\nInstrução do usuário: " + (message || "Analise e compare os documentos.");
    }

    let userContent = [{ type: 'text', text: promptFinal }];
    if (images && images.length > 0) {
      images.forEach(imgUrl => {
        userContent.push({ type: 'image_url', image_url: { url: imgUrl } });
      });
    }

    messages.push({ role: 'user', content: userContent });

    // 🚀 CHAMADA DA IA
    try {
        const tokensInfo = await chamarModeloIA(modeloEscolhido, messages, finalInstruction, res, isForced);
        if (tokensInfo) await registrarUsoTokens(supabaseAdmin, userId, tokensInfo, custoEstimado, profile);
    } catch (apiError) {
        if (isForced) {
            res.write(`\n\n<ERROR_DEV_MODE>Falha no modelo forçado (${modeloEscolhido}): ${apiError.message}</ERROR_DEV_MODE>`);
            res.end();
        } else {
            throw apiError;
        }
    }

  } catch (error) {
    console.error('Erro geral no handler:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro no servidor', details: error.message });
    else res.end();
  }
};
