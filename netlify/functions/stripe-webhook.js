// Netlify Function: receives Stripe webhook events and pings Telegram
// when a Decode is purchased.
//
// Listens for: checkout.session.completed (configured in Stripe webhook endpoint)
//
// Env required:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET   (whsec_..., from Stripe webhook endpoint config)
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[stripe-webhook] missing required env vars');
    return { statusCode: 500, body: 'Server misconfigured' };
  }

  const stripe = Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' });

  // Stripe signs the EXACT raw bytes — must reconstruct from base64 if needed.
  const headers = lowercaseHeaders(event.headers);
  const sig = headers['stripe-signature'];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('[stripe-webhook] signature verify failed', err.message);
    return { statusCode: 400, body: 'Webhook signature verification failed' };
  }

  console.log('[stripe-webhook] received', { type: stripeEvent.type, id: stripeEvent.id });

  // Only handle the buy event we care about. Stripe may also send test events
  // and other types if the endpoint subscription expands later.
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'ignored' };
  }

  const session = stripeEvent.data.object || {};
  const email =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    'unknown';
  const name =
    (session.customer_details && session.customer_details.name) || null;
  const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : 0;
  const amount = '$' + (amountTotal / 100).toFixed(2);

  const timePT = formatTimePT(new Date());

  const sessionId = session.id || '';
  const sessionShort = sessionId.length > 28 ? sessionId.slice(0, 28) + '...' : sessionId;

  const lines = [
    'NEW DECODE  ·  ' + amount,
    'Email: ' + email,
  ];
  if (name) lines.push('Name: ' + name);
  lines.push('Time: ' + timePT + ' PT');
  lines.push('Session: ' + sessionShort);
  const text = lines.join('\n');

  // Send to Telegram. We don't care about retrying on Telegram failures —
  // log and still return 200 to Stripe so it doesn't keep retrying.
  try {
    const tgUrl = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
    const res = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text }),
    });
    const tg = await res.json().catch(() => ({}));
    if (tg && tg.ok) {
      console.log('[stripe-webhook] telegram sent', { message_id: (tg.result || {}).message_id });
    } else {
      console.log('[stripe-webhook] telegram failed', { description: tg && tg.description });
    }
  } catch (err) {
    console.log('[stripe-webhook] telegram fetch error', err.message);
  }

  return { statusCode: 200, body: 'ok' };
};

function lowercaseHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) out[k.toLowerCase()] = h[k];
  return out;
}

function formatTimePT(date) {
  // e.g. "Apr 29, 11:42 PM"
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}
