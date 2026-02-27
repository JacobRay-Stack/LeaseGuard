const https = require('https');

// ── Supabase helper (service key) ──────────────────────────────────────
function supabaseReq(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const useService = !token;
    const isGet = method === 'GET';
    const data = isGet ? null : JSON.stringify(body || {});

    const headers = {
      'apikey': useService ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${useService ? process.env.SUPABASE_SERVICE_KEY : token}`,
    };
    if (!isGet && data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(
      { hostname: 'gbzyzsxuxwmdlzagkrvt.supabase.co', path, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); }
        });
      }
    );
    req.on('error', reject);
    if (!isGet && data) req.write(data);
    req.end();
  });
}

async function getUserFromToken(token) {
  if (!token) return null;
  const r = await supabaseReq('/auth/v1/user', 'GET', null, token);
  if (!r || r.error || !r.id) return null;
  return r;
}

// ── Handler ────────────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── FIX #4: Check size BEFORE appending ────────────────────────────
  const MAX_BODY = 10_000;
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
    chunks.push(chunk); // only push if within limit
  });

  req.on('end', async () => {
    if (aborted) return res.status(413).json({ error: 'Request too large' });

    const body = Buffer.concat(chunks).toString('utf8');

    // ── FIX #5: Validate plan against explicit allowlist ────────────
    const ALLOWED_PLANS = new Set(['basic', 'pro']);
    let plan = 'basic';
    let clientToken = null;

    try {
      const parsed = JSON.parse(body);
      const rawPlan = parsed.plan;
      plan = ALLOWED_PLANS.has(rawPlan) ? rawPlan : 'basic';
      clientToken = parsed.token || null;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Resolve who is checking out so the webhook can match them later
    let userId = null;
    let userEmail = null;

    if (clientToken) {
      const user = await getUserFromToken(clientToken);
      if (user) {
        userId = user.id;
        userEmail = user.email;
      }
    }

    const origin = req.headers.origin || 'https://analyzethiscontract.com';

    // ── Only allow known origins ────────────────────────────────────
    const ALLOWED_ORIGINS = new Set([
      'https://analyzethiscontract.com',
      'https://www.analyzethiscontract.com',
    ]);
    const safeOrigin = ALLOWED_ORIGINS.has(origin)
      ? origin
      : 'https://analyzethiscontract.com';

    const successUrl = `${safeOrigin}?checkout=success&plan=${plan}`;
    const cancelUrl = `${safeOrigin}?checkout=cancelled`;
    const isPro = plan === 'pro';

    const params = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': isPro
        ? 'AnalyzeThisContract Pro'
        : 'AnalyzeThisContract Basic',
      'line_items[0][price_data][product_data][description]': isPro
        ? 'Unlimited contract analyses per month'
        : '5 contract analyses',
      'line_items[0][price_data][unit_amount]': isPro ? '999' : '499',
      'line_items[0][quantity]': '1',
      'mode': isPro ? 'subscription' : 'payment',
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      ...(userId ? { 'client_reference_id': userId } : {}),
      ...(userEmail ? { 'customer_email': userEmail } : {}),
    });

    if (isPro) {
      params.set('line_items[0][price_data][recurring][interval]', 'month');
    }

    const paramStr = params.toString();

    const options = {
      hostname: 'api.stripe.com',
      path: '/v1/checkout/sessions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(paramStr),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (c) => (data += c));
      apiRes.on('end', () => {
        try {
          const session = JSON.parse(data);
          if (session.error) return res.status(500).json({ error: session.error.message });
          res.status(200).json({ url: session.url });
        } catch (e) {
          res.status(500).json({ error: 'Failed to create checkout session' });
        }
      });
    });

    apiReq.on('error', (e) => res.status(500).json({ error: e.message }));
    apiReq.write(paramStr);
    apiReq.end();
  });
};
