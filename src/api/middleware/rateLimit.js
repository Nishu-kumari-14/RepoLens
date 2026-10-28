/**
 * In-memory sliding window rate limiter.
 * Zero-cost stack: does not require Redis or external infrastructure.
 */

/**
 * Creates a rate limiting middleware.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs=60000] Time window in ms (default 1 minute)
 * @param {number} [options.max=60] Max requests per IP in the window
 * @returns {Function} Express middleware
 */
export function createRateLimiter({ windowMs = 60000, max = 60 } = {}) {
  const ipHits = new Map();

  // Periodically clean up stale entries to prevent memory growth
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of ipHits.entries()) {
      const recent = timestamps.filter((t) => now - t < windowMs);
      if (recent.length === 0) {
        ipHits.delete(ip);
      } else {
        ipHits.set(ip, recent);
      }
    }
  }, windowMs);

  // Unref so the interval doesn't hold open test runs
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
    const now = Date.now();

    const timestamps = ipHits.get(ip) || [];
    const validTimestamps = timestamps.filter((t) => now - t < windowMs);

    if (validTimestamps.length >= max) {
      const oldestHit = validTimestamps[0];
      const retryAfterSeconds = Math.ceil((windowMs - (now - oldestHit)) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: `Rate limit exceeded. Maximum ${max} requests per minute allowed. Try again in ${retryAfterSeconds}s.`,
      });
    }

    validTimestamps.push(now);
    ipHits.set(ip, validTimestamps);
    next();
  };
}

export const defaultRateLimiter = createRateLimiter();
