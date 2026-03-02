const https = require('https');
const { rateLimit } = require('./rateLimit');

// ── Timeout wrapper ────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
    ),
  ]);
}

// ── Supabase helper ────────────────────────────────────────────────────
function supabaseReq(path, method, body, useService, token) {
  return new Promise((resolve, reject) => {
    const isGet = method === 'GET';
    const data = isGet ? null : JSON.stringify(body || {});

    const headers = {
      'apikey': useService ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${useService ? process.env.SUPABASE_SERVICE_KEY : token}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
    if (!isGet && data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(
      { hostname: 'gbzyzsxuxwmdlzagkrvt.supabase.co', path, method, headers },
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

// ── Verify token and return user ───────────────────────────────────────
async function getUserFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const r = await withTimeout(
    supabaseReq('/auth/v1/user', 'GET', null, false, token),
    5000, 'getUserFromToken'
  );
  if (!r || r.error || !r.id) return null;
  return r;
}

// ── Consume one credit (pro users: passthrough) ────────────────────────
async function consumeCredit(userId) {
  const rows = await withTimeout(
    supabaseReq(
      `/rest/v1/user_credits?user_id=eq.${userId}&select=plan,credits`,
      'GET', null, true, null
    ),
    5000, 'get user_credits'
  );

  if (!rows || !Array.isArray(rows) || !rows.length) {
    return { ok: false, reason: 'no_record' };
  }

  const { plan, credits } = rows[0];

  if (plan === 'pro') return { ok: true, plan, credits: 9999 };
  if (credits <= 0) return { ok: false, reason: 'no_credits' };

  // Conditional PATCH: only updates if credits is still > 0,
  // preventing a race condition from going negative
  await withTimeout(
    supabaseReq(
      `/rest/v1/user_credits?user_id=eq.${userId}&credits=gt.0`,
      'PATCH',
      { credits: credits - 1, updated_at: new Date().toISOString() },
      true, null
    ),
    5000, 'patch user_credits'
  );

  return { ok: true, plan, credits: credits - 1 };
}

// ── System prompt ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a careful, plain-English lease agreement reviewer. Your job is to read contracts and help tenants understand what they are agreeing to — flagging terms that are unusual, one-sided, or worth questioning before signing.

CRITICAL RULES — follow these without exception:
1. NEVER cite specific statute numbers, section codes, or case law. You do not have reliable legal knowledge and citing statutes you are uncertain about causes real harm to real people.
2. NEVER state that a clause "violates" or "is illegal" under any specific law. Instead use language like: "this is unusual," "this is worth questioning," "landlords typically cannot do this," "this is more one-sided than standard leases," "a lawyer should review this."
3. NEVER make definitive legal conclusions. Your role is to flag, not adjudicate.
4. DO be specific about what the clause actually says and why it is unusual or risky in plain English.
5. DO compare to what is standard or common in most leases so the user understands what "normal" looks like.
6. DO recommend consulting a local attorney or tenant rights organization for any clause that raises serious concern.

Your analysis must be genuinely useful — not vague or overly hedged. Flag real issues clearly. Explain the practical risk in plain English. Help the user know what questions to ask.

Return ONLY a valid JSON object with exactly this structure — no preamble, no explanation, no markdown, no code fences:

{
  "summary": "2-3 sentence plain English overview of the contract. Include the rent amount, lease term, location if visible, and your overall impression of whether this is a standard lease or one that warrants careful review.",
  "score": "good or warn or bad",
  "scoreLabel": "One of: LOOKS STANDARD - Review before signing | WORTH REVIEWING - Some unusual terms | REVIEW CAREFULLY - Several one-sided clauses",
  "keyTerms": [
    { "label": "Term name", "value": "Term value" }
  ],
  "redFlags": [
    "CLAUSE TITLE: What this clause says in plain English, why it is unusual or one-sided compared to a standard lease, and what practical risk it creates for the tenant. Do not cite statute numbers. End with: Recommend asking a lawyer about this before signing."
  ],
  "missingClauses": [
    "CLAUSE NAME: What this clause would normally cover and what risk its absence creates for the tenant in plain English."
  ],
  "negotiationTips": [
    "NEGOTIATION POINT: Specific, practical advice on what to ask the landlord to change and how to word the request. Focus on realistic changes a tenant could actually negotiate."
  ]
}

Scoring guidelines — score based on how unusual and one-sided the lease is, not on legal conclusions:
- good: Lease looks fairly standard with no major unusual terms. Still recommend reading carefully before signing.
- warn: Lease has 1-3 terms that are more one-sided or unusual than typical. Worth negotiating or getting a second opinion on.
- bad: Lease has several terms that are significantly more one-sided than standard leases, or terms that are highly unusual and create serious financial risk.

keyTerms must include every financially significant term found: monthly rent, lease term, security deposit, late fee, notice period, pet policy, utilities, maintenance responsibility, early termination terms, and any other dollar amounts or deadlines in the lease.

redFlags: Flag every clause that is more one-sided, unusual, or risky than what appears in standard leases. Explain clearly in plain English what the clause does and why it matters. Never cite statute numbers. Never say "violates [law]." Do say "unusual," "more restrictive than most leases," "worth asking a lawyer about." Include every flag you find — do not omit any.

missingClauses: Flag protections that are absent but commonly appear in standard leases for the tenant's benefit. Explain what the missing clause would have covered and what the tenant is exposed to without it.

negotiationTips: exactly 4 practical tips. Each must be specific to this lease — not generic advice. Tell the tenant exactly what to ask for and how.`;

// ── Handler ────────────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const MAX_BODY = 100_000;
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
    if (aborted) return res.status(413).json({ error: 'Request too large' });
// ── Rate limiting: 30 analyze calls per IP per 10 minutes ─────────
    const rl = rateLimit(req, { windowMs: 10 * 60_000, max: 30, label: 'analyze' });
    if (!rl.ok) return res.status(429).json({ error: rl.error });
    let contractText = '';
    let clientToken = null;

    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      contractText = parsed.contractText || '';
      clientToken = parsed.token || null;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (!contractText || contractText.trim().length < 50) {
      return res.status(400).json({ error: 'Contract text too short' });
    }

    // ── Server-side credit gate ────────────────────────────────────────
    if (clientToken) {
      try {
        const user = await getUserFromToken(clientToken);
        if (!user) {
          return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
        }

        const creditResult = await consumeCredit(user.id);

        if (!creditResult.ok) {
          if (creditResult.reason === 'no_credits') {
            return res.status(403).json({
              error: 'No analyses remaining. Please upgrade your plan.',
              code: 'NO_CREDITS',
            });
          }
          if (creditResult.reason === 'no_record') {
            console.warn('[analyze] Missing user_credits row for', user.id, '— creating with 0 credits');
            await withTimeout(
              supabaseReq('/rest/v1/user_credits', 'POST', {
                user_id: user.id,
                email: user.email || '',
                plan: 'free',
                credits: 0,
              }, true, null),
              5000, 'create user_credits'
            ).catch(() => {});
            return res.status(403).json({
              error: 'No analyses remaining. Please upgrade your plan.',
              code: 'NO_CREDITS',
            });
          }
          console.error('[analyze] consumeCredit unexpected failure:', creditResult);
          return res.status(500).json({ error: 'Could not verify account credits. Please try again.' });
        }
      } catch (err) {
        // Fail closed — don't allow free analyses if Supabase is unreachable
        console.error('[analyze] Credit check failed:', err.message);
        return res.status(503).json({ error: 'Service temporarily unavailable. Please try again in a moment.' });
      }
    }

    // ── Call Anthropic ─────────────────────────────────────────────────
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: 'Analyze this lease agreement and return the JSON analysis:\n\n' + contractText.slice(0, 20000),
      }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (c) => { data += c; });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('[analyze] Anthropic error:', parsed.error);
            return res.status(500).json({
              error: parsed.error.message || parsed.error.type,
              type: parsed.error.type,
            });
          }
          // Strip markdown code fences if model wraps output despite instructions
          const text = parsed.content[0].text
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
          res.status(200).json(JSON.parse(text));
        } catch (e) {
          console.error('[analyze] Parse error:', e.message);
          res.status(500).json({ error: 'Parse error: ' + e.message });
        }
      });
    });

    apiReq.on('error', (e) => {
      console.error('[analyze] Anthropic request error:', e.message);
      res.status(500).json({ error: e.message });
    });

    apiReq.write(payload);
    apiReq.end();
  });
};
