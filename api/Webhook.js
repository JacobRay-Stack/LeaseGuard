const https = require('https');
const crypto = require('crypto');
const { paymentConfirmationEmail, cancellationEmail } = require('./email');

// ── Supabase helper ────────────────────────────────────────────────────
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

    const options = { hostname: 'gbzyzsxuxwmdlzagkrvt.supabase.co', path, method, headers };

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

// ── Stripe signature verification ─────────────────────────────────────
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (typeof sigHeader !== 'string') return false;

  const parts = sigHeader.split(',');
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (key === 't') timestamp = val;
    if (key === 'v1') signatures.push(val);
  }

  if (!timestamp || !signatures.length) return false;

  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (isNaN(age) || age > 300) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');

  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), expectedBuf);
    } catch {
      return false;
    }
  });
}

// ── Stripe API helper ──────────────────────────────────────────────────
function stripeGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
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

// ── Paginated user lookup by email ─────────────────────────────────────
async function findUserByEmail(email) {
  if (!email || typeof email !== 'string') return null;

  const safeEmail = encodeURIComponent(email.trim().toLowerCase());
  const PAGE_SIZE = 50;
  let page = 1;

  while (true) {
    const result = await supabaseReq(
      `/auth/v1/admin/users?page=${page}&per_page=${PAGE_SIZE}&filter=${safeEmail}`,
      'GET'
    );

    const users = result.users || (Array.isArray(result) ? result : []);
    const match = users.find((u) => u.email && u.email.toLowerCase() === email.trim().toLowerCase());
    if (match) return match;
    if (users.length < PAGE_SIZE) return null;
    page++;
    if (page > 20) {
      console.error('[webhook] findUserByEmail: exceeded 20 pages, aborting');
      return null;
    }
  }
}

// ── Look up Supabase user by UUID ──────────────────────────────────────
async function findUserById(uuid) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid || !UUID_RE.test(uuid)) return null;
  const result = await supabaseReq(`/auth/v1/admin/users/${uuid}`, 'GET');
  if (result.error || !result.id) return null;
  return result;
}

// ── Upsert user_credits ────────────────────────────────────────────────
async function upsertCredits(userId, email, patch) {
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
    return supabaseReq('/rest/v1/user_credits', 'POST', {
      user_id: userId,
      email,
      ...patch,
      updated_at: new Date().toISOString(),
    });
  }
}

// ── Idempotency ────────────────────────────────────────────────────────
async function markEventProcessed(eventId) {
  return supabaseReq(
    '/rest/v1/processed_webhook_events',
    'POST',
    { event_id: eventId }
  );
}

async function isEventAlreadyProcessed(eventId) {
  try {
    const rows = await supabaseReq(
      `/rest/v1/processed_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id`,
      'GET'
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

// ── Event handlers ─────────────────────────────────────────────────────
async function handleCheckoutCompleted(session) {
  const email = session.customer_details?.email || session.customer_email;
  const refId = session.client_reference_id;
  const mode = session.mode;

  let user = null;
  if (refId) user = await findUserById(refId);
  if (!user && email) user = await findUserByEmail(email);

  if (!user) {
    console.error('[webhook] checkout.session.completed — user not found', { email, refId });
    return;
  }

  const recipientEmail = user.email || email;

  if (mode === 'payment') {
    await upsertCredits(user.id, recipientEmail, {
      plan: 'basic',
      credits: 5,
      stripe_customer_id: session.customer,
    });
    console.log(`[webhook] Basic plan activated for ${recipientEmail}`);

    // Send payment confirmation email (non-blocking)
    paymentConfirmationEmail(recipientEmail, 'basic').catch((err) =>
      console.error('[webhook] Payment confirmation email failed:', err.message)
    );

  } else if (mode === 'subscription') {
    await upsertCredits(user.id, recipientEmail, {
      plan: 'pro',
      credits: 9999,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
    });
    console.log(`[webhook] Pro plan activated for ${recipientEmail}`);

    // Send pro confirmation email (non-blocking)
    paymentConfirmationEmail(recipientEmail, 'pro').catch((err) =>
      console.error('[webhook] Pro confirmation email failed:', err.message)
    );
  }
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  const rows = await supabaseReq(
    `/rest/v1/user_credits?stripe_customer_id=eq.${customerId}&select=user_id,email`,
    'GET'
  );
  if (!Array.isArray(rows) || !rows.length) {
    console.error('[webhook] subscription.deleted — no user found for customer', customerId);
    return;
  }
  const { user_id, email } = rows[0];
  await upsertCredits(user_id, email, { plan: 'free', credits: 0, stripe_subscription_id: null });
  console.log(`[webhook] Pro cancelled — reverted to free for ${email}`);

  // Send cancellation email (non-blocking)
  cancellationEmail(email).catch((err) =>
    console.error('[webhook] Cancellation email failed:', err.message)
  );
}

async function handleSubscriptionUpdated(subscription) {
  const status = subscription.status;
  const customerId = subscription.customer;
  const rows = await supabaseReq(
    `/rest/v1/user_credits?stripe_customer_id=eq.${customerId}&select=user_id,email,plan`,
    'GET'
  );
  if (!Array.isArray(rows) || !rows.length) return;
  const { user_id, email, plan } = rows[0];

  if (status === 'active' && plan !== 'pro') {
    await upsertCredits(user_id, email, { plan: 'pro', credits: 9999, stripe_subscription_id: subscription.id });
    console.log(`[webhook] Pro reactivated for ${email}`);

    // Send reactivation email (non-blocking)
    paymentConfirmationEmail(email, 'pro').catch((err) =>
      console.error('[webhook] Reactivation email failed:', err.message)
    );

  } else if (['past_due', 'unpaid', 'canceled'].includes(status) && plan === 'pro') {
    await upsertCredits(user_id, email, { plan: 'free', credits: 0 });
    console.log(`[webhook] Pro suspended (${status}) for ${email}`);

    // Send suspension email (non-blocking)
    cancellationEmail(email).catch((err) =>
      console.error('[webhook] Suspension email failed:', err.message)
    );
  }
}

// ── Main handler ───────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const MAX_BODY = 65_536;
  const chunks = [];
  let bodySize = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) {
      aborted = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (aborted) return res.status(413).end();

    const rawBody = Buffer.concat(chunks).toString('utf8');
    const sigHeader = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

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

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const eventId = event.id;

    try {
      const alreadyDone = await isEventAlreadyProcessed(eventId);
      if (alreadyDone) {
        console.log(`[webhook] Skipping duplicate event ${eventId}`);
        return res.status(200).json({ received: true, duplicate: true });
      }
    } catch (e) {
      console.warn('[webhook] Idempotency check failed (non-fatal):', e.message);
    }

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
        case 'invoice.payment_succeeded':
        case 'invoice.paid':
        case 'payment_intent.succeeded':
          break;
        default:
          console.log(`[webhook] Unhandled event type: ${event.type}`);
      }

      try {
        await markEventProcessed(eventId);
      } catch (e) {
        console.warn('[webhook] Could not mark event processed (non-fatal):', e.message);
      }

      return res.status(200).json({ received: true });

    } catch (e) {
      console.error(`[webhook] Handler error for ${event.type}:`, e.message);
      return res.status(500).json({ error: 'Handler failed' });
    }
  });
};
