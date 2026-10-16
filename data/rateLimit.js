'use strict';
// Minimal in-memory sliding-window rate limiter for a handful of public,
// unauthenticated endpoints (loyalty lookup, feedback, onboarding) that had
// no throttling at all. No external dependency — single-process deployment,
// so an in-memory Map is enough; resets on restart, which only ever makes a
// limit MORE permissive for a moment, never less safe.

const buckets = new Map();
let limiterCount = 0;

function rateLimit({ windowMs = 60000, max = 20, keyFn, message } = {}) {
  // Each limiter counts on its own: without this prefix, every limiter keyed by IP shared one
  // counter, so e.g. a few password-reset tries blocked a signup from the same connection.
  const ns = 'L' + (++limiterCount) + ':';
  return (req, res, next) => {
    const key = ns + ((keyFn ? keyFn(req) : req.ip) || 'unknown');
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: message || 'Too many requests. Please try again in a minute.' });
    }
    next();
  };
}

// Periodic sweep so the Map doesn't grow unbounded on a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.start > 10 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = { rateLimit };
