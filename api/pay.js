// api/pay.js — Vercel Serverless Function (Node.js)
// Creates a Stripe Checkout Session for a variable amount in AUD.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { orderId, amountCents } = req.body || {};
    if (!orderId || !Number.isFinite(amountCents) || amountCents < 100) {
      return res.status(400).json({ error: 'Bad request' });
    }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'aud',
            product_data: { name: 'JobRun — Glendale delivery' },
            unit_amount: Math.floor(amountCents),
          },
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/?paid=1#${orderId}`,
      cancel_url: `${baseUrl}/?cancelled=1#${orderId}`,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('Stripe error', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
};
