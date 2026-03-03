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
const SYSTEM_PROMPT = `You are a plain-English contract reviewer helping tenants understand what they are agreeing to before signing.

RULES:
- NEVER cite statute numbers, section codes, or case law.
- NEVER say a clause "violates" or "is illegal." Use: "unusual," "worth questioning," "more one-sided than standard," "ask a lawyer about this."
- NEVER make definitive legal conclusions. Flag, don't adjudicate.
- Be specific and useful — explain what each clause actually says and why it matters in plain English.

Return ONLY a valid JSON object with this exact structure. No preamble, no markdown, no code fences:

{
  "summary": "2-3 sentences: rent amount, lease term, location if visible, and overall impression of whether this is standard or warrants careful review.",
  "score": "good or warn or bad",
  "scoreLabel": "One of: LOOKS STANDARD - Review before signing | WORTH REVIEWING - Some unusual terms | REVIEW CAREFULLY - Several one-sided clauses",
  "keyTerms": [
    { "label": "Term name", "value": "Term value" }
  ],
  "redFlags": [
    "CLAUSE TITLE: What it says, why it is unusual or one-sided, and what practical risk it creates. End with: Ask a lawyer about this before signing."
  ],
  "missingClauses": [
    "CLAUSE NAME: What it would normally cover and what risk its absence creates."
  ],
  "negotiationTips": [
    "POINT: Specific advice on what to ask the landlord to change and how to word the request."
  ]
}

Scoring:
- good: Standard lease, no major unusual terms.
- warn: 1-3 terms more one-sided than typical.
- bad: Several significantly one-sided or high-risk terms.

keyTerms: Include all financially significant terms — rent, lease term, deposit, late fees, notice period, pet policy, utilities, maintenance, early termination, and any other dollar amounts or deadlines.
redFlags: Top 6 most important flags only. Be concise but specific.
missingClauses: Up to 4 most important missing protections only.
negotiationTips: Exactly 4 tips, specific to this contract.`

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
    } else {
      // ── Guest (unauthenticated) IP limit: 3 analyses per 24 hours ─────
      const guestRl = rateLimit(req, { windowMs: 24 * 60 * 60_000, max: 3, label: 'guest_analyze' });
      if (!guestRl.ok) {
        return res.status(403).json({
          error: 'Guest limit reached. Create a free account for 5 analyses — no credit card required.',
          code: 'GUEST_LIMIT',
        });
      }
    }

    // ── Call Anthropic ─────────────────────────────────────────────────
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: 'Analyze this lease agreement and return the JSON analysis:\n\n' + contractText.slice(0, 9000),
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
          let text = parsed.content[0].text
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

          // If JSON is truncated, attempt to salvage it by closing open structures
          let result;
          try {
            result = JSON.parse(text);
          } catch(parseErr) {
            // Truncated — close any open array/object and retry
            const repaired = text
              .replace(/,\s*$/, '')           // trailing comma
              .replace(/"[^"]*$/, '"...')      // unclosed string
              + ']}]}';                        // close array + object
            try {
              result = JSON.parse(repaired);
            } catch(e2) {
              // Still broken — try a more aggressive repair by finding last complete item
              const lastBrace = text.lastIndexOf('"}');
              const lastBracket = text.lastIndexOf('"]');
              const cutAt = Math.max(lastBrace, lastBracket);
              if (cutAt > 100) {
                try {
                  result = JSON.parse(text.slice(0, cutAt + 2) + ']}]}');
                } catch(e3) {
                  console.error('[analyze] Parse error after repair attempts:', parseErr.message);
                  return res.status(500).json({ error: 'Could not parse AI response. Please try again.' });
                }
              } else {
                console.error('[analyze] Parse error:', parseErr.message);
                return res.status(500).json({ error: 'Could not parse AI response. Please try again.' });
              }
            }
          }
          res.status(200).json(result);
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
