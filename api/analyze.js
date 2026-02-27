const https = require('https');

// ── Shared helpers ─────────────────────────────────────────────────────
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

/**
 * Validate token and return the Supabase user, or null if invalid.
 */
async function getUserFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const r = await supabaseReq('/auth/v1/user', 'GET', null, false, token);
  if (!r || r.error || !r.id) return null;
  return r;
}

/**
 * Atomically decrement credits for non-pro users using a Postgres RPC.
 *
 * The RPC `decrement_credit` must exist in Supabase:
 *
 *   CREATE OR REPLACE FUNCTION decrement_credit(p_user_id uuid)
 *   RETURNS TABLE(plan text, credits int) LANGUAGE plpgsql AS $$
 *   BEGIN
 *     UPDATE user_credits
 *        SET credits    = credits - 1,
 *            updated_at = now()
 *      WHERE user_id = p_user_id
 *        AND plan    != 'pro'
 *        AND credits  > 0;
 *     IF NOT FOUND THEN
 *       RAISE EXCEPTION 'NO_CREDITS';
 *     END IF;
 *     RETURN QUERY
 *       SELECT plan, credits FROM user_credits WHERE user_id = p_user_id;
 *   END $$;
 *
 * Returns { plan, credits } on success, or throws with message 'NO_CREDITS'.
 *
 * Falls back to the two-step read+write path if the RPC is not yet deployed,
 * so existing environments continue to work while you roll out the migration.
 */
async function consumeCredit(userId) {
  // ── Preferred: atomic RPC ──────────────────────────────────────────
  try {
    const rpcResult = await supabaseReq(
      '/rest/v1/rpc/decrement_credit',
      'POST',
      { p_user_id: userId },
      true, // service key
      null
    );

    // PGRST202 = function not found (RPC not yet deployed) → use fallback
    if (rpcResult && rpcResult.code === 'PGRST202') {
      console.warn('[analyze] decrement_credit RPC not deployed, using fallback');
      // fall through to legacy path below
    }
    // NO_CREDITS raised by the function itself
    else if (rpcResult && rpcResult.message === 'NO_CREDITS') {
      return { ok: false, reason: 'no_credits' };
    }
    // Any other Supabase/Postgres error code that isn't "function not found"
    else if (rpcResult && rpcResult.code) {
      console.warn('[analyze] RPC error, using fallback:', rpcResult.code, rpcResult.message);
      // fall through to legacy path below
    }
    // Success
    else {
      const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
      return { ok: true, plan: row?.plan, credits: row?.credits };
    }
  } catch (rpcErr) {
    // Network-level error — fall through to legacy path
    console.warn('[analyze] decrement_credit RPC threw, using fallback:', rpcErr.message);
  }

  // ── Fallback: non-atomic read + write (existing behaviour) ─────────
  // NOTE: replace this block with a hard error once the RPC is deployed.
  const rows = await supabaseReq(
    `/rest/v1/user_credits?user_id=eq.${userId}&select=plan,credits`,
    'GET', null, true, null
  );

  if (!Array.isArray(rows) || !rows.length) {
    return { ok: false, reason: 'no_record' };
  }

  const { plan, credits } = rows[0];

  if (plan === 'pro') {
    return { ok: true, plan, credits: 9999 };
  }

  if (credits <= 0) {
    return { ok: false, reason: 'no_credits' };
  }

  await supabaseReq(
    `/rest/v1/user_credits?user_id=eq.${userId}`,
    'PATCH',
    { credits: credits - 1, updated_at: new Date().toISOString() },
    true, null
  );

  return { ok: true, plan, credits: credits - 1 };
}

// ── System prompt (unchanged) ──────────────────────────────────────────
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
  "keyTerms": [
    { "label": "Term name", "value": "Term value" }
  ],
  "redFlags": [
    "CLAUSE TITLE (Section X): Explanation of why this is problematic and which law or standard it may violate."
  ],
  "missingClauses": [
    "CLAUSE NAME: Explanation of why it should be included and what risk its absence creates."
  ],
  "negotiationTips": [
    "NEGOTIATION POINT: Specific, actionable advice on how to negotiate or push back on this clause before signing."
  ]
}

Scoring guidelines:
- good: Contract is legally compliant, reasonably balanced, no major issues
- warn: Contract has 1-3 moderate concerns or missing standard protections
- bad: Contract has illegal clauses, is heavily one-sided, or is missing critical protections

keyTerms should include: monthly rent, lease term, security deposit, late fee, notice period, pet policy, utilities, maintenance responsibility, early termination penalty, and any other financially significant terms found.

redFlags: each item must start with an ALL-CAPS title followed by a colon and explanation. Cite the problematic clause, explain the risk, and reference applicable law. Aim for 3-7 items.

missingClauses: each item must start with an ALL-CAPS clause name followed by a colon and explanation. Aim for 3-6 items.

negotiationTips: 3-5 specific, practical tips the tenant can use to negotiate better terms before signing. Each must start with an ALL-CAPS topic followed by a colon. Focus on the most impactful changes they could realistically request.

Be thorough, accurate, and professional. Your analysis may be the only legal review this person gets before signing.`;

// ── Handler ────────────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = '';
  let bodySize = 0;
  const MAX_BODY = 100_000; // 100 KB — contracts can be long

  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) {
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', async () => {
    if (bodySize > MAX_BODY) {
      return res.status(413).json({ error: 'Request too large' });
    }

    let contractText = '';
    let clientToken = null;

    try {
      const parsed = JSON.parse(body);
      contractText = parsed.contractText || '';
      clientToken = parsed.token || null;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (!contractText || contractText.trim().length < 50) {
      return res.status(400).json({ error: 'Contract text too short' });
    }

    // ── Step 1: Authenticate ─────────────────────────────────────────
    if (!clientToken) {
      // Unauthenticated users are handled purely client-side (localStorage counter).
      // To close this gap entirely you would require auth for all calls, but for
      // now we mirror the original design and allow anonymous analysis while the
      // frontend enforces the free limit.
      //
      // If you want to enforce server-side for anonymous users too, return 401 here:
      //   return res.status(401).json({ error: 'Authentication required' });
    }

    let userId = null;

    if (clientToken) {
      const user = await getUserFromToken(clientToken);
      if (!user) {
        return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
      }
      userId = user.id;

      // ── Step 2: Consume a credit (atomic where possible) ───────────
      const creditResult = await consumeCredit(userId);

      if (!creditResult.ok) {
        if (creditResult.reason === 'no_credits') {
          return res.status(403).json({
            error: 'No analyses remaining. Please upgrade your plan.',
            code: 'NO_CREDITS',
          });
        }
        return res.status(500).json({ error: 'Could not verify account credits. Please try again.' });
      }
    }

    // ── Step 3: Call Anthropic ───────────────────────────────────────
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 3000,
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
            return res.status(500).json({
              error: parsed.error.message || parsed.error.type,
              type: parsed.error.type,
            });
          }
          const text = parsed.content[0].text.replace(/```json|```/g, '').trim();
          res.status(200).json(JSON.parse(text));
        } catch (e) {
          res.status(500).json({ error: 'Parse error', raw: data.slice(0, 500) });
        }
      });
    });

    apiReq.on('error', (e) => res.status(500).json({ error: e.message }));
    apiReq.write(payload);
    apiReq.end();
  });
};
