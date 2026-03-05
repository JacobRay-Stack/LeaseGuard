const https = require('https');

// ── Supabase helper ────────────────────────────────────────────────────
function supabaseReq(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const useService = !token;
    const isGet = method === 'GET';
    const data = isGet ? null : JSON.stringify(body || {});

    const headers = {
      'apikey': useService ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${useService ? process.env.SUPABASE_SERVICE_KEY : token}`,
      'Content-Type': 'application/json',
    };
    if (!isGet && data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(
      { hostname: 'gbzyzsxuxwmdlzagkrvt.supabase.co', path, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(d ? JSON.parse(d) : null); } catch (e) { resolve(null); }
        });
      }
    );
    req.on('error', reject);
    if (!isGet && data) req.write(data);
    req.end();
  });
}

// ── Get Supabase user from token ───────────────────────────────────────
async function getUserFromToken(token) {
  if (!token) return null;
  const r = await supabaseReq('/auth/v1/user', 'GET', null, token);
  if (!r || r.error || !r.id) return null;
  return r;
}

// ── Stripe request helper ──────────────────────────────────────────────
function stripeReq(path, method, params) {
  return new Promise((resolve, reject) => {
    const data = params ? new URLSearchParams(params).toString() : '';
    const options = {
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const { token } = JSON.parse(body);
      if (!token) return res.status(401).json({ error: 'Not authenticated' });

      // Verify user
      const user = await getUserFromToken(token);
      if (!user) return res.status(401).json({ error: 'Session expired. Please log in again.' });

      // Get their Stripe customer ID from Supabase
      const rows = await supabaseReq(
        `/rest/v1/user_credits?user_id=eq.${user.id}&select=stripe_customer_id`,
        'GET', null, null
      );

      const stripeCustomerId = Array.isArray(rows) && rows[0]?.stripe_customer_id;
      if (!stripeCustomerId) {
        return res.status(400).json({ error: 'No active subscription found.' });
      }

      // Create Stripe customer portal session
      const origin = req.headers.origin || 'https://www.analyzethiscontract.com';
      const session = await stripeReq('/v1/billing_portal/sessions', 'POST', {
        customer: stripeCustomerId,
        return_url: `${origin}/app`,
      });

      if (!session || session.error) {
        console.error('[portal] Stripe error:', session?.error);
        return res.status(500).json({ error: 'Could not open billing portal.' });
      }

      return res.status(200).json({ url: session.url });

    } catch (e) {
      console.error('[portal] Error:', e.message);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  });
};
