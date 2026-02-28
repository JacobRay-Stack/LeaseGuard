// ── email.js — Resend email helper ────────────────────────────────────
// Used by auth.js (welcome email) and Webhook.js (payment/cancellation emails)
// No npm packages — uses only Node.js built-in https module.

const https = require('https');

const FROM_ADDRESS = 'AnalyzeThisContract <hello@analyzethiscontract.com>';
const SITE_URL = 'https://analyzethiscontract.com';

// ── Low-level send ─────────────────────────────────────────────────────
function sendEmail({ to, subject, html }) {
  return new Promise((resolve, reject) => {
    if (!process.env.RESEND_API_KEY) {
      console.warn('[email] RESEND_API_KEY not set — skipping email to', to);
      return resolve({ skipped: true });
    }

    const body = JSON.stringify({ from: FROM_ADDRESS, to, subject, html });

    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { resolve({ _raw: d }); }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Email templates ────────────────────────────────────────────────────

function welcomeEmail(to) {
  return sendEmail({
    to,
    subject: 'Welcome to AnalyzeThisContract 👋',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:12px;overflow:hidden;max-width:560px;width:100%;">
        <!-- Header -->
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:22px;font-weight:700;color:#f0ece3;letter-spacing:-0.3px;">
              Analyze<span style="color:#e8c96d;">This</span>Contract
            </p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 40px;">
            <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#f0ece3;line-height:1.3;">
              You're in. Let's protect you. ⚖️
            </h1>
            <p style="margin:0 0 20px;font-size:15px;color:#9090b0;line-height:1.7;">
              You now have <strong style="color:#e8c96d;">3 free contract analyses</strong> ready to use. 
              Drop any lease or contract and get an instant plain-English breakdown — 
              red flags, missing clauses, and negotiation tips included.
            </p>
            <!-- CTA -->
            <table cellpadding="0" cellspacing="0" style="margin:28px 0;">
              <tr>
                <td style="background:#e8c96d;border-radius:8px;">
                  <a href="${SITE_URL}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#1a1a2e;text-decoration:none;">
                    Analyze a Contract →
                  </a>
                </td>
              </tr>
            </table>
            <!-- Features -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:16px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.07);">
                  <p style="margin:0 0 10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#e8c96d;">What you get</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">🚩 &nbsp;Red flags identified with plain explanations</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">🔍 &nbsp;Missing clauses that could hurt you</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">💬 &nbsp;Negotiation tips you can actually use</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">📋 &nbsp;Key terms extracted in seconds</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:12px;color:#555577;line-height:1.6;">
              AnalyzeThisContract is not a law firm and does not provide legal advice. 
              Always consult a qualified attorney for legal matters.<br><br>
              <a href="${SITE_URL}" style="color:#555577;">${SITE_URL}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

function paymentConfirmationEmail(to, plan) {
  const isPro = plan === 'pro';
  return sendEmail({
    to,
    subject: isPro
      ? '✅ Pro plan activated — unlimited analyses ready'
      : '✅ Payment confirmed — your 5 analyses are ready',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:12px;overflow:hidden;max-width:560px;width:100%;">
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:22px;font-weight:700;color:#f0ece3;">
              Analyze<span style="color:#e8c96d;">This</span>Contract
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <p style="margin:0 0 8px;font-size:32px;">✅</p>
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#f0ece3;line-height:1.3;">
              ${isPro ? 'Pro plan activated!' : 'Payment confirmed!'}
            </h1>
            <p style="margin:0 0 24px;font-size:15px;color:#9090b0;line-height:1.7;">
              ${isPro
                ? 'You now have <strong style="color:#e8c96d;">unlimited contract analyses</strong> every month, plus PDF export, analysis history, and priority support.'
                : 'You now have <strong style="color:#e8c96d;">5 contract analyses</strong> ready to use. They never expire.'}
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#e8c96d;border-radius:8px;">
                  <a href="${SITE_URL}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#1a1a2e;text-decoration:none;">
                    Start Analyzing →
                  </a>
                </td>
              </tr>
            </table>
            ${isPro ? `
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:16px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.07);">
                  <p style="margin:0 0 10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#e8c96d;">Pro includes</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">♾️ &nbsp;Unlimited analyses every month</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">📁 &nbsp;Saved analysis history</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">⬇️ &nbsp;PDF export</p>
                  <p style="margin:4px 0;font-size:14px;color:#9090b0;">💬 &nbsp;Negotiation tips & missing clauses</p>
                </td>
              </tr>
            </table>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:12px;color:#555577;line-height:1.6;">
              Questions? Reply to this email.<br>
              AnalyzeThisContract is not a law firm and does not provide legal advice.<br>
              <a href="${SITE_URL}" style="color:#555577;">${SITE_URL}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

function cancellationEmail(to) {
  return sendEmail({
    to,
    subject: 'Your Pro subscription has been cancelled',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:12px;overflow:hidden;max-width:560px;width:100%;">
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:22px;font-weight:700;color:#f0ece3;">
              Analyze<span style="color:#e8c96d;">This</span>Contract
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#f0ece3;line-height:1.3;">
              Your Pro subscription has ended
            </h1>
            <p style="margin:0 0 20px;font-size:15px;color:#9090b0;line-height:1.7;">
              We've cancelled your Pro subscription as requested. Your account has been moved back to the free plan.
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#9090b0;line-height:1.7;">
              Changed your mind? You can resubscribe anytime — all your saved analyses are still there waiting for you.
            </p>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#e8c96d;border-radius:8px;">
                  <a href="${SITE_URL}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#1a1a2e;text-decoration:none;">
                    Resubscribe →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:12px;color:#555577;line-height:1.6;">
              Questions? Reply to this email and we'll help.<br>
              <a href="${SITE_URL}" style="color:#555577;">${SITE_URL}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

function lastCreditEmail(to) {
  return sendEmail({
    to,
    subject: '⚠️ You just used your last free analysis',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:12px;overflow:hidden;max-width:560px;width:100%;">
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:22px;font-weight:700;color:#f0ece3;">
              Analyze<span style="color:#e8c96d;">This</span>Contract
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <p style="margin:0 0 8px;font-size:32px;">⚠️</p>
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#f0ece3;line-height:1.3;">
              You've used all 3 free analyses
            </h1>
            <p style="margin:0 0 20px;font-size:15px;color:#9090b0;line-height:1.7;">
              Don't stop now — upgrade to keep protecting yourself from bad contracts.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td width="48%" style="padding:16px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.07);vertical-align:top;">
                  <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#9090b0;">Basic</p>
                  <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#f0ece3;">$4.99 <span style="font-size:13px;font-weight:400;color:#9090b0;">one-time</span></p>
                  <p style="margin:4px 0;font-size:13px;color:#9090b0;">✓ 5 analyses</p>
                  <p style="margin:4px 0;font-size:13px;color:#9090b0;">✓ Never expire</p>
                </td>
                <td width="4%"></td>
                <td width="48%" style="padding:16px;background:rgba(232,201,109,0.08);border-radius:8px;border:1px solid rgba(232,201,109,0.25);vertical-align:top;">
                  <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#e8c96d;">Pro — Best Value</p>
                  <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#f0ece3;">$9.99 <span style="font-size:13px;font-weight:400;color:#9090b0;">/mo</span></p>
                  <p style="margin:4px 0;font-size:13px;color:#9090b0;">✓ Unlimited</p>
                  <p style="margin:4px 0;font-size:13px;color:#9090b0;">✓ History + PDF</p>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#e8c96d;border-radius:8px;">
                  <a href="${SITE_URL}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#1a1a2e;text-decoration:none;">
                    Upgrade Now →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.08);">
            <p style="margin:0;font-size:12px;color:#555577;line-height:1.6;">
              AnalyzeThisContract is not a law firm and does not provide legal advice.<br>
              <a href="${SITE_URL}" style="color:#555577;">${SITE_URL}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

module.exports = { sendEmail, welcomeEmail, paymentConfirmationEmail, cancellationEmail, lastCreditEmail };
