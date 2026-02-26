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

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: 'You are a lease analyst. Return ONLY a JSON object with keys: summary, score (good/warn/bad), scoreLabel, keyTerms (array of {label,value}), redFlags (array of strings), missingClauses (array of strings).',
      messages: [{ role: 'user', content: 'Analyze this lease:\n\n' + contractText.slice(0, 8000) }]
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
