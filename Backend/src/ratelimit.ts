import type { Env } from "./types";

/**
 * Tiny KV-backed sliding-window rate limiter.
 *
 * One key per limited identity (`rl:<bucket>:<id>`), value is a JSON list of
 * the ISO timestamps for allowed events inside the current window. On each
 * call we read the list, drop any entries older than `windowSeconds`, decide,
 * and only write back if we're admitting a new event.
 *
 * Cost per request:
 *   - allowed:    1 read + 1 write  (write only when we accept)
 *   - rejected:   1 read            (no write — saves the scarce write quota)
 *   - first-ever: 0 reads (KV miss is a free-ish ~no-op) + 1 write
 *
 * For 1k-5k daily writes this is a perfectly fine spam control. For
 * higher-traffic surfaces (hundreds of writes/sec) we'd switch to Durable
 * Objects or Cloudflare's native zone-level rate limiting, which doesn't
 * touch our KV quota at all.
 *
 * IMPORTANT: keep the per-key list bounded. We trim to `max + 1` entries on
 * write so a malicious caller can't grow it indefinitely.
 */

export interface RateLimitConfig {
  /** Bucket name, e.g. "invites-sender" — namespaces the KV key. */
  bucket: string;
  /** Identity within the bucket, e.g. SteamID or IP hash. */
  id: string;
  /** Max events allowed inside `windowSeconds`. */
  max: number;
  /** Sliding window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;     // ISO of the oldest event that would need to expire to free a slot
  retryAfterSec: number;
}

export async function checkAndConsume(
  env: Env,
  cfg: RateLimitConfig
): Promise<RateLimitResult> {
  const key = `rl:${cfg.bucket}:${cfg.id}`;
  const now = Date.now();
  const cutoff = now - cfg.windowSeconds * 1000;

  let stamps: number[] = [];
  const raw = await env.LOBBIES.get(key);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        stamps = arr.filter((t) => typeof t === "number" && t >= cutoff);
      }
    } catch { /* corrupt → treat as empty */ }
  }

  if (stamps.length >= cfg.max) {
    const oldest = Math.min(...stamps);
    const resetAtMs = oldest + cfg.windowSeconds * 1000;
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(resetAtMs).toISOString(),
      retryAfterSec: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  // Admit and record. Cap stored list at `max + 1` so the value never grows.
  stamps.push(now);
  if (stamps.length > cfg.max + 1) stamps = stamps.slice(-cfg.max - 1);
  await env.LOBBIES.put(key, JSON.stringify(stamps), {
    // Auto-expire one full window after the most recent event so abandoned
    // identities clean themselves up without us walking the namespace.
    expirationTtl: cfg.windowSeconds + 60,
  });

  return {
    allowed: true,
    remaining: Math.max(0, cfg.max - stamps.length),
    resetAt: new Date(now + cfg.windowSeconds * 1000).toISOString(),
    retryAfterSec: 0,
  };
}

/**
 * SHA-256 hex digest of an arbitrary string. We hash IPs before keying
 * `rl:ip:*` so the KV namespace doesn't carry raw client IPs around.
 * (We also never log them — see the privacy promise in SECURITY.md.)
 */
export async function hashID(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Pull the caller's IP from CF's request headers. Returns "" if unknown. */
export function clientIP(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    ""
  );
}
