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
const SYSTEM_PROMPT = `You are an expert contract analyst specializing in residential and commercial lease agreements. You have deep knowledge of landlord-tenant law across all U.S. states and Canadian provinces, including jurisdiction-specific statutes, tenant rights, and standard industry practices.

Your job is to analyze lease agreements thoroughly and objectively, identifying both landlord-favorable and tenant-favorable terms, legal compliance issues, missing standard protections, and unusual or potentially problematic clauses.

When analyzing a lease, you must:
1. Identify the jurisdiction from the contract and apply the correct local laws
2. Flag any clauses that violate applicable landlord-tenant statutes
3. Note missing clauses that are standard for the jurisdiction
4. Highlight terms that are unusually one-sided in either direction
5. Extract all key financial and legal terms
6. Assign an overall score based on legal compliance and fairness

Return ONLY a valid JSON object with exactly this structure — no preamble, no explanation, no markdown, no code fences:

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

    // ── Call Anthropic ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // Trim to 18000 chars — leaves plenty of output budget within 8192 tokens
    const trimmedContract = contractText.trim().slice(0, 18000);

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 8192,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: 'Analyze this lease agreement and return the JSON analysis:\n\n' + trimmedContract,
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

          // Detect truncation — stop_reason=max_tokens means JSON was cut off mid-stream
          if (parsed.stop_reason === 'max_tokens') {
            console.error('[analyze] Response truncated — contract too long');
            return res.status(500).json({
              error: 'This contract is too long to analyze in one pass. Please paste only the main body of the lease (remove signature pages, addenda, and exhibits) and try again.',
              code: 'RESPONSE_TRUNCATED',
            });
          }

          // Strip markdown code fences if model wraps output despite instructions
          const text = (parsed.content[0].text || '')
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

          if (!text) {
            console.error('[analyze] Empty response from model');
            return res.status(500).json({ error: 'Empty response from AI. Please try again.' });
          }

          res.status(200).json(JSON.parse(text));
        } catch (e) {
          console.error('[analyze] Parse error:', e.message);
          res.status(500).json({
            error: 'The AI returned an unexpected response format. Please try again.',
            code: 'PARSE_ERROR',
          });
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
