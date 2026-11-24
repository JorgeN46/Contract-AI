// api/chat.js

const { createClient } = require('@supabase/supabase-js');
const { promptAnalise, promptRefinamento, promptPadrao, promptMemoria } = require('./lib/prompts');
const { verificarEDebitarCreditos, registrarUsoTokens } = require('./lib/creditos');
const { decidirModelo, chamarModeloIA } = require('./lib/ai-engine'); // 👈 Importa o cérebro

const requestCache = new Map();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.URL_SUPABASE;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Configuração incompleta.' });

  const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

  try {
    // 1. Autenticação
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Acesso não autorizado.' });

    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Sessão expirada.' });

    const userId = user.id;
    const { message, fileText, systemPrompt, mode, history, images, memory, developerModel } = req.body;

    // 2. Validação Antecipada
    const mensagemValida = typeof message === 'string' && message.trim().length > 0;
    const arquivoValido = typeof fileText === 'string' && fileText.trim().length > 0;
    const imagensValidas = Array.isArray(images) && images.length > 0;

    if (!mensagemValida && !arquivoValido && !imagensValidas) {
      return res.status(400).json({ error: 'Mensagem vazia' });
    }

    // 3. Rate Limiting
    const limitKey = userId;
    const now = Date.now();
    if (!requestCache.has(limitKey)) requestCache.set(limitKey, []);
    const timestamps = requestCache.get(limitKey).filter(t => now - t < 60000);
    if (timestamps.length >= 15) return res.status(429).json({ error: 'Aguarde um minuto.' });
    timestamps.push(now);
    requestCache.set(limitKey, timestamps);

    // 4. Verificação de Créditos
    const { profile, custoEstimado, error } = await verificarEDebitarCreditos(supabaseAdmin, userId, fileText, images);
    if (error) return res.status(403).json({ error });

    // 5. Seleção de Prompt
    let basePrompt = '';
    let modoParaRoteamento = mode || 'padrao';
    if (mode === 'memoria') basePrompt = promptMemoria;
    else if (mode === 'leitura') basePrompt = promptAnalise;
    else if (mode === 'refinamento') basePrompt = promptRefinamento;
    else if (mode === 'premium') basePrompt = promptAnalise; 
    else { basePrompt = promptPadrao; modoParaRoteamento = 'padrao'; }

    // 6. Roteamento de Modelo (Chama o ai-engine)
    const planoUsuario = profile?.plan || 'free';
    const isAdmin = profile?.role === 'admin' || profile?.is_admin === true;
    
    const { modelo: modeloEscolhido, isForced } = decidirModelo(planoUsuario, modoParaRoteamento, developerModel, isAdmin);

    // 7. Montagem do Conteúdo
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
      promptFinal = "O usuário enviou o(s) seguinte(s) documento(s):\n\n" + fileText.substring(0, 800000) + "\n\nInstrução do usuário: " + (message || "Analise e compare os documentos.");
    }

    let userContent = [{ type: 'text', text: promptFinal }];
    if (images && images.length > 0) {
      images.forEach(imgUrl => userContent.push({ type: 'image_url', image_url: { url: imgUrl } }));
    }

    messages.push({ role: 'user', content: userContent });

    // 8. Chamada da IA (Chama o ai-engine) e Registro
    try {
        const tokensInfo = await chamarModeloIA(modeloEscolhido, messages, finalInstruction, res);
        if (tokensInfo) {
          await registrarUsoTokens(supabaseAdmin, userId, tokensInfo, custoEstimado, profile);
        }
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
