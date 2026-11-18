#!/usr/bin/env node
/**
 * Generates a VAPID key pair for co-op Play pings (src/coop-play-push.ts).
 *
 *   node scripts/gen-vapid.mjs
 *   node scripts/gen-vapid.mjs --json | npx --yes wrangler@4 secret bulk --config wrangler.toml
 *
 * --json prints {"VAPID_PUBLIC_KEY": ..., "VAPID_PRIVATE_JWK": ...} for
 * `wrangler secret bulk`, so the private key goes straight to the Worker
 * and is never shown on screen. Check `wrangler secret list` first: if
 * VAPID_PUBLIC_KEY is already set, do not run it again.
 *
 * Prints the two values to set as Worker secrets:
 *   npx wrangler secret put VAPID_PUBLIC_KEY
 *   npx wrangler secret put VAPID_PRIVATE_JWK
 * For local `wrangler dev`, put the same two lines in Backend/.dev.vars
 * (git-ignored). Generate once and keep them: rotating the key invalidates
 * every existing browser subscription.
 */

import { webcrypto as crypto } from "node:crypto";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = Buffer.from(raw).toString("base64url");

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_JWK: JSON.stringify(jwk) }));
} else {
  process.stdout.write(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_JWK=${JSON.stringify(jwk)}\n`);
}
