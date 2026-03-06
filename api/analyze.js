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
      { hostname: new URL(process.env.SUPABASE_URL || 'https://gbzyzsxuxwmdlzagkrvt.supabase.co').hostname, path, method, headers },
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
  "keyTerms": {
    "monthlyRent": "e.g. $2,400/mo — or null if not found",
    "leaseTerm": "e.g. 12 months (Jan 1 – Dec 31 2026) — or null",
    "securityDeposit": "e.g. $4,800 (2 months rent) — or null",
    "lateFee": "e.g. $50 after 5-day grace period — or null",
    "petPolicy": "e.g. No pets allowed — or null",
    "utilities": "e.g. Tenant pays electric & gas, landlord pays water — or null",
    "parking": "e.g. 1 spot included, additional $75/mo — or null",
    "maintenance": "e.g. Tenant responsible for repairs under $100 — or null",
    "noticeToVacate": "e.g. 60 days written notice required — or null",
    "renewalTerms": "e.g. Month-to-month after term at 3% increase — or null",
    "earlyTermination": "e.g. 2 months rent penalty — or null",
    "subletting": "e.g. Not permitted without written consent — or null"
  },
  "redFlags": [
    {
      "title": "Short clause name (3-5 words max)",
      "risk": "One sentence: what it means for the tenant in plain English.",
      "detail": "One sentence: why it is unusual or what specific financial/legal risk it creates.",
      "severity": "high or medium"
    }
  ],
  "missingClauses": [
    {
      "title": "Short clause name (3-5 words)",
      "risk": "One sentence: what the tenant is exposed to without this clause."
    }
  ],
  "negotiationTips": [
    "NEGOTIATION POINT: Specific, practical advice on what to ask the landlord to change and how to word the request. Focus on realistic changes a tenant could actually negotiate."
  ]
}

Scoring guidelines — score based on how unusual and one-sided the lease is, not on legal conclusions:
- good: Lease looks fairly standard with no major unusual terms. Still recommend reading carefully before signing.
- warn: Lease has 1-3 terms that are more one-sided or unusual than typical. Worth negotiating or getting a second opinion on.
- bad: Lease has several terms that are significantly more one-sided than standard leases, or terms that are highly unusual and create serious financial risk.

keyTerms: Fill in every field using exact values from the contract. Use null (not the string "null", but JSON null) for any field not mentioned in the contract. Be concise and specific — dollar amounts, dates, and durations where applicable.

redFlags: Return a maximum of 3 red flags total. Prioritize high severity over medium. Each flag must be concise — title is 3-5 words, risk is one plain-English sentence, detail is one sentence on why it's unusual or what the financial/legal exposure is. severity: "high" for serious financial risk or highly unusual terms, "medium" for one-sided but common clauses worth negotiating. Never cite statutes.

However, ALWAYS include a flag (even if it exceeds the 3 limit) if the lease contains any of the following serious clauses:
- Landlord can enter without notice or with less than 24 hours notice
- Automatic lease renewal or automatic rent increase without tenant action
- Tenant is responsible for ALL repairs regardless of cause or cost
- No timeline specified for security deposit return
- Landlord can terminate the lease at their sole discretion for any reason
- Tenant waives right to sue or waives liability claims against landlord
- Multiple overlapping fees (late fees + admin fees + other penalty fees stacked together)

For everything else, pick the top 3 most impactful flags only. Do not pad with minor or routine observations.

missingClauses: Check for the following standard tenant-protective clauses and flag only the ones that are genuinely absent or unclear in this lease. Return a maximum of 4. Each entry must have a short title (3-5 words) and a single plain-English sentence explaining what the tenant is exposed to without it.

Standard clauses to check for:
- Move-in / move-out inspection process (protects deposit)
- Specific security deposit return timeline and process
- Lease renewal terms and rent increase notice
- Landlord entry notice requirement (typically 24-48 hours)
- Maintenance and repair request process
- Renter's insurance requirement or recommendation
- Subletting or early termination process
- Dispute resolution or mediation process

Only flag clauses that are clearly missing. If a clause is present but vague, flag it. If the lease clearly addresses it, do not flag it. Do not invent missing clauses that wouldn't realistically be in a standard lease.

negotiationTips: exactly 4 practical tips. Each must be specific to this lease — not generic advice. Tell the tenant exactly what to ask for and how.`;

// ── Sanitize: fix curly quotes and unescaped interior quotes ───────────
function sanitizeJSON(str) {
  str = str.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  let out = '', inString = false, escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') {
      if (!inString) { inString = true; out += ch; continue; }
      const rest = str.slice(i + 1).trimStart();
      if (/^[:\,\}\]]/.test(rest)) { inString = false; out += ch; continue; }
      out += '\\"'; continue;
    }
    out += ch;
  }
  return out;
}

// ── Extract the outermost JSON object, discarding any trailing garbage ─
// Handles the common case where the model appends explanatory text after
// the closing brace despite being told not to.
function extractRootObject(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(str.slice(start, i + 1)); } catch(e) { break; }
      }
    }
  }
  return null; // no complete root object found — input is truncated
}

// ── Repair truncated JSON using stack-based structure tracking ─────────
// Correctly closes open strings, then closes open objects/arrays in order.
function repairTruncated(str) {
  str = str.replace(/,\s*$/, ''); // remove trailing comma

  // Close any open string
  let inStr = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') inStr = !inStr;
  }
  if (inStr) str += '"';

  // Walk the (now string-safe) structure to find unclosed delimiters
  const stack = [];
  inStr = false; esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }

  // Close open structures in reverse order (innermost first)
  let closing = '';
  while (stack.length) closing += stack.pop() === '{' ? '}' : ']';
  return str + closing;
}

// ── Parse with cascading repair attempts ──────────────────────────────
function parseWithRepair(text) {
  // Attempt 1: extract complete root object — handles trailing garbage/text
  const extracted = extractRootObject(text);
  if (extracted) return extracted;

  // Attempt 2: stack-based truncation repair
  const r1 = repairTruncated(text);
  try { return JSON.parse(r1); } catch(e) {}

  // Attempt 3: cut to last complete item, then stack-repair
  const cutAt = Math.max(text.lastIndexOf('"}'), text.lastIndexOf('"]'));
  if (cutAt > 100) {
    const r2 = repairTruncated(text.slice(0, cutAt + 2));
    try { return JSON.parse(r2); } catch(e) {}
  }

  return null; // all repair attempts failed
}

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
        // Fail closed — don't allow analyses if Supabase is unreachable
        console.error('[analyze] Credit check failed:', err.message);
        return res.status(503).json({ error: 'Service temporarily unavailable. Please try again in a moment.' });
      }
    } else {
      // ── Guest (unauthenticated) IP limit: 3 analyses per 24 hours ─────
      const DEV_IPS = (process.env.DEV_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
      if (!DEV_IPS.includes(clientIp)) {
        const guestRl = rateLimit(req, { windowMs: 24 * 60 * 60_000, max: 3, label: 'guest_analyze' });
        if (!guestRl.ok) {
          return res.status(403).json({
            error: 'Guest limit reached. Create a free account for 5 analyses — no credit card required.',
            code: 'GUEST_LIMIT',
          });
        }
      }
    }

    // ── Call Anthropic ─────────────────────────────────────────────────
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: 'Analyze this lease agreement and return the JSON analysis:\n\n' + contractText.slice(0, 12000),
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
        // ── Step 1: parse the Anthropic response envelope ─────────────
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          console.error('[analyze] Failed to parse Anthropic envelope — HTTP status:', apiRes.statusCode, 'body preview:', data.slice(0, 300));
          return res.status(500).json({ error: 'Unexpected response from AI service. Please try again.' });
        }

        try {
          if (parsed.error) {
            console.error('[analyze] Anthropic API error:', parsed.error);
            return res.status(500).json({
              error: parsed.error.message || parsed.error.type,
              type: parsed.error.type,
            });
          }

          // ── Step 2: extract model text content ──────────────────────
          const content = parsed.content;
          if (!content || !content[0] || !content[0].text) {
            console.error('[analyze] Unexpected response shape — stop_reason:', parsed.stop_reason, 'content:', JSON.stringify(content));
            return res.status(500).json({ error: 'Unexpected response from AI service. Please try again.' });
          }

          // Strip markdown code fences if model wraps output despite instructions
          let text = content[0].text
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

          // ── Step 3: sanitize and parse the contract JSON ─────────────
          text = sanitizeJSON(text);

          const result = parseWithRepair(text);

          if (!result) {
            console.error('[analyze] All parse/repair attempts failed — text length:', text.length, 'preview:', text.slice(0, 300));
            return res.status(500).json({ error: 'Could not parse AI response. Please try again.' });
          }

          res.status(200).json(result);
        } catch (e) {
          console.error('[analyze] Unexpected error processing response:', e.message, e.stack);
          res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
