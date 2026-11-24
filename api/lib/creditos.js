// Arquivo: api/lib/creditos.js

async function verificarEDebitarCreditos(supabaseAdmin, userId, fileText, images) {
  if (!userId) return { profile: null, custoEstimado: 1, error: null };

  try {
    let { data: profile, error } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) {
      console.error("Erro ao buscar perfil:", error.message);
      return { profile: null, custoEstimado: 1, error: null };
    }

    if (profile) {
      // 1. CÁLCULO DA RESERVA (ESTIMATIVA)
      let custoEstimado = 1;
      
      // Custo por imagem
      if (images && images.length > 0) custoEstimado += (images.length * 5);
      
      // Custo por arquivo (1 crédito a cada 4.000 caracteres, com mínimo de 2)
      if (fileText && fileText.trim().length > 0) {
        custoEstimado += Math.max(2, Math.ceil(fileText.length / 4000));
      }

      // Margem de segurança de 10% para não estourar o saldo durante o processamento
      custoEstimado = Math.ceil(custoEstimado * 1.1);

      // 2. Verifica se tem saldo
      if (profile.credits < custoEstimado) {
        return { 
          profile: null, 
          custoEstimado: 0, 
          error: `Créditos insuficientes. Esta operação precisa de ${custoEstimado} créditos, mas você tem ${profile.credits}. Faça upgrade.`
        };
      }

      // 3. Debita do banco (reserva)
      await supabaseAdmin.from('profiles').update({ 
         credits: profile.credits - custoEstimado
      }).eq('id', userId);

      profile.credits -= custoEstimado;

      return { profile, custoEstimado, error: null };
    }

    return { profile: null, custoEstimado: 1, error: null };
  } catch (err) {
    console.error("Falha na checagem de créditos, o chat continuará:", err.message);
    return { profile: null, custoEstimado: 1, error: null };
  }
}

async function registrarUsoTokens(supabaseAdmin, userId, tokensInfo, custoEstimado, profile, imagesCount = 0, modeloUsado = '') {
  if (!tokensInfo || !userId || !supabaseAdmin || !profile) return;

  try {
    // 1. CÁLCULO DO CUSTO REAL (1 crédito = 1.000 tokens)
    const tokensTotais = tokensInfo.prompt + tokensInfo.output;
    let custoBase = Math.max(1, Math.ceil(tokensTotais / 1000)); 

    // 2. APLICA O MULTIPLICADOR DO MODELO
    let multiplicador = 1;
    
    if (modeloUsado.includes('opus') || modeloUsado.includes('sonnet') || modeloUsado.includes('gpt-4o')) {
        multiplicador = 5; // Modelos Ultra Premium
    } else if (modeloUsado.includes('gemini-3.8-pro') || modeloUsado.includes('deepseek-chat')) {
        multiplicador = 3; // Modelos Avançados
    }
    // Gemini Flash e Llama ficam com multiplicador 1x (Econômicos)

    let custoRealTokens = custoBase * multiplicador;
    let custoRealImagens = imagesCount * 5;
    let custoRealTotal = custoRealTokens + custoRealImagens;

    // 3. AJUSTE DE SALDO (Devolve troco ou cobra diferença)
    const diferenca = custoEstimado - custoRealTotal;
    let novoSaldo = profile.credits;

    if (diferenca > 0) {
      novoSaldo = profile.credits + diferenca;
    } else if (diferenca < 0) {
      novoSaldo = Math.max(0, profile.credits + diferenca); 
    }

    if (diferenca !== 0) {
      await supabaseAdmin.from('profiles').update({ credits: novoSaldo }).eq('id', userId);
    }

    // 4. SALVA NO HISTÓRICO
    await supabaseAdmin.from('credit_history').insert({
      user_id: userId,
      action: imagesCount > 0 ? 'Análise com Imagem' : (custoRealTotal > 10 ? 'Análise Pesada' : 'Conversa Padrão'),
      tokens_in: tokensInfo.prompt,
      tokens_out: tokensInfo.output,
      cost_credits: custoRealTotal
    });

    console.log(`[Créditos] Modelo: ${modeloUsado} | Mult: ${multiplicador}x | Gasto: ${custoRealTotal} créditos | Saldo final: ${novoSaldo}`);

  } catch (err) {
    console.error("Erro ao registrar uso de tokens:", err);
  }
}

module.exports = { verificarEDebitarCreditos, registrarUsoTokens };
