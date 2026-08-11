// ============================================================
//  Rate limiter — simple in-memory rate limiting (Bug #10)
//  For production: use Redis-backed rate limiter (e.g. @upstash/ratelimit)
//  For now: in-memory Map with sliding window
// ============================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitEntry>();

// Cleanup expired entries periodically (every 60s)
let lastCleanup = Date.now();
function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, entry] of buckets) {
    if (now > entry.resetAt) buckets.delete(key);
  }
}

/**
 * Check rate limit. Returns { allowed, remaining, resetAt }
 * @param key — unique key (e.g. IP + endpoint)
 * @param maxRequests — max requests in window
 * @param windowMs — window in milliseconds
 */
export function rateLimit(key: string, maxRequests: number, windowMs: number): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  cleanup();
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now > entry.resetAt) {
    // New window
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: maxRequests - 1, resetAt };
  }

  entry.count++;
  const allowed = entry.count <= maxRequests;
  return {
    allowed,
    remaining: Math.max(0, maxRequests - entry.count),
    resetAt: entry.resetAt,
  };
}

/**
 * Get client IP from NextRequest (handles Vercel proxy)
 */
export function getClientIP(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = req.headers.get('x-real-ip');
  if (xri) return xri;
  return 'unknown';
}

// ============================================================
//  Predefined rate limit configs
// ============================================================
export const RATE_LIMITS = {
  // Analysis: 60 req/min per IP (dashboard polling)
  analysis: { maxRequests: 60, windowMs: 60_000 },
  // Status: 30 req/min per IP
  status: { maxRequests: 30, windowMs: 60_000 },
  // Ingest: 5 req/min per IP (heavy operation)
  ingest: { maxRequests: 5, windowMs: 60_000 },
  // Import-drive: 3 req/min per IP (very heavy)
  importDrive: { maxRequests: 3, windowMs: 60_000 },
  // Settings: 10 req/min per IP
  settings: { maxRequests: 10, windowMs: 60_000 },
  // Setup: 2 req/min per IP (destructive)
  setup: { maxRequests: 2, windowMs: 60_000 },
} as const;
