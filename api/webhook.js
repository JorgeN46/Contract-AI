const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Inicializa o Supabase com a chave de Admin (para poder atualizar qualquer usuário)
const supabaseAdmin = createClient(
  process.env.URL_SUPABASE || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    // 1. Verifica se a requisição veio realmente do Stripe
    // Nota: Na Vercel, o body já vem parseado. O Stripe exige o body "cru" (string).
    // Usamos o req.body se for string, ou JSON.stringify se for objeto (dependendo da config da Vercel).
    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
  } catch (err) {
    console.error(`Erro na verificação do Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. Lida com o evento de Checkout concluído
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Pega o e-mail do cliente que pagou
    const customerEmail = session.customer_details.email;
    
    // Descobre qual plano foi comprado (você pode usar o valor ou o ID do produto)
    // Exemplo: se o valor for 5990 (R$ 59,90), é o Essencial. Se for 11990, é o Profissional.
    const amountTotal = session.amount_total; 
    let plano = 'essencial';
    let creditos = 150;
    
    if (amountTotal >= 11990) {
      plano = 'profissional';
      creditos = 400;
    }

    console.log(`Pagamento aprovado para: ${customerEmail} - Plano: ${plano}`);

    // 3. Atualiza o banco de dados do Supabase
    // Buscamos o usuário pelo e-mail na tabela profiles
    try {
      let { data: usuario, error: buscaError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('email', customerEmail) // Certifique-se de que a coluna 'email' existe na tabela profiles
        .maybeSingle();

      if (usuario) {
        await supabaseAdmin
          .from('profiles')
          .update({ 
            plan: plano, 
            credits: creditos // Dá os créditos do plano
          })
          .eq('id', usuario.id);
        
        console.log(`Usuário ${customerEmail} atualizado para o plano ${plano}.`);
      } else {
        console.log(`Usuário não encontrado na tabela profiles: ${customerEmail}`);
      }
    } catch (dbError) {
      console.error("Erro ao atualizar banco:", dbError);
    }
  }

  // 4. Responde ao Stripe que recebeu o evento com sucesso
  res.status(200).json({ received: true });
};
