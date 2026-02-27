const https = require('https');

function supabaseReq(path, method, body, token, isService) {
  return new Promise((resolve, reject) => {
    const useService = isService || !token;
    const data = (method === 'GET' || method === 'DELETE') ? '' : JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json',
      'apikey': useService ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${useService ? process.env.SUPABASE_SERVICE_KEY : token}`,
      'Prefer': 'return=representation'
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const options = { hostname: 'gbzyzsxuxwmdlzagkrvt.supabase.co', path, method, headers };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (!d || d.trim() === '') return resolve([]);
        try { resolve(JSON.parse(d)); } catch(e) { resolve({ error: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getUser(token) {
  const r = await supabaseReq('/auth/v1/user', 'GET', null, token, false);
  if (!r || r.error || !r.id) return null;
  return r;
}

async function getUserPlan(userId) {
  const r = await supabaseReq(`/rest/v1/user_credits?user_id=eq.${userId}&select=plan,credits`, 'GET', null, null, true);
  if (Array.isArray(r) && r.length > 0) return r[0];
  return { plan: 'free', credits: 0 };
}

function detectContractName(text) {
  if (!text) return null;
  const snippet = text.slice(0, 800);
  // Try to find address pattern
  const addrMatch = snippet.match(/\d+\s+[A-Za-z0-9\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Blvd|Way|Court|Ct)[,.]?\s*(?:[A-Za-z\s]+,\s*[A-Z]{2})?/i);
  if (addrMatch) return addrMatch[0].trim().slice(0, 60);
  // Try "between X and Y" party names
  const partyMatch = snippet.match(/between\s+([A-Z][a-zA-Z\s,\.]+?)\s+(?:and|&)\s+([A-Z][a-zA-Z\s,\.]+?)(?:\s*,|\s*\(|\s*herein)/i);
  if (partyMatch) return `${partyMatch[1].trim()} / ${partyMatch[2].trim()}`.slice(0, 60);
  // Try lease/agreement title
  const titleMatch = snippet.match(/(?:LEASE|RENTAL|TENANCY)\s+AGREEMENT\s+(?:FOR|AT|-)?\s*(.{5,50}?)(?:\n|,|\.|$)/i);
  if (titleMatch) return titleMatch[0].trim().slice(0, 60);
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    try {
      const { action, token, analysisData, contractText, analysisId, newName } = JSON.parse(body);

      if (!token) return res.status(401).json({ error: 'Not authenticated' });
      const user = await getUser(token);
      if (!user) return res.status(401).json({ error: 'Invalid token' });

      const planInfo = await getUserPlan(user.id);
      const isPaid = planInfo.plan === 'pro' || planInfo.plan === 'basic';

      // ── SAVE ──────────────────────────────────────────────
      if (action === 'save') {
        if (!isPaid) return res.status(403).json({ error: 'Paid plan required to save analyses' });
        if (!analysisData) return res.status(400).json({ error: 'No analysis data' });

        const contractName = detectContractName(contractText) || ('Contract – ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));

        const row = {
          user_id: user.id,
          contract_name: contractName,
          score: analysisData.score || 'warn',
          score_label: analysisData.scoreLabel || '',
          plan_at_save: planInfo.plan,
          analysis_json: JSON.stringify(analysisData),
          created_at: new Date().toISOString()
        };

        const saved = await supabaseReq('/rest/v1/analyses', 'POST', row, null, true);
        if (saved && saved.error) return res.status(500).json({ error: saved.error });
        return res.status(200).json({ success: true, id: Array.isArray(saved) ? saved[0]?.id : saved?.id, contractName });
      }

      // ── LIST ──────────────────────────────────────────────
      if (action === 'list') {
        if (!isPaid) return res.status(200).json({ analyses: [], locked: true });
        const rows = await supabaseReq(
          `/rest/v1/analyses?user_id=eq.${user.id}&select=id,contract_name,score,score_label,plan_at_save,created_at&order=created_at.desc`,
          'GET', null, null, true
        );
        return res.status(200).json({ analyses: Array.isArray(rows) ? rows : [], plan: planInfo.plan });
      }

      // ── GET SINGLE ────────────────────────────────────────
      if (action === 'get') {
        if (!analysisId) return res.status(400).json({ error: 'No analysisId' });
        const rows = await supabaseReq(
          `/rest/v1/analyses?id=eq.${analysisId}&user_id=eq.${user.id}&select=*`,
          'GET', null, null, true
        );
        if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: 'Not found' });
        const row = rows[0];
        let analysisJson;
        try { analysisJson = JSON.parse(row.analysis_json); } catch(e) { analysisJson = {}; }
        return res.status(200).json({ ...row, analysisData: analysisJson });
      }

      // ── RENAME ────────────────────────────────────────────
      if (action === 'rename') {
        if (!analysisId || !newName) return res.status(400).json({ error: 'Missing fields' });
        await supabaseReq(
          `/rest/v1/analyses?id=eq.${analysisId}&user_id=eq.${user.id}`,
          'PATCH', { contract_name: newName.slice(0, 80) }, null, true
        );
        return res.status(200).json({ success: true });
      }

      // ── DELETE ────────────────────────────────────────────
      if (action === 'delete') {
        if (!analysisId) return res.status(400).json({ error: 'Missing analysisId' });
        await supabaseReq(
          `/rest/v1/analyses?id=eq.${analysisId}&user_id=eq.${user.id}`,
          'DELETE', null, null, true
        );
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Invalid action' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  });
};
