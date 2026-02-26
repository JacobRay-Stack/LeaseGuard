const https = require('https');

module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let contractText = '';
    try {
      contractText = JSON.parse(body).contractText || '';
    } catch(e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (contractText.trim().length < 50) {
      return res.status(400).json({ error: 'Too short' });
    }

    const systemPrompt = `You are an expert contract analyst specializing in residential and commercial lease agreements. You have deep knowledge of landlord-tenant law across all U.S. states and Canadian provinces, including jurisdiction-specific statutes, tenant rights, and standard industry practices.

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
    "Specific red flag with explanation of why it is problematic and which law or standard it may violate"
  ],
  "missingClauses": [
    "Specific missing clause with explanation of why it should be included and what risk its absence creates"
  ]
}

Scoring guidelines:
- good: Contract is legally compliant, reasonably balanced, no major issues
- warn: Contract has 1-3 moderate concerns or missing standard protections
- bad: Contract has illegal clauses, is heavily one-sided, or is missing critical protections

keyTerms should include: monthly rent, lease term, security deposit, late fee, notice period, pet policy, utilities, maintenance responsibility, early termination penalty, and any other financially significant terms found.

redFlags should be specific and actionable — cite the problematic clause, explain the risk, and reference applicable law where relevant. Aim for 3-7 red flags.

missingClauses should identify protections or disclosures that are standard or legally required for the jurisdiction but absent from this contract. Aim for 3-6 missing clauses.

Be thorough, accurate, and professional. Your analysis may be the only legal review this person gets before signing.`;

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: 'Analyze this lease agreement and return the JSON analysis:\n\n' + contractText.slice(0, 20000)
      }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', c => { data += c; });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return res.status(500).json({ error: parsed.error.message });
          const text = parsed.content[0].text.replace(/```json|```/g, '').trim();
          res.status(200).json(JSON.parse(text));
        } catch(e) {
          res.status(500).json({ error: 'Parse error', raw: data.slice(0, 500) });
        }
      });
    });

    apiReq.on('error', (e) => {
      res.status(500).json({ error: e.message });
    });

    apiReq.write(payload);
    apiReq.end();
  });
};
