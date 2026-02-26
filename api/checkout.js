const https = require('https');

module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let plan = 'basic';
    try { plan = JSON.parse(body).plan || 'basic'; } catch(e) {}

    const origin = req.headers.origin || 'https://analyzethiscontract.com';
    const successUrl = `${origin}?session_id={CHECKOUT_SESSION_ID}&paid=true&plan=${plan}`;
    const cancelUrl = `${origin}?cancelled=true`;

    const isPro = plan === 'pro';

    const params = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': isPro ? 'AnalyzeThisContract Pro' : 'AnalyzeThisContract Basic',
      'line_items[0][price_data][product_data][description]': isPro ? 'Unlimited contract analyses per month' : '5 contract analyses',
      'line_items[0][price_data][unit_amount]': isPro ? '999' : '499',
      'line_items[0][price_data][recurring][interval]': isPro ? 'month' : '',
      'line_items[0][quantity]': '1',
      'mode': isPro ? 'subscription' : 'payment',
      'success_url': successUrl,
      'cancel_url': cancelUrl,
    });

    // Remove empty recurring interval for one-time payment
    if (!isPro) params.delete('line_items[0][price_data][recurring][interval]');

    const paramStr = params.toString();

    const options = {
      hostname: 'api.stripe.com',
      path: '/v1/checkout/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(paramStr)
      }
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', c => { data += c; });
      apiRes.on('end', () => {
        try {
          const session = JSON.parse(data);
          if (session.error) return res.status(500).json({ error: session.error.message });
          res.status(200).json({ url: session.url });
        } catch(e) {
          res.status(500).json({ error: 'Failed to create checkout session' });
        }
      });
    });

    apiReq.on('error', (e) => res.status(500).json({ error: e.message }));
    apiReq.write(paramStr);
    apiReq.end();
  });
};
