import type { Env } from "./types";
import { putSessionProfile } from "./presence";
import { recordSignIn } from "./admin";

/**
 * Steam OpenID 2.0 sign-in + session minting.
 *
 * Flow:
 *   1. Vault opens   /auth/steam/start?return=thevault://auth&nonce=<rand>
 *      Worker redirects the user's browser to Steam's OpenID endpoint.
 *      `ret` and `nonce` are round-tripped via openid.return_to.
 *   2. User authenticates at Steam.
 *   3. Steam redirects to /auth/steam/callback?<openid.* params>&ret=…&nonce=…
 *      We verify the response with Steam (check_authentication), extract the
 *      verified SteamID64, mint a server-side session bound to that SteamID,
 *      then 302 the user back to `ret` with steamid/persona/avatar/session/nonce.
 *
 * Why a session token: writes (`POST /lobbies`, `DELETE /lobbies/by/...`,
 * status updates, etc.) require `Authorization: Bearer <session>` and the
 * Worker rejects any write whose body's SteamID doesn't match the session.
 * This is what stops a compiled client from forging another player's identity.
 */

const STEAM_OPENID = "https://steamcommunity.com/openid/login";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Validate the caller-supplied `return` URL against an allowlist. If we
 * accepted any URL, an attacker could send a victim through OpenID and
 * receive `?session=…` on a domain they control. So:
 *
 *   - `thevault://…`                 (macOS app custom scheme)
 *   - `https://app.spirevault.app/…`  (web companion)
 *   - `http://127.0.0.1:…` / `http://localhost:…`  (local dev)
 *   - any host listed in env.ALLOWED_RETURN_HOSTS (comma-separated)
 *
 * Anything else gets coerced to the safe macOS default. We never error out —
 * silently downgrading to the default keeps casual link-pasters working.
 */
function safeReturnURL(raw: string | null, env: Env): string {
  const fallback = "thevault://auth";
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fallback;
  }
  if (parsed.protocol === "thevault:") return parsed.toString();

  const host = parsed.host;
  const protoOK = parsed.protocol === "https:" || parsed.protocol === "http:";
  if (!protoOK) return fallback;

  if (parsed.protocol === "https:" && host === "app.spirevault.app") {
    return parsed.toString();
  }
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
  ) {
    return parsed.toString();
  }

  const extra = (env.ALLOWED_RETURN_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(host)) return parsed.toString();

  return fallback;
}

export function steamAuthStart(req: Request, env: Env): Response {
  const url = new URL(req.url);
  const ret = safeReturnURL(url.searchParams.get("return"), env);
  const nonce = url.searchParams.get("nonce") ?? "";
  const callback =
    `${env.PUBLIC_BASE_URL}/auth/steam/callback` +
    `?ret=${encodeURIComponent(ret)}` +
    `&nonce=${encodeURIComponent(nonce)}`;
  const realm = env.PUBLIC_BASE_URL;

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": callback,
    "openid.realm": realm,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  return Response.redirect(`${STEAM_OPENID}?${params.toString()}`, 302);
}

export async function steamAuthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Re-validate `ret` on the way back too — it travelled through Steam in a
  // round-tripped query string, so don't trust it implicitly.
  const ret = safeReturnURL(url.searchParams.get("ret"), env);
  const nonce = url.searchParams.get("nonce") ?? "";

  // Verify with Steam — flip mode to check_authentication and submit openid.* params.
  const verifyParams = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (k.startsWith("openid.")) verifyParams.set(k, v);
  }
  verifyParams.set("openid.mode", "check_authentication");

  const verifyResp = await fetch(STEAM_OPENID, {
    method: "POST",
    body: verifyParams,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const verifyBody = await verifyResp.text();
  if (!/is_valid:\s*true/.test(verifyBody)) {
    return new Response("Steam auth verification failed.", { status: 400 });
  }

  const claimedID = url.searchParams.get("openid.claimed_id") ?? "";
  const m = claimedID.match(/\/openid\/id\/(\d{17})$/);
  if (!m) {
    return new Response("Could not extract SteamID from response.", { status: 400 });
  }
  const steamID = m[1]!;

  // Best-effort enrich with persona name + avatar via Steam Web API.
  let persona = "Steam User";
  let avatar = "";
  try {
    if (env.STEAM_WEB_API_KEY) {
      const u =
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
        `?key=${env.STEAM_WEB_API_KEY}&steamids=${steamID}`;
      const r = await fetch(u);
      if (r.ok) {
        const j = (await r.json()) as any;
        const p = j?.response?.players?.[0];
        if (p?.personaname) persona = p.personaname;
        if (p?.avatarfull) avatar = p.avatarfull;
      }
    }
  } catch {
    // Silently fall back to defaults — auth still works.
  }

  // Mint a session bound to the verified SteamID. KV makes this tiny and free.
  const session = newSessionToken();
  await env.LOBBIES.put(`session:${session}`, steamID, {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // Stamp the verified persona/avatar onto a sibling KV record so the
  // presence feed can render the user without paying for a Steam Web API
  // call on every heartbeat. Same TTL as the session.
  await putSessionProfile(
    env,
    steamID,
    { personaName: persona, avatarURL: avatar || undefined },
    SESSION_TTL_SECONDS
  );

  // Record this sign-in for the operator dashboard. Best-effort — never
  // fail the auth callback if KV writes hiccup.
  recordSignIn(env, steamID, persona, avatar || undefined).catch(() => {});

  const final = new URL(ret);
  final.searchParams.set("steamid", steamID);
  final.searchParams.set("persona", persona);
  if (avatar) final.searchParams.set("avatar", avatar);
  final.searchParams.set("session", session);
  if (nonce) final.searchParams.set("nonce", nonce);

  return Response.redirect(final.toString(), 302);
}

/**
 * Resolve `Authorization: Bearer <session>` into a verified SteamID, or
 * `null` if the session is missing/expired/invalid. Used by all write
 * routes (`requireSession`).
 */
export async function steamIDForRequest(req: Request, env: Env): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]{16,128})$/i);
  if (!m) return null;
  const token = m[1]!;
  const sid = await env.LOBBIES.get(`session:${token}`);
  return sid && /^\d{17}$/.test(sid) ? sid : null;
}

/**
 * Convenience: enforce auth and (optionally) that the asserted SteamID
 * inside the request body matches the session. Returns a `Response` to send
 * back if the check fails, or `null` if the request can proceed.
 */
export async function requireSession(
  req: Request,
  env: Env,
  assertedSteamID?: string
): Promise<{ steamID: string } | Response> {
  const sid = await steamIDForRequest(req, env);
  if (!sid) {
    return new Response("Unauthorized — sign in with Steam first.", { status: 401 });
  }
  if (assertedSteamID && assertedSteamID !== sid) {
    return new Response("SteamID in body does not match your session.", { status: 403 });
  }
  return { steamID: sid };
}

function newSessionToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sliding-window session refresh.
 *
 * Active users should never be signed out just because the clock ticked past
 * the original 30-day TTL. Every authenticated heartbeat re-writes both
 * `session:<token>` and `session-profile:<steamID>` with a fresh TTL, so an
 * actively-heartbeating session lives forever (within the 30-day window from
 * the most recent heartbeat) and only an explicit sign-out (or a 30-day
 * absence) actually expires it.
 *
 * We do this only on the heartbeat path, not on every read-only authenticated
 * request, so the cost is bounded by the heartbeat cadence (~1 per 3 minutes
 * per active user) instead of the inbox-poll cadence (~1 per 30 seconds).
 *
 * Best-effort: KV write failures are swallowed by the caller. Worst case the
 * session expires at the original deadline, which matches pre-fix behavior.
 */
export async function refreshSessionTTL(
  env: Env,
  token: string,
  steamID: string
): Promise<void> {
  const sessionKey = `session:${token}`;
  const profileKey = `session-profile:${steamID}`;

  // Read the existing profile in parallel with the session re-put. We need
  // the profile body because KV.put doesn't have a "just bump TTL" verb,
  // it has to re-write the whole value.
  const [, existingProfile] = await Promise.all([
    env.LOBBIES.put(sessionKey, steamID, { expirationTtl: SESSION_TTL_SECONDS }),
    env.LOBBIES.get(profileKey),
  ]);

  if (existingProfile) {
    await env.LOBBIES.put(profileKey, existingProfile, {
      expirationTtl: SESSION_TTL_SECONDS,
    });
  }
}

/**
 * Pull the bearer token out of the Authorization header. Returns null on
 * malformed or missing headers. Lives next to `steamIDForRequest` so callers
 * that need the token explicitly (e.g. for `refreshSessionTTL`) don't have
 * to re-implement the same regex.
 */
export function bearerTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]{16,128})$/i);
  return m ? m[1]! : null;
}
