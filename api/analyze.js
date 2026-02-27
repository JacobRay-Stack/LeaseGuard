const https = require('https');

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
      'apikey': useService
        ? process.env.SUPABASE_SERVICE_KEY
        : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${useService
        ? process.env.SUPABASE_SERVICE_KEY
        : token}`,
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

// ── Auth helper ────────────────────────────────────────────────────────
async function getUserFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const r = await withTimeout(
    supabaseReq('/auth/v1/user', 'GET', null, false, token),
    5000, 'getUserFromToken'
  );
  if (!r || r.error || !r.id) return null;
  return r;
}

// ── Credit consumption ─────────────────────────────────────────────────
async function consumeCredit(userId) {
  // 1. Try atomic RPC first
  try {
    const rpcResult = await withTimeout(
      supabaseReq('/rest/v1/rpc/decrement_credit', 'POST', { p_user_id: userId }, true, null),
      5000, 'decrement_credit RPC'
    );
    if (rpcResult) {
      if (rpcResult.code === 'PGRST202') {
        console.warn('[analyze] RPC not deployed, using fallback');
      } else if (rpcResult.hint === 'NO_CREDITS' || rpcResult.message === 'NO_CREDITS') {
        return { ok: false, reason: 'no_credits' };
      } else if (rpcResult.code) {
        console.warn('[analyze] RPC error', rpcResult.code, '- using fallback');
      } else {
        const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
        return { ok: true, plan: row?.plan, credits: row?.credits };
      }
    }
  } catch (err) {
    console.warn('[analyze] RPC failed/timed out, using fallback:', err.message);
  }

  // 2. Fallback: non-atomic read + write
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

  await withTimeout(
    supabaseReq(
      `/rest/v1/user_credits?user_id=eq.${userId}`,
      'PATCH',
      { credits: credits - 1, updated_at: new Date().toISOString() },
      true, null
    ),
    5000, 'patch user_credits'
  );

  return { ok: true, plan, credits: credits - 1 };
}

// ── System prompt ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert contract analyst specializing in residential and commercial lease agreements. You have deep knowledge of landlord-tenant law across all U.S. states and Canadian provinces, including jurisdiction-specific statutes, tenant rights, and standard industry practices.

Your job is to analyze lease agreements thoroughly and objectively, identifying both landlord-favorable and tenant-favorable terms, legal compliance issues, missing standard protections, and unusual or potentially problematic clauses.

When analyzing a lease, you must:
1. Identify the jurisdiction from the contract and apply the correct local laws
2. Flag any clauses that violate applicable landlord-tenant statutes
3. Note missing clauses that are standard for the jurisdiction
4. Highlight terms that are unusually one-sided in either direction
5. Extract all key financial and legal terms
6. Assign an overall score based on legal compliance and fairness

Return ONLY a valid JSON object with exactly this structure — no preamble, no explanation, no markdown:

{
  "summary": "2-3 sentence plain English overview of the contract, including jurisdiction, key terms, and overall assessment",
  "score": "good or warn or bad",
  "scoreLabel": "One of: COMPLIANT - Strong tenant protections | REVIEW RECOMMENDED - Some concerns | HIGH RISK - Significant issues found",
  "keyTerms": [{ "label": "Term name", "value": "Term value" }],
  "redFlags": ["CLAUSE TITLE (Section X): Explanation of why this is problematic and which law or standard it may violate."],
  "missingClauses": ["CLAUSE NAME: Explanation of why it should be included and what risk its absence creates."],
  "negotiationTips": ["NEGOTIATION POINT: Specific, actionable advice on how to negotiate or push back on this clause before signing."]
}

Scoring guidelines:
- good: Contract is legally compliant, reasonably balanced, no major issues
- warn: Contract has 1-3 moderate concerns or missing standard protections
- bad: Contract has illegal clauses, is heavily one-sided, or is missing critical protections

keyTerms should include: monthly rent, lease term, security deposit, late fee, notice period, pet policy, utilities, maintenance responsibility, early termination penalty, and any other financially significant terms found.
redFlags: each item must start with an ALL-CAPS title followed by a colon. Aim for 3-7 items.
missingClauses: each item must start with an ALL-CAPS clause name followed by a colon. Aim for 3-6 items.
negotiationTips: 3-5 tips, each starting with an ALL-CAPS topic followed by a colon.
Be thorough, accurate, and professional.`;

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
    if (bodySize > MAX_BODY) { aborted = true; req.destroy(); return; }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (aborted) return res.status(413).json({ error: 'Request too large' });

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

    // ── DEBUG: log env var presence (remove after confirming) ─────
    console.log('[analyze] env check — SERVICE_KEY present:', !!process.env.SUPABASE_SERVICE_KEY,
      '| ANON_KEY present:', !!process.env.SUPABASE_ANON_KEY,
      '| ANTHROPIC_KEY present:', !!process.env.ANTHROPIC_API_KEY,
      '| token present:', !!clientToken);

    // ── Auth + credit gate ─────────────────────────────────────────
    if (clientToken) {
      try {
        const user = await getUserFromToken(clientToken);
        if (!user) {
          return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
        }
        console.log('[analyze] user resolved:', user.id);

        const creditResult = await consumeCredit(user.id);
        console.log('[analyze] creditResult:', JSON.stringify(creditResult));

        if (!creditResult.ok) {
          if (creditResult.reason === 'no_credits') {
            return res.status(403).json({ error: 'No analyses remaining. Please upgrade your plan.', code: 'NO_CREDITS' });
          }
          if (creditResult.reason === 'no_record') {
            console.warn('[analyze] Missing user_credits row — creating');
            await withTimeout(
              supabaseReq('/rest/v1/user_credits', 'POST', {
                user_id: user.id, email: user.email || '', plan: 'free', credits: 2,
              }, true, null),
              5000, 'create user_credits'
            );
          } else {
            console.error('[analyze] consumeCredit unexpected:', creditResult);
            return res.status(500).json({ error: 'Could not verify account credits.' });
          }
        }
      } catch (err) {
        // Supabase unreachable — log and continue so Anthropic still runs
        console.error('[analyze] Credit check threw (Supabase down?):', err.message);
      }
    }

    // ── Call Anthropic ─────────────────────────────────────────────
    console.log('[analyze] calling Anthropic...');

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Analyze this lease agreement and return the JSON analysis:\n\n' + contractText.slice(0, 20000) }],
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
        console.log('[analyze] Anthropic responded, status:', apiRes.statusCode, 'length:', data.length);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('[analyze] Anthropic error:', parsed.error);
            return res.status(500).json({ error: parsed.error.message || parsed.error.type, type: parsed.error.type });
          }
          const text = parsed.content[0].text.replace(/```json|```/g, '').trim();
          res.status(200).json(JSON.parse(text));
        } catch (e) {
          console.error('[analyze] Parse error:', e.message, '| raw:', data.slice(0, 300));
          res.status(500).json({ error: 'Parse error', raw: data.slice(0, 500) });
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
