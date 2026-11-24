
const MODEL_MATRIX = {
  free: {
    padrao: 'gemini-3.8-flash',
    leitura: 'meta-llama/llama-3.3-70b-instruct:free', 
    refinamento: 'meta-llama/llama-3.3-70b-instruct:free',
    premium: 'gemini-3.8-flash' 
  },
  essencial: {
    padrao: 'gemini-3.8-flash',
    leitura: 'deepseek/deepseek-chat', 
    refinamento: 'openai/gpt-4o-mini', 
    premium: 'gemini-3.8-pro' 
  },
  profissional: {
    padrao: 'gemini-3.8-flash',
    leitura: 'anthropic/claude-3.5-sonnet', 
    refinamento: 'anthropic/claude-3.5-sonnet',
    premium: 'anthropic/claude-3-opus' 
  }
};

const ALLOWED_DEV_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.8-pro',
  'deepseek/deepseek-chat',
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3-opus',
  'meta-llama/llama-3.3-70b-instruct:free'
];

function decidirModelo(planoUsuario, modoSelecionado, developerModel, isAdmin) {
  // 1. Se for admin e enviou um modelo válido, força o modelo
  if (isAdmin && developerModel && ALLOWED_DEV_MODELS.includes(developerModel)) {
    console.log(`[DEV MODE] Admin forçou o modelo: ${developerModel}`);
    return { modelo: developerModel, isForced: true };
  }

  // 2. Roteamento automático
  const plano = planoUsuario || 'free';
  const mapaDoPlano = MODEL_MATRIX[plano] || MODEL_MATRIX.free;
  const modosValidos = ['padrao', 'leitura', 'refinamento', 'premium', 'memoria'];
  const modo = modosValidos.includes(modoSelecionado) ? modoSelecionado : 'padrao';

  const modeloEscolhido = (modo === 'memoria') ? mapaDoPlano.padrao : (mapaDoPlano[modo] || mapaDoPlano.padrao);
  console.log(`[Router] Plano: ${plano} | Modo: ${modo} | Modelo: ${modeloEscolhido}`);
  
  return { modelo: modeloEscolhido, isForced: false };
}

async function chamarModeloIA(modelo, messages, systemInstruction, res) {
  const isGoogleDirect = !modelo.includes('/');
  
  const url = isGoogleDirect 
    ? `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_API_KEY}`
    : 'https://openrouter.ai/api/v1/chat/completions';

  const headers = isGoogleDirect
    ? { 'Content-Type': 'application/json' }
    : {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://macrus.app',
        'X-Title': 'Macrus'
      };

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
      stream: true,
      temperature: 0.5,
      stream_options: { include_usage: true }
    });
  }

  const response = await fetch(url, { method: 'POST', headers, body });

  if (!response.ok) {
    const errorData = await response.json();
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

module.exports = { decidirModelo, chamarModeloIA };
