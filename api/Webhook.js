const https = require('https');
const crypto = require('crypto');

// ── Supabase helper (always service key — webhook is server-to-server) ──
function supabaseReq(path, method, body) {
  return new Promise((resolve, reject) => {
    const isGet = method === 'GET';
    const data = isGet ? null : JSON.stringify(body || {});

    const headers = {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
    if (!isGet && data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(
      {
        hostname: process.env.SUPABASE_HOSTNAME || 'gbzyzsxuxwmdlzagkrvt.supabase.co',
        path,
        method,
        headers,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (!d || d.trim() === '') return resolve(null);
          try { resolve(JSON.parse(d)); } catch (e) { resolve({ _raw: d }); }
        });
      }
    );
    req.on('error', reject);
    if (!isGet && data) req.write(data);
    req.end();
  });
}

// ── Stripe signature verification (no SDK) ────────────────────────────
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [key, val] = part.split('=');
    if (key === 't') acc.t = val;
    if (key === 'v1') acc.v1.push(val);
    return acc;
  }, { t: null, v1: [] });

  if (!parts.t || !parts.v1.length) return false;

  // Reject webhooks older than 5 minutes (replay attack protection)
  const tolerance = 5 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(parts.t, 10)) > tolerance) {
    console.warn('[webhook] Timestamp too old — possible replay attack');
    return false;
  }

  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return parts.v1.some((sig) =>
    crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  );
}

// ── Activate pro plan ─────────────────────────────────────────────────
async function activateProPlan(userId, stripeCustomerId, stripeSubscriptionId) {
  const existing = await supabaseReq(
    `/rest/v1/user_credits?user_id=eq.${userId}&select=user_id`,
    'GET'
  );

  const payload = {
    plan: 'pro',
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    updated_at: new Date().toISOString(),
  };

  if (Array.isArray(existing) && existing.length > 0) {
    await supabaseReq(`/rest/v1/user_credits?user_id=eq.${userId}`, 'PATCH', payload);
  } else {
    // Edge case: no row yet — insert one
    await supabaseReq('/rest/v1/user_credits', 'POST', {
      user_id: userId,
      plan: 'pro',
      credits: 0,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      updated_at: new Date().toISOString(),
    });
  }

  console.log('[webhook] Pro activated for user', userId);
}

// ── Downgrade to free ─────────────────────────────────────────────────
async function deactivateProPlan(stripeSubscriptionId, reason) {
  await supabaseReq(
    `/rest/v1/user_credits?stripe_subscription_id=eq.${stripeSubscriptionId}`,
    'PATCH',
    { plan: 'free', credits: 0, updated_at: new Date().toISOString() }
  );
  console.log('[webhook] Pro deactivated —', reason, '— sub', stripeSubscriptionId);
}

// ── Handler ───────────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const chunks = [];
  let bodySize = 0;
  const MAX_BODY = 65_536;

  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) { req.destroy(); return; }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const sigHeader = req.headers['stripe-signature'];

    if (!verifyStripeSignature(rawBody, sigHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
      console.warn('[webhook] Signature verification failed');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try { event = JSON.parse(rawBody); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

    const obj = event.data?.object;

    try {
      switch (event.type) {

        case 'checkout.session.completed': {
          if (obj.mode !== 'subscription') break;
          const userId = obj.client_reference_id;
          if (!userId) {
            console.error('[webhook] No client_reference_id on session', obj.id);
            break;
          }
          await activateProPlan(userId, obj.customer, obj.subscription);
          break;
        }

        case 'invoice.payment_succeeded': {
          if (!obj.subscription) break;
          // Idempotent re-confirmation on every renewal cycle
          await supabaseReq(
            `/rest/v1/user_credits?stripe_subscription_id=eq.${obj.subscription}`,
            'PATCH',
            { plan: 'pro', stripe_customer_id: obj.customer, updated_at: new Date().toISOString() }
          );
          console.log('[webhook] Renewal confirmed for sub', obj.subscription);
          break;
        }

        case 'invoice.payment_failed': {
          // Only downgrade when Stripe has exhausted all retries
          if (obj.next_payment_attempt === null) {
            await deactivateProPlan(obj.subscription, 'payment_failed_final');
          }
          break;
        }

        case 'customer.subscription.deleted': {
          await deactivateProPlan(obj.id, 'subscription_cancelled');
          break;
        }

        case 'customer.subscription.updated': {
          if (obj.status === 'active' || obj.status === 'trialing') {
            await supabaseReq(
              `/rest/v1/user_credits?stripe_subscription_id=eq.${obj.id}`,
              'PATCH',
              { plan: 'pro', updated_at: new Date().toISOString() }
            );
          } else if (['past_due', 'unpaid', 'paused', 'canceled'].includes(obj.status)) {
            await deactivateProPlan(obj.id, `status_${obj.status}`);
          }
          break;
        }

        default: break;
      }

      return res.status(200).json({ received: true });

    } catch (err) {
      console.error('[webhook] Error on', event.type, ':', err.message);
      return res.status(500).json({ error: 'Internal error' }); // triggers Stripe retry
    }
  });
};
