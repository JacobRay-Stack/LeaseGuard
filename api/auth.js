const https = require('https');

// ── Constants ──────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function supabaseRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const isService = !token;
    const isGet = method === 'GET';
    const data = isGet ? null : JSON.stringify(body);

    const headers = {
      'apikey': isService ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${isService ? process.env.SUPABASE_SERVICE_KEY : token}`,
    };
    if (!isGet && data !== null) {
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
      headers,
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({ error: d }); }
      });
    });
    req.on('error', reject);
    if (!isGet && data !== null) req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Body size limit ──────────────────────────────────────────────────
  let body = '';
  let bodySize = 0;
  const MAX_BODY = 10_000;

  await new Promise((resolve) => {
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', resolve);
  });

  if (bodySize > MAX_BODY) return res.status(413).json({ error: 'Request too large' });

  try {
    const { action, email, password, token, phone, emailOptIn } = JSON.parse(body);

    // ── signup ───────────────────────────────────────────────────────
    if (action === 'signup') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const result = await supabaseRequest('/auth/v1/signup', 'POST', { email, password });
      if (result.error) return res.status(400).json({ error: result.error.message || result.error });

      if (result.user) {
        await supabaseRequest(
          '/rest/v1/user_credits',
          'POST',
          {
            user_id: result.user.id,
            email,
            plan: 'free',
            credits: 3,
            phone: phone || null,
            email_opt_in: emailOptIn || false,
          }
        );
      }
      return res.status(200).json({ user: result.user, session: result.session });
    }

    // ── login ────────────────────────────────────────────────────────
    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const result = await supabaseRequest(
        '/auth/v1/token?grant_type=password',
        'POST',
        { email, password }
      );
      if (result.error) return res.status(400).json({ error: result.error.message || result.error });
      return res.status(200).json({
        user: result.user,
        session: result,
        token: result.access_token,
        refreshToken: result.refresh_token,
      });
    }

    // ── getCredits ───────────────────────────────────────────────────
    if (action === 'getCredits') {
      if (!token) return res.status(401).json({ error: 'Not authenticated' });

      const userRes = await supabaseRequest('/auth/v1/user', 'GET', null, token);
      if (userRes.error || !userRes.id) return res.status(401).json({ error: 'Invalid token' });

      const credRes = await supabaseRequest(
        `/rest/v1/user_credits?user_id=eq.${userRes.id}&select=*`,
        'GET', null, token
      );
      if (Array.isArray(credRes) && credRes.length > 0) {
        return res.status(200).json(credRes[0]);
      }

      // Row missing — create it
      await supabaseRequest('/rest/v1/user_credits', 'POST', {
        user_id: userRes.id,
        email: userRes.email,
        plan: 'free',
        credits: 3,
      });
      return res.status(200).json({ plan: 'free', credits: 3 });
    }

    // ── decrementCredit ──────────────────────────────────────────────
    //
    // NOTE: This action is kept for backward compatibility but analyze.js
    // now calls the atomic RPC directly. This path is a fallback only.
    // The race condition is fixed by the RPC in analyze.js; callers should
    // prefer that path.
    //
    if (action === 'decrementCredit') {
      if (!token) return res.status(401).json({ error: 'Not authenticated' });

      const userRes = await supabaseRequest('/auth/v1/user', 'GET', null, token);
      if (!userRes || !userRes.id) return res.status(401).json({ error: 'Invalid token' });

      // ── Preferred: atomic RPC ────────────────────────────────────
      try {
        const rpcResult = await supabaseRequest(
          '/rest/v1/rpc/decrement_credit',
          'POST',
          { p_user_id: userRes.id }
        );

        if (rpcResult && rpcResult.message === 'NO_CREDITS') {
          return res.status(403).json({ error: 'No credits remaining' });
        }
        if (rpcResult && rpcResult.code) {
          throw new Error(rpcResult.message); // fall through to legacy path
        }

        const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
        return res.status(200).json({
          success: true,
          credits: row?.plan === 'pro' ? 'unlimited' : row?.credits,
        });
      } catch (rpcErr) {
        console.warn('[auth] decrementCredit RPC unavailable, using fallback:', rpcErr.message);
      }

      // ── Fallback: non-atomic (remove once RPC is deployed) ────────
      const credRes = await supabaseRequest(
        `/rest/v1/user_credits?user_id=eq.${userRes.id}&select=*`,
        'GET', null, token
      );
      if (!Array.isArray(credRes) || credRes.length === 0) {
        return res.status(400).json({ error: 'No credits found' });
      }

      const cred = credRes[0];
      if (cred.plan !== 'pro' && cred.credits <= 0) {
        return res.status(403).json({ error: 'No credits remaining' });
      }

      if (cred.plan !== 'pro') {
        await supabaseRequest(
          `/rest/v1/user_credits?user_id=eq.${userRes.id}`,
          'PATCH',
          { credits: cred.credits - 1, updated_at: new Date().toISOString() }
        );
      }

      return res.status(200).json({
        success: true,
        credits: cred.plan === 'pro' ? 'unlimited' : cred.credits - 1,
      });
    }

    // ── refresh ──────────────────────────────────────────────────────
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
        user: result.user,
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
