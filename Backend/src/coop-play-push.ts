/**
 * Web Push for co-op Play, using WebCrypto only (the `web-push` npm package
 * needs Node's https/crypto modules, which the Worker runtime doesn't offer).
 *
 * Pushes carry no payload. That skips RFC 8291 message encryption entirely:
 * the browser wakes the service worker (Web/sw.js), which fetches
 * /api/coop/play with the user's own cookie and writes the notification from
 * the answer. Only the VAPID signature (RFC 8292) is needed here.
 *
 * Secrets (set with `wrangler secret put`, generate with
 * `node scripts/gen-vapid.mjs`):
 *   VAPID_PUBLIC_KEY   base64url, 65-byte uncompressed P-256 point
 *   VAPID_PRIVATE_JWK  the matching private key as a JSON Web Key
 */

import type { Env } from "./types";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
  savedAt: string;
}

export type PushOutcome = "sent" | "gone" | "failed" | "disabled";

/** The JWT `sub` claim must be a mailto: or https: URL; never a personal address. */
const VAPID_SUBJECT = "https://spirevault.app";
const PUSH_TTL_SECONDS = 600;
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

/** Only real push services may be called, so a stored endpoint can't be used for SSRF. */
const ALLOWED_PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
  /^push\.services\.mozilla\.com$/,
];

export function isAllowedPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 1024) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && ALLOWED_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export function pushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK);
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

let cachedKey: { jwk: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<CryptoKey> {
  const jwkText = env.VAPID_PRIVATE_JWK ?? "";
  if (cachedKey && cachedKey.jwk === jwkText) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(jwkText) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  cachedKey = { jwk: jwkText, key };
  return key;
}

async function vapidAuthorization(env: Env, endpoint: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = b64urlText(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64urlText(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME_SECONDS,
      sub: VAPID_SUBJECT,
    }),
  );
  const unsigned = `${header}.${claims}`;
  // WebCrypto returns ECDSA signatures as raw r||s (IEEE P1363), which is
  // exactly the JOSE ES256 format.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(env),
    new TextEncoder().encode(unsigned),
  );
  return `vapid t=${unsigned}.${b64url(new Uint8Array(sig))}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Send one empty push. 404/410 mean the subscription is dead and should be dropped. */
export async function sendPush(env: Env, sub: PushSubscriptionRecord): Promise<PushOutcome> {
  if (!pushConfigured(env)) return "disabled";
  if (!isAllowedPushEndpoint(sub.endpoint)) return "gone";
  try {
    const resp = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(env, sub.endpoint),
        ttl: String(PUSH_TTL_SECONDS),
        urgency: "high",
        "content-length": "0",
      },
    });
    if (resp.status === 404 || resp.status === 410) return "gone";
    if (!resp.ok) {
      console.warn(`[coop-play] push failed status=${resp.status}`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.warn(`[coop-play] push threw: ${(err as Error)?.message ?? err}`);
    return "failed";
  }
}
