/**
 * Steam Rich Presence — web-side ingestion endpoint for the desktop
 * helper. The helper is a tiny background process (macOS LaunchAgent /
 * Windows Service / Linux systemd unit) that watches the Steam process
 * via the Steam client's own running-games API and POSTs status updates
 * here so the user's lobby presence flips automatically when STS2 boots
 * or quits.
 *
 * Spec: docs/coop-steam-rich-presence-spec.md
 *
 * This module is the *server* half. The native helper code lives under
 * VaultApp/App/Helpers/SteamRichPresence/ (added in a separate sprint).
 *
 * Wire format:
 *   POST /coop/rich-presence/ingest
 *   Auth: Bearer token (same scheme as other authed endpoints)
 *   Body: {
 *     helperVersion: string,
 *     hostOS: "macos" | "windows" | "linux",
 *     state: "in-game" | "in-menu" | "not-running",
 *     stsAppId?: number,           // expect 2868840
 *     activityDetail?: string,     // free-form, ≤ 80 chars (e.g. "Floor 12 · A15")
 *     reportedAt: string,          // ISO8601 from the helper's clock
 *   }
 *
 * Effect:
 *   Maps the helper's state to the v2 presence status the lobby
 *   surface already understands:
 *
 *     "in-game"     → "playing"
 *     "in-menu"     → "looking"
 *     "not-running" → previous status (no-op write)
 *
 *   The activityDetail is stored on the v2 presence row so the lobby
 *   surface can show "Currently: Floor 12 · A15" under the host's name.
 *
 * Defenses:
 *   - Bearer token required; falls back to the same session resolver
 *     used elsewhere, so the helper authenticates with the same token
 *     the user already minted by signing into SpireVault.
 *   - Rate limit: 30 writes/min per helper (one every 2s is more than
 *     enough; STS2 doesn't change state that often).
 *   - We do NOT trust the helper's clock — the server stamps its own
 *     `updatedAt`. The reportedAt is logged for drift analysis only.
 */

import type { Env } from "./types";

export interface RichPresenceIngestBody {
  helperVersion?: unknown;
  hostOS?: unknown;
  state?: unknown;
  stsAppId?: unknown;
  activityDetail?: unknown;
  reportedAt?: unknown;
}

export interface RichPresenceIngestResult {
  applied: boolean;
  status: "playing" | "looking" | "noop";
  activityDetail?: string;
}

const STS2_APP_ID = 2868840;

function clampString(x: unknown, max: number): string | undefined {
  if (typeof x !== "string") return undefined;
  const trimmed = x.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

/**
 * Translate a helper ingest into a v2 presence write. Returns the
 * computed result; the caller is responsible for fanning that out to
 * the presence engine.
 */
export function planRichPresenceUpdate(body: RichPresenceIngestBody): RichPresenceIngestResult {
  const state = clampString(body.state, 16);
  const appId = typeof body.stsAppId === "number" ? body.stsAppId : undefined;
  // Ignore writes that claim to be from STS2 but pass the wrong app id.
  // This is best-effort guard rail; helper builds should always send
  // the right value.
  if (appId !== undefined && appId !== STS2_APP_ID && state !== "not-running") {
    return { applied: false, status: "noop" };
  }
  const detail = clampString(body.activityDetail, 80);
  switch (state) {
    case "in-game":
      return { applied: true, status: "playing", ...(detail ? { activityDetail: detail } : {}) };
    case "in-menu":
      return { applied: true, status: "looking", ...(detail ? { activityDetail: detail } : {}) };
    case "not-running":
      return { applied: false, status: "noop" };
    default:
      return { applied: false, status: "noop" };
  }
}

/**
 * Persist a tiny audit log per Steam ID so we can answer "is the
 * helper actually reporting?" without standing up a separate telemetry
 * pipeline. Capped at 50 entries, 7-day TTL.
 */
export async function logRichPresenceIngest(
  env: Env,
  steamID: string,
  body: RichPresenceIngestBody,
  result: RichPresenceIngestResult,
): Promise<void> {
  if (!steamID) return;
  try {
    const key = `coop:richp:log:${steamID}`;
    const raw = await env.LOBBIES.get(key);
    const list = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
    list.unshift({
      at: new Date().toISOString(),
      helperVersion: clampString(body.helperVersion, 32),
      hostOS: clampString(body.hostOS, 16),
      state: clampString(body.state, 16),
      reportedAt: clampString(body.reportedAt, 64),
      applied: result.applied,
      mappedStatus: result.status,
    });
    const capped = list.slice(0, 50);
    await env.LOBBIES.put(key, JSON.stringify(capped), {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  } catch {
    /* swallow */
  }
}

/** Public app id constant — exported for the helper integration test. */
export { STS2_APP_ID };
