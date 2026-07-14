// Rate limiting for widget ingest endpoints.
//
// Two layers, applied in order:
//   1. Per-IP token bucket (in-memory). 60 req/min, refills 1/sec. Defense
//      against a single host flooding the API.
//   2. Per-app daily budget (DB-backed, DailyIngest table). Enforces
//      per-tenant ceilings configured on Apps.daily_budget.
//
// The IP bucket is the same shape as skateboard's login-lockout map in
// server.ts — in-memory Map, periodic cleanup of idle entries.

import type { Context, MiddlewareHandler } from 'hono';
import type { DatabaseSync } from 'node:sqlite';

const IP_BUCKET_CAPACITY = 60;        // tokens
const IP_BUCKET_REFILL_PER_SEC = 1;   // = 60/min sustained
const IP_BUCKET_IDLE_MS = 10 * 60 * 1000; // 10 min idle eviction

/** One caller's token-bucket state, keyed by IP in {@link ipBuckets}. */
interface IpBucket {
  /** Fractional tokens available; refills over time, debited per request. */
  tokens: number;
  /** Unix timestamp (ms) of the last refill/touch. */
  lastRefill: number;
}

/** In-memory per-IP token buckets. ip -> bucket. */
const ipBuckets = new Map<string, IpBucket>();

// Janitor: prune idle buckets every 5 min. Keeps memory bounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipBuckets) {
    if (now - b.lastRefill > IP_BUCKET_IDLE_MS) ipBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

/**
 * Best-effort caller IP. Honors X-Forwarded-For (Railway adds it), else
 * falls back to socket address. Spoofable behind a non-proxy host — accept
 * that, it's hygiene.
 */
function getCallerIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp.trim();
  // c.env is provider-specific (unknown shape); read remoteAddr defensively.
  const env: unknown = c.env;
  if (env && typeof env === 'object' && 'remoteAddr' in env) {
    const remoteAddr = env.remoteAddr;
    if (typeof remoteAddr === 'string') return remoteAddr;
  }
  return 'unknown';
}

/** Result of a token-bucket check: whether the request is allowed. */
interface ConsumeResult {
  allowed: boolean;
  /** Seconds the caller should wait before retrying (only when blocked). */
  retryAfterSeconds?: number;
}

/**
 * Returns { allowed, retryAfterSeconds }. If allowed, also debits 1 token.
 */
function tryConsumeIpToken(ip: string): ConsumeResult {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: IP_BUCKET_CAPACITY, lastRefill: now };
    ipBuckets.set(ip, bucket);
  }
  // Refill since last touch.
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(
    IP_BUCKET_CAPACITY,
    bucket.tokens + elapsedSec * IP_BUCKET_REFILL_PER_SEC
  );
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }
  // How many seconds until next token?
  const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / IP_BUCKET_REFILL_PER_SEC));
  return { allowed: false, retryAfterSeconds };
}

/**
 * Hono middleware: per-IP token bucket on widget ingest routes.
 */
export function ipRateLimit(): MiddlewareHandler {
  return async (c, next) => {
    const ip = getCallerIp(c);
    const { allowed, retryAfterSeconds } = tryConsumeIpToken(ip);
    if (!allowed) {
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
    return next();
  };
}

/**
 * Return today's date as 'YYYY-MM-DD' in UTC.
 */
function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Read a numeric column off a node:sqlite row without an `as` cast.
 * Returns `fallback` when the value is absent or non-numeric.
 */
function numberColumn(
  row: Record<string, unknown> | undefined,
  column: string,
  fallback: number
): number {
  const value = row?.[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

/**
 * Atomically bump the DailyIngest counter for an app and return the new count.
 * Increments first, then the caller decides whether to reject.
 *
 * @returns new daily count after increment
 */
export function bumpDailyIngest(db: DatabaseSync, appId: string): number {
  const day = utcDayKey();
  // node:sqlite RETURNING support is available in modern Node; fall back
  // gracefully if not (do a follow-up SELECT).
  try {
    const row = db.prepare(
      `INSERT INTO DailyIngest (app_id, day_utc, count) VALUES (?, ?, 1)
       ON CONFLICT(app_id, day_utc) DO UPDATE SET count = count + 1
       RETURNING count`
    ).get(appId, day);
    return numberColumn(row, 'count', 1);
  } catch {
    db.prepare(
      `INSERT INTO DailyIngest (app_id, day_utc, count) VALUES (?, ?, 1)
       ON CONFLICT(app_id, day_utc) DO UPDATE SET count = count + 1`
    ).run(appId, day);
    const r = db.prepare(
      'SELECT count FROM DailyIngest WHERE app_id = ? AND day_utc = ?'
    ).get(appId, day);
    return numberColumn(r, 'count', 1);
  }
}

/**
 * Returns a 429 Response if the app is over its daily budget; otherwise
 * increments and returns null (request allowed).
 *
 * @returns 429 response if over budget, else null
 */
export function enforceAppBudget(
  db: DatabaseSync,
  appId: string,
  dailyBudget: number,
  c: Context
): Response | null {
  const newCount = bumpDailyIngest(db, appId);
  if (newCount > dailyBudget) {
    // Compute seconds until next UTC midnight for Retry-After.
    const now = new Date();
    const tomorrow = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
    ));
    const retry = Math.max(60, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
    c.header('Retry-After', String(retry));
    return c.json({ error: 'daily budget exceeded' }, 429);
  }
  return null;
}
