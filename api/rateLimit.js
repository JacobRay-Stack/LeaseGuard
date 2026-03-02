// ── api/rateLimit.js ───────────────────────────────────────────────────
// Lightweight in-memory IP rate limiter. No npm packages.
// Resets automatically — each IP gets a sliding window of attempts.
//
// Usage:
//   const { rateLimit } = require('./rateLimit');
//   const result = rateLimit(req, { windowMs: 60_000, max: 10 });
//   if (!result.ok) return res.status(429).json({ error: result.error });

const store = new Map(); // ip -> { count, resetAt }

// Clean up stale entries every 5 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (val.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * @param {object} req - Vercel/Node IncomingMessage
 * @param {object} options
 * @param {number} options.windowMs  - Window size in ms (e.g. 60_000 = 1 min)
 * @param {number} options.max       - Max requests per window per IP
 * @param {string} [options.label]   - Label for logging
 * @returns {{ ok: boolean, error?: string, remaining?: number }}
 */
function rateLimit(req, { windowMs, max, label = 'endpoint' }) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  const key = `${label}:${ip}`;
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }

  entry.count += 1;

  if (entry.count > max) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    console.warn(`[rateLimit] ${label} — IP ${ip} exceeded ${max} req/${windowMs}ms`);
    return {
      ok: false,
      error: `Too many requests. Please wait ${retryAfterSec} seconds and try again.`,
      retryAfter: retryAfterSec,
    };
  }

  return { ok: true, remaining: max - entry.count };
}

module.exports = { rateLimit };
