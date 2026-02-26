const https = require('https');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    
    // Build success and cancel URLs
    const origin = req.headers.origin || 'https://analyzethiscontract.com';
    const successUrl = `${origin}?session_id={CHECKOUT_SESSION_ID}&paid=true`;
    const cancelUrl = `${origin}?cancelled=true`;

    const params = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'Contract Analysis',
      'line_items[0][price_data][product_data][description]': '5 contract analyses',
      'line_items[0][price_data][unit_amount]': '499',
      'line_items[0][quantity]': '1',
      'mode': 'payment',
      'success_url': successUrl,
      'cancel_url': cancelUrl,
    }).toString();

    const options = {
      hostname: 'api.stripe.com',
      path: '/v1/checkout/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
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

    apiReq.on('error', (e) => {
      res.status(500).json({ error: e.message });
    });

    apiReq.write(params);
    apiReq.end();
  });
};
