const https = require('https');
const { welcomeEmail, lastCreditEmail } = require('./email');

function supabaseRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const isService = !token;
    const isGet = method === 'GET';
    const data = isGet ? null : JSON.stringify(body);

    const headers = {
      'apikey': isService ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${isService ? process.env.SUPABASE_SERVICE_KEY : token}`,
    };
    if (!isGet) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (method === 'PATCH' || method === 'POST') {
      headers['Prefer'] = 'return=representation';
    }

    const options = {
      hostname: 'gbzyzsxuxwmdlzagkrvt.supabase.co',
      path,
      method,
      headers
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(d ? JSON.parse(d) : {}); } catch(e) { resolve({ error: d }); }
      });
    });
    req.on('error', reject);
    if (!isGet) req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Body size limit ────────────────────────────────────────────────
  const MAX_BODY = 10_000;
  const chunks = [];
  let bodySize = 0;
  let aborted = false;

  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) {
      aborted = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (aborted) return res.status(413).json({ error: 'Request too large' });

    try {
      const { action, email, password, token, phone, emailOptIn } = JSON.parse(
        Buffer.concat(chunks).toString('utf8')
      );

      // ── SIGNUP ───────────────────────────────────────────────────────
      if (action === 'signup') {
        const result = await supabaseRequest('/auth/v1/signup', 'POST', { email, password });
        if (result.error) return res.status(400).json({ error: result.error.message || result.error });

        if (result.user) {
          await supabaseRequest(
            '/rest/v1/user_credits',
            'POST',
            { user_id: result.user.id, email, plan: 'free', credits: 3, phone: phone || null, email_opt_in: emailOptIn || false }
          );

          // ── Send welcome email (non-blocking — never fails the signup) ──
          welcomeEmail(email).catch((err) =>
            console.error('[auth] Welcome email failed for', email, err.message)
          );
        }

        return res.status(200).json({ user: result.user, session: result.session });
      }

      // ── LOGIN ────────────────────────────────────────────────────────
      if (action === 'login') {
        const result = await supabaseRequest('/auth/v1/token?grant_type=password', 'POST', { email, password });
        if (result.error) return res.status(400).json({ error: result.error.message || result.error });
        return res.status(200).json({ user: result.user, session: result, token: result.access_token, refreshToken: result.refresh_token });
      }

      // ── GET CREDITS ──────────────────────────────────────────────────
      if (action === 'getCredits') {
        if (!token) return res.status(401).json({ error: 'Not authenticated' });

        const userRes = await supabaseRequest('/auth/v1/user', 'GET', {}, token);
        if (userRes.error || !userRes.id) return res.status(401).json({ error: 'Invalid token' });

        const credRes = await supabaseRequest(
          `/rest/v1/user_credits?user_id=eq.${userRes.id}&select=*`,
          'GET', {}, token
        );
        if (Array.isArray(credRes) && credRes.length > 0) {
          return res.status(200).json(credRes[0]);
        }
        // Create if doesn't exist
        await supabaseRequest('/rest/v1/user_credits', 'POST',
          { user_id: userRes.id, email: userRes.email, plan: 'free', credits: 3 }
        );
        return res.status(200).json({ plan: 'free', credits: 3 });
      }

      // ── DECREMENT CREDIT (backwards-compat no-op) ────────────────────
      // Credit decrement is now handled server-side in analyze.js.
      // Kept so old clients don't break.
      if (action === 'decrementCredit') {
        if (!token) return res.status(401).json({ error: 'Not authenticated' });
        const userRes = await supabaseRequest('/auth/v1/user', 'GET', {}, token);
        if (!userRes.id) return res.status(401).json({ error: 'Invalid token' });

        const credRes = await supabaseRequest(
          `/rest/v1/user_credits?user_id=eq.${userRes.id}&select=*`,
          'GET', {}, token
        );
        if (!Array.isArray(credRes) || credRes.length === 0) return res.status(400).json({ error: 'No credits found' });

        const cred = credRes[0];

        // ── If this was their last free credit, send an upgrade nudge ──
        if (cred.plan === 'free' && cred.credits === 0) {
          lastCreditEmail(userRes.email || email).catch((err) =>
            console.error('[auth] Last-credit email failed:', err.message)
          );
        }

        return res.status(200).json({ success: true, credits: cred.plan === 'pro' ? 'unlimited' : cred.credits });
      }

      // ── REFRESH TOKEN ────────────────────────────────────────────────
      if (action === 'refresh') {
        if (!token) return res.status(401).json({ error: 'No refresh token' });
        const result = await supabaseRequest(
          '/auth/v1/token?grant_type=refresh_token',
          'POST',
          { refresh_token: token }
        );
        if (result.error) return res.status(401).json({ error: result.error.message || result.error });
        return res.status(200).json({
          token: result.access_token,
          refreshToken: result.refresh_token,
          user: result.user
        });
      }

      return res.status(400).json({ error: 'Invalid action' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
