const https = require('https');
const { welcomeEmail } = require('./email');
const { rateLimit } = require('./rateLimit');

// ── Safe error messages — never leak raw Supabase internals ───────────
function safeAuthError(err) {
  if (!err) return 'Something went wrong. Please try again.';
  const msg = typeof err === 'string' ? err : (err.message || err.msg || JSON.stringify(err));
  const lower = msg.toLowerCase();

  if (lower.includes('invalid login credentials') || lower.includes('invalid email or password'))
    return 'Incorrect email or password.';
  if (lower.includes('email not confirmed') || lower.includes('email_not_confirmed'))
    return 'Please confirm your email address before logging in. Check your inbox for the confirmation link.';
  if (lower.includes('user already registered') || lower.includes('already been registered'))
    return 'An account with this email already exists. Try logging in instead.';
  if (lower.includes('password should be at least') || lower.includes('weak_password'))
    return 'Password is too weak. Please choose a stronger password.';
  if (lower.includes('rate limit') || lower.includes('too many requests'))
    return 'Too many attempts. Please wait a moment and try again.';
  if (lower.includes('invalid email') || lower.includes('unable to validate email'))
    return 'Please enter a valid email address.';
  if (lower.includes('signup is disabled'))
    return 'New signups are temporarily disabled. Please try again later.';
  if (lower.includes('refresh_token_not_found') || lower.includes('token has expired'))
    return 'Your session has expired. Please log in again.';

  // Fallback — never return the raw message
  console.error('[auth] Unmapped Supabase error (not sent to client):', msg);
  return 'Something went wrong. Please try again.';
}

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

  // ── Rate limiting: 20 auth attempts per IP per minute ─────────────  // ADD THIS
  const rl = rateLimit(req, { windowMs: 60_000, max: 20, label: 'auth' });  // ADD THIS
  if (!rl.ok) return res.status(429).json({ error: rl.error });  // ADD THIS

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
        if (result.error) return res.status(400).json({ error: safeAuthError(result.error) });

        if (result.user) {
          await supabaseRequest(
            '/rest/v1/user_credits',
            'POST',
            { user_id: result.user.id, email, plan: 'free', credits: 5, phone: phone || null, email_opt_in: emailOptIn || false }
          );

          welcomeEmail(email).catch((err) =>
            console.error('[auth] Welcome email failed for', email, err.message)
          );
        }

        return res.status(200).json({ user: result.user, session: result.session });
      }

      // ── LOGIN ────────────────────────────────────────────────────────
      if (action === 'login') {
        const result = await supabaseRequest('/auth/v1/token?grant_type=password', 'POST', { email, password });
        if (result.error) return res.status(400).json({ error: safeAuthError(result.error) });
        return res.status(200).json({ user: result.user, session: result, token: result.access_token, refreshToken: result.refresh_token });
      }

      // ── GET CREDITS ──────────────────────────────────────────────────
      if (action === 'getCredits') {
        if (!token) return res.status(401).json({ error: 'Not authenticated' });

        const userRes = await supabaseRequest('/auth/v1/user', 'GET', {}, token);
        if (userRes.error || !userRes.id) return res.status(401).json({ error: 'Session expired. Please log in again.' });

        const credRes = await supabaseRequest(
          `/rest/v1/user_credits?user_id=eq.${userRes.id}&select=*`,
          'GET', {}, token
        );
        if (Array.isArray(credRes) && credRes.length > 0) {
          return res.status(200).json(credRes[0]);
        }
        // Create if doesn't exist
        await supabaseRequest('/rest/v1/user_credits', 'POST',
          { user_id: userRes.id, email: userRes.email, plan: 'free', credits: 5 }
        );
        return res.status(200).json({ plan: 'free', credits: 5 });
      }

      // ── DECREMENT CREDIT (no-op — handled server-side in analyze.js) ──
      if (action === 'decrementCredit') {
        return res.status(200).json({ success: true });
      }

      // ── REFRESH TOKEN ────────────────────────────────────────────────
      if (action === 'refresh') {
        if (!token) return res.status(401).json({ error: 'No refresh token' });
        const result = await supabaseRequest(
          '/auth/v1/token?grant_type=refresh_token',
          'POST',
          { refresh_token: token }
        );
        if (result.error) return res.status(401).json({ error: safeAuthError(result.error) });
        return res.status(200).json({
          token: result.access_token,
          refreshToken: result.refresh_token,
          user: result.user
        });
      }

      return res.status(400).json({ error: 'Invalid action' });
    } catch(e) {
      console.error('[auth] Unhandled exception:', e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });
};
