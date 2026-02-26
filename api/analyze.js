module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { contractText } = req.body;

  if (!contractText || contractText.trim().length < 50) {
    return res.status(400).json({ error: 'Contract text too short' });
  }

  const systemPrompt = `You are a rental/lease contract analyst. Analyze the provided lease or rental agreement and return a JSON object with the following structure:

{
  "summary": "A 3-4 sentence plain English summary of the overall contract.",
  "score": "good|warn|bad",
  "scoreLabel": "Tenant-Friendly|Review Carefully|Concerning",
  "keyTerms": [
    {"label": "Monthly Rent", "value": "$X"},
    {"label": "Lease Term", "value": "X months"},
    {"label": "Security Deposit", "value": "$X"},
    {"label": "Move-in Date", "value": "..."},
    {"label": "Late Fee", "value": "..."},
    {"label": "Pet Policy", "value": "..."}
  ],
  "redFlags": [
    "Description of red flag 1",
    "Description of red flag 2"
  ],
  "missingClauses": [
    "Description of missing or vague clause 1",
    "Description of missing or vague clause 2"
  ]
}

Be thorough but concise. Red flags are clauses that are unusual, one-sided, or could harm the tenant. Missing clauses are standard protections that should be in every lease but aren't clearly stated. Return ONLY valid JSON, no other text.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Analyze this lease agreement:\n\n${contractText.slice(0, 12000)}` }]
      })
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
}
