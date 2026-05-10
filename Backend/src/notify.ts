/**
 * Minimal "notify me when this ships" capture.
 *
 * The web app and the desktop news posts both reference an upcoming
 * weekly digest email. Until that pipeline is built we want a real
 * place to capture intent — promising a newsletter and providing no
 * way to sign up was the worst of both worlds (users told us as much).
 *
 * Storage: KV under `notify:<topic>:<emailLower>`. Idempotent — a
 * repeat signup overwrites the timestamp instead of duplicating. Each
 * record stores the email, the topic ("digest" today; "lobbies",
 * "mobile" tomorrow), the source surface (web/desktop), and a
 * client-IP hash so we can spot abuse without retaining raw IPs.
 *
 * No email is ever sent from this endpoint; no third-party vendor
 * is in the loop. When the digest is ready we read the KV list and
 * import it into whatever ESP we settle on (likely Buttondown).
 */

import type { Env } from "./types";
import { checkAndConsume, clientIP, hashID } from "./ratelimit";

interface StoredSignup {
  email: string;
  topic: string;
  source: string;
  ipHash: string;
  createdAt: string;
  updatedAt: string;
}

const VALID_TOPICS = new Set(["digest", "lobbies", "mobile", "general"]);

/** Liberal email regex — good enough for "is this a typo or a real
 *  address?" not RFC-strict. We accept what the browser would, then
 *  bounce the obvious noise (no @, no dot, control chars). */
function isPlausibleEmail(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  if (/[\s\u0000-\u001f]/.test(trimmed)) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
}

export async function handleNotifySignup(req: Request, env: Env): Promise<Response> {
  // Rate-limit at the IP layer — not steam-id, because this endpoint
  // is intentionally available to guests. 6/hour/IP is enough for
  // "shared computer in a coffee shop" without becoming a spam vector.
  const ipHash = await hashID(clientIP(req));
  const limited = await checkAndConsume(env, {
    bucket: "notify-signup-ip",
    id: ipHash,
    max: 6,
    windowSeconds: 60 * 60,
  });
  if (!limited.allowed) {
    return new Response(
      JSON.stringify({ error: "rate_limited", retry_after_sec: limited.retryAfterSec }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(limited.retryAfterSec) } }
    );
  }

  const body = await req.json().catch(() => null) as { email?: unknown; topic?: unknown; source?: unknown } | null;
  if (!body) {
    return new Response(JSON.stringify({ error: "bad_request" }),
      { status: 400, headers: { "content-type": "application/json" } });
  }

  if (!isPlausibleEmail(body.email)) {
    return new Response(JSON.stringify({ error: "invalid_email" }),
      { status: 400, headers: { "content-type": "application/json" } });
  }
  const email = (body.email as string).trim().toLowerCase();

  const topicRaw = typeof body.topic === "string" ? body.topic.trim().toLowerCase() : "general";
  const topic = VALID_TOPICS.has(topicRaw) ? topicRaw : "general";

  const sourceRaw = typeof body.source === "string" ? body.source.trim().toLowerCase() : "";
  const source = sourceRaw.replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "web";

  const key = `notify:${topic}:${email}`;
  const existingRaw = await env.LOBBIES.get(key);
  const now = new Date().toISOString();
  const record: StoredSignup = existingRaw
    ? { ...(JSON.parse(existingRaw) as StoredSignup), updatedAt: now, source, ipHash }
    : { email, topic, source, ipHash, createdAt: now, updatedAt: now };

  // 2 year TTL — the digest will either ship before then or this list
  // is dead anyway. Storing forever is just slow leak.
  await env.LOBBIES.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 * 2 });

  return new Response(
    JSON.stringify({ ok: true, topic, alreadySubscribed: !!existingRaw }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
