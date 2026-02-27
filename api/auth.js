const https = require('https');

function supabaseRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const isService = !token;
    const isGet = method === 'GET';
    // Never send a body on GET requests — Supabase rejects them with 401/400
    const data = isGet ? null : JSON.stringify(body);

    const headers = {
      'apikey': isService ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${isService ? process.env.SUPABASE_SERVICE_KEY : token}`,
    };
    if (!isGet) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    // Add Prefer header for PATCH/POST so Supabase doesn't return 400 on empty response
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

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { action, email, password, token, phone, emailOptIn } = JSON.parse(body);

      if (action === 'signup') {
        const result = await supabaseRequest('/auth/v1/signup', 'POST', { email, password });
        if (result.error) return res.status(400).json({ error: result.error.message || result.error });
        
        // Create credits row
        if (result.user) {
          await supabaseRequest(
            '/rest/v1/user_credits',
            'POST',
            { user_id: result.user.id, email, plan: 'free', credits: 3, phone: phone || null, email_opt_in: emailOptIn || false }
          );
        }
        return res.status(200).json({ user: result.user, session: result.session });
      }

      if (action === 'login') {
        const result = await supabaseRequest('/auth/v1/token?grant_type=password', 'POST', { email, password });
        if (result.error) return res.status(400).json({ error: result.error.message || result.error });
        return res.status(200).json({ user: result.user, session: result, token: result.access_token });
      }

      if (action === 'getCredits') {
        if (!token) return res.status(401).json({ error: 'Not authenticated' });
        
        // Get user from token
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

      if (action === 'decrementCredit') {
        if (!token) return res.status(401).json({ error: 'Not authenticated' });
        const userRes = await supabaseRequest('/auth/v1/user', 'GET', {}, token);
        if (!userRes.id) return res.status(401).json({ error: 'Invalid token' });

        // Get current credits
        const credRes = await supabaseRequest(
          `/rest/v1/user_credits?user_id=eq.${userRes.id}&select=*`,
          'GET', {}, token
        );
        if (!Array.isArray(credRes) || credRes.length === 0) return res.status(400).json({ error: 'No credits found' });
        
        const cred = credRes[0];
        if (cred.plan !== 'pro' && cred.credits <= 0) return res.status(403).json({ error: 'No credits remaining' });
        
        if (cred.plan !== 'pro') {
          await supabaseRequest(
            `/rest/v1/user_credits?user_id=eq.${userRes.id}`,
            'PATCH',
            { credits: cred.credits - 1, updated_at: new Date().toISOString() }
          );
        }
        return res.status(200).json({ success: true, credits: cred.plan === 'pro' ? 'unlimited' : cred.credits - 1 });
      }

      return res.status(400).json({ error: 'Invalid action' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
