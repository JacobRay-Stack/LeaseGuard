const https = require('https');
const crypto = require('crypto');

// ── Supabase helper (service-key only — webhook is never user-authed) ──
function supabaseReq(path, method, body) {
  return new Promise((resolve, reject) => {
    const isGet = method === 'GET' || method === 'DELETE';
    const data = isGet ? '' : JSON.stringify(body || {});

    const headers = {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=representation',
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const options = {
      hostname: 'gbzyzsxuxwmdlzagkrvt.supabase.co',
      path,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (!d || d.trim() === '') return resolve([]);
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ error: 'Invalid DB response' }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Stripe signature verification (no SDK — pure crypto) ──────────────
// Stripe sends: Stripe-Signature: t=<timestamp>,v1=<sig>,v1=<sig2>...
function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',');
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, val] = part.split('=');
    if (key === 't') timestamp = val;
    if (key === 'v1') signatures.push(val);
  }

  if (!timestamp || !signatures.length) return false;

  // Reject webhooks older than 5 minutes to prevent replay attacks
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (age > 300) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  return signatures.some((sig) =>
    crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  );
}

// ── Stripe API helper (used to expand session/subscription objects) ────
function stripeGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Stripe parse error')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Look up Supabase user by email ────────────────────────────────────
async function findUserByEmail(email) {
  // Supabase admin API: list users filtered by email
  const result = await supabaseReq(
    `/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    'GET'
  );
  // Returns { users: [...] } or an array depending on Supabase version
  const users = result.users || (Array.isArray(result) ? result : []);
  return users.find((u) => u.email === email) || null;
}

// ── Look up Supabase user by client_reference_id (UUID) ───────────────
async function findUserById(uuid) {
  const result = await supabaseReq(`/auth/v1/admin/users/${uuid}`, 'GET');
  if (result.error || !result.id) return null;
  return result;
}

// ── Upsert user_credits row ───────────────────────────────────────────
async function upsertCredits(userId, email, patch) {
  // Try PATCH first (row should exist — created at signup)
  const existing = await supabaseReq(
    `/rest/v1/user_credits?user_id=eq.${userId}&select=user_id`,
    'GET'
  );
  const rowExists = Array.isArray(existing) && existing.length > 0;

  if (rowExists) {
    return supabaseReq(
      `/rest/v1/user_credits?user_id=eq.${userId}`,
      'PATCH',
      { ...patch, updated_at: new Date().toISOString() }
    );
  } else {
    // Row missing (e.g. user signed up via OAuth) — create it
    return supabaseReq('/rest/v1/user_credits', 'POST', {
      user_id: userId,
      email,
      ...patch,
      updated_at: new Date().toISOString(),
    });
  }
}

// ── Core event handlers ───────────────────────────────────────────────

// checkout.session.completed fires for BOTH one-time (basic) and first payment of subscription (pro)
async function handleCheckoutCompleted(session) {
  const email = session.customer_details?.email || session.customer_email;
  const refId = session.client_reference_id; // Supabase UUID — set in checkout.js
  const mode = session.mode; // 'payment' | 'subscription'

  // Resolve user: prefer client_reference_id (exact), fall back to email
  let user = null;
  if (refId && /^[0-9a-f-]{36}$/i.test(refId)) {
    user = await findUserById(refId);
  }
  if (!user && email) {
    user = await findUserByEmail(email);
  }

  if (!user) {
    console.error('[webhook] checkout.session.completed — user not found', { email, refId });
    // Still return 200 so Stripe doesn't retry indefinitely
    return;
  }

  if (mode === 'payment') {
    // Basic plan: 5 one-time credits
    await upsertCredits(user.id, user.email, {
      plan: 'basic',
      credits: 5,
      stripe_customer_id: session.customer,
    });
    console.log(`[webhook] Basic plan activated for ${user.email}`);
  } else if (mode === 'subscription') {
    // Pro plan: unlimited (credits = 9999 sentinel)
    await upsertCredits(user.id, user.email, {
      plan: 'pro',
      credits: 9999,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
    });
    console.log(`[webhook] Pro plan activated for ${user.email}`);
  }
}

// customer.subscription.deleted fires when a Pro subscription is cancelled/expires
async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;

  // Find user by stripe_customer_id
  const rows = await supabaseReq(
    `/rest/v1/user_credits?stripe_customer_id=eq.${customerId}&select=user_id,email`,
    'GET'
  );

  if (!Array.isArray(rows) || !rows.length) {
    console.error('[webhook] subscription.deleted — no user found for customer', customerId);
    return;
  }

  const { user_id, email } = rows[0];
  await upsertCredits(user_id, email, {
    plan: 'free',
    credits: 0,
    stripe_subscription_id: null,
  });
  console.log(`[webhook] Pro cancelled — reverted to free for ${email}`);
}

// customer.subscription.updated fires on plan changes, renewals, etc.
// For our simple model we only care about status transitions.
async function handleSubscriptionUpdated(subscription) {
  const status = subscription.status; // active | past_due | canceled | unpaid
  const customerId = subscription.customer;

  const rows = await supabaseReq(
    `/rest/v1/user_credits?stripe_customer_id=eq.${customerId}&select=user_id,email,plan`,
    'GET'
  );
  if (!Array.isArray(rows) || !rows.length) return;

  const { user_id, email, plan } = rows[0];

  if (status === 'active' && plan !== 'pro') {
    // Reactivated (e.g. after failed payment resolved)
    await upsertCredits(user_id, email, {
      plan: 'pro',
      credits: 9999,
      stripe_subscription_id: subscription.id,
    });
    console.log(`[webhook] Pro reactivated for ${email}`);
  } else if ((status === 'past_due' || status === 'unpaid' || status === 'canceled') && plan === 'pro') {
    // Payment failed / subscription lapsing — downgrade immediately
    await upsertCredits(user_id, email, {
      plan: 'free',
      credits: 0,
    });
    console.log(`[webhook] Pro suspended (${status}) for ${email}`);
  }
}

// ── Main handler ──────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Stripe requires the RAW body bytes for signature verification.
  // We must NOT parse it as JSON before verifying.
  const chunks = [];
  let bodySize = 0;
  const MAX_BODY = 65_536; // 64 KB — Stripe events are never this big

  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) {
      req.destroy();
      return res.status(413).end();
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const sigHeader = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    // ── Signature check ───────────────────────────────────
    if (!secret || !sigHeader) {
      console.error('[webhook] Missing secret or signature header');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }

    let verified = false;
    try {
      verified = verifyStripeSignature(rawBody, sigHeader, secret);
    } catch (e) {
      console.error('[webhook] Signature verification threw:', e.message);
    }

    if (!verified) {
      console.error('[webhook] Invalid signature — possible spoofed request');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // ── Parse event ───────────────────────────────────────
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Acknowledge immediately — Stripe retries if we take > 30s
    res.status(200).json({ received: true });

    // ── Dispatch ──────────────────────────────────────────
    try {
      const obj = event.data?.object;

      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(obj);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(obj);
          break;

        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(obj);
          break;

        // Safe to ignore — checkout.session.completed already handles first payment
        case 'invoice.payment_succeeded':
        case 'invoice.paid':
        case 'payment_intent.succeeded':
          break;

        default:
          // Log unhandled event types for visibility without erroring
          console.log(`[webhook] Unhandled event type: ${event.type}`);
      }
    } catch (e) {
      // Log but don't re-send 500 — we already sent 200 above.
      // Stripe would retry on 5xx, causing duplicate activations.
      console.error(`[webhook] Handler error for ${event.type}:`, e.message);
    }
  });
};
