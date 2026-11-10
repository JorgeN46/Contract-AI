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
      // 1. Calcula o custo estimado baseado no tamanho do arquivo
      const temUpload = (fileText && fileText.trim().length > 0) || (images && images.length > 0);
      let custoEstimado = 1;

      if (temUpload) {
        let tamanhoTexto = fileText ? fileText.length : 0;
        if (tamanhoTexto < 50000) custoEstimado = 5;       // Até ~15 mil tokens
        else if (tamanhoTexto < 150000) custoEstimado = 10; // Até ~45 mil tokens
        else custoEstimado = 20;                            // 200+ páginas
      }

      // 2. Verifica se tem saldo
      if (profile.credits < custoEstimado) {
        return { 
          profile: null, 
          custoEstimado: 0, 
          error: `Créditos insuficientes. Esta operação custa ${custoEstimado} créditos, mas você tem ${profile.credits}. Faça upgrade.`
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

async function registrarUsoTokens(supabaseAdmin, userId, tokensInfo, custoEstimado, profile) {
  if (!tokensInfo || !userId || !supabaseAdmin || !profile) return;

  // Custo estimado pelo uso real dos tokens
  const custoReal = Math.max(1, Math.ceil((tokensInfo.prompt + tokensInfo.output) / 10000));
  const diferenca = custoEstimado - custoReal;
  
  let updateData = {};
  if (diferenca > 0) {
    updateData.credits = profile.credits + diferenca; // Devolve o troco
  } else if (diferenca < 0) {
    updateData.credits = Math.max(0, profile.credits + diferenca); // Cobra a diferença
  }

  if (Object.keys(updateData).length > 0) {
    await supabaseAdmin.from('profiles').update(updateData).eq('id', userId);
  }

  // Salva no histórico (que o trigger vai copiar para usage_logs)
  await supabaseAdmin.from('credit_history').insert({
    user_id: userId,
    action: 'Analise de IA',
    tokens_in: tokensInfo.prompt,
    tokens_out: tokensInfo.output,
    cost_credits: custoReal
  });
}

module.exports = { verificarEDebitarCreditos, registrarUsoTokens };
