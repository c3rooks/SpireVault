/**
 * HTTP surface for one-tap co-op Play. Thin: checks the session, looks up the
 * player's Steam name/avatar, and forwards to the single CoopPlayDO.
 *
 *   GET    /coop/play/pulse        public live line (cached 15 s)
 *   GET    /coop/play/push/config  VAPID public key for the browser
 *   POST   /coop/play              tap Play  {character?, branch?, push?, stay?}
 *   GET    /coop/play?visible=0|1  poll / keep-alive (visible=0: a tab in the background)
 *   GET    /coop/play/peek         the same view, read without a keep-alive (the service worker's)
 *   DELETE /coop/play              leave the queue
 *   POST   /coop/play/cancel       same, for navigator.sendBeacon on page close
 *   POST   /coop/play/action       {action: steam_add|hosting|in_game|leave|omw, visible?}
 *   POST   /coop/play/push         {subscription, looking, branch}: pings on for this device
 *   DELETE /coop/play/push         {endpoint?}: pings off for this device (no endpoint: all devices)
 *   GET    /coop/play/devices      the devices that can ping you
 *   DELETE /coop/play/devices/:id  forget one of them
 *   POST   /coop/play/signout      {endpoint?}: forget this device; leave the line only if none is left
 */

import type { Env } from "./types";
import { requireSession } from "./auth";
import { getSessionProfile } from "./presence";
import { PLAY_ACTIONS, sanitizeBranch, type PlayAction, type PlayerProfile } from "./coop-play-core";
import type { CoopPlayDO, PlayCallResult } from "./coop-play-do";
import { deviceIdFor, deviceLabel, isDeviceId, type Device } from "./coop-play-devices";
import { isAllowedPushEndpoint, pushConfigured, type PushSubscriptionRecord } from "./coop-play-push";

const DEVICE_PATH = /^\/coop\/play\/devices\/([0-9a-f]+)$/;

const NO_STORE = { "cache-control": "no-store" };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...NO_STORE, ...init.headers },
  });
}

function stub(env: Env): DurableObjectStub<CoopPlayDO> {
  return env.COOP_PLAY.get(env.COOP_PLAY.idFromName("global"));
}

function reply(result: PlayCallResult, extra: Record<string, unknown> = {}): Response {
  if (!result.ok) return json({ ok: false, error: result.error }, { status: 429 });
  return json({ ok: true, ...result.view, ...extra });
}

async function profileFor(env: Env, sid: string): Promise<PlayerProfile> {
  const p = await getSessionProfile(env, sid);
  const name = (p?.personaName ?? "").trim().slice(0, 40) || "Steam player";
  const avatar = typeof p?.avatarURL === "string" && /^https:\/\//.test(p.avatarURL) ? p.avatarURL : undefined;
  return { sid, name, avatar };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function parseSubscription(raw: unknown): PushSubscriptionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!isAllowedPushEndpoint(r.endpoint)) return null;
  const p256dh = typeof r.keys?.p256dh === "string" ? r.keys.p256dh.slice(0, 200) : undefined;
  const auth = typeof r.keys?.auth === "string" ? r.keys.auth.slice(0, 100) : undefined;
  return { endpoint: r.endpoint, keys: { p256dh, auth }, savedAt: new Date().toISOString() };
}

async function deviceFrom(req: Request, sub: PushSubscriptionRecord): Promise<Device> {
  const now = Date.now();
  return {
    id: await deviceIdFor(sub.endpoint),
    kind: "webpush",
    sub,
    label: deviceLabel(req.headers.get("user-agent")),
    createdAt: now,
    lastSeenAt: now,
  };
}

/** The device named by a push endpoint in the body, or null when there is none (or it isn't one). */
async function deviceIdFromBody(body: Record<string, unknown>): Promise<string | null> {
  return isAllowedPushEndpoint(body.endpoint) ? deviceIdFor(body.endpoint) : null;
}

export async function handleCoopPlayRoute(
  req: Request,
  env: Env,
  pathname: string,
  method: string,
): Promise<Response | null> {
  if (pathname !== "/coop/play" && !pathname.startsWith("/coop/play/")) return null;
  if (!env.COOP_PLAY) return json({ ok: false, error: "play_unavailable" }, { status: 503 });

  if (method === "GET" && pathname === "/coop/play/pulse") {
    const counts = await stub(env).pulse();
    return json({ ok: true, ...counts }, { headers: { "cache-control": "public, max-age=15" } });
  }

  if (method === "GET" && pathname === "/coop/play/push/config") {
    return json(
      { ok: true, enabled: pushConfigured(env), publicKey: env.VAPID_PUBLIC_KEY ?? null },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  }

  const auth = await requireSession(req, env);
  if (auth instanceof Response) return auth;
  const sid = auth.steamID;
  const play = stub(env);

  if (pathname === "/coop/play") {
    if (method === "GET") {
      // Clients from before visibility send nothing: counted as in view.
      const visible = new URL(req.url).searchParams.get("visible") !== "0";
      const [result, pushOn] = await Promise.all([play.poll(sid, visible), play.hasPush(sid)]);
      return reply(result, { pushOn });
    }
    if (method === "POST") {
      const body = await readBody(req);
      const who = await profileFor(env, sid);
      return reply(
        await play.play(who, { character: body.character, branch: body.branch, push: body.push, stay: body.stay }),
      );
    }
    if (method === "DELETE") return reply(await play.cancel(sid));
  }

  if (method === "GET" && pathname === "/coop/play/peek") return reply(await play.peek(sid));

  if (method === "POST" && pathname === "/coop/play/cancel") return reply(await play.cancel(sid));

  if (method === "POST" && pathname === "/coop/play/action") {
    const body = await readBody(req);
    const action = body.action;
    if (typeof action !== "string" || !(PLAY_ACTIONS as readonly string[]).includes(action)) {
      return json({ ok: false, error: "invalid_action" }, { status: 400 });
    }
    // A ping's button (the service worker) sends visible:false.
    return reply(await play.act(sid, action as PlayAction, body.visible !== false));
  }

  if (pathname === "/coop/play/push") {
    if (method === "POST") {
      if (!pushConfigured(env)) return json({ ok: false, error: "push_disabled" }, { status: 503 });
      const body = await readBody(req);
      const sub = parseSubscription(body.subscription);
      if (!sub) return json({ ok: false, error: "invalid_subscription" }, { status: 400 });
      const device = await deviceFrom(req, sub);
      const result = await play.addDevice(sid, device, body.looking === true, sanitizeBranch(body.branch));
      return reply(result, { pushOn: true, deviceId: device.id });
    }
    if (method === "DELETE") {
      const body = await readBody(req);
      // No endpoint at all is the old clients' "all my devices". An endpoint
      // that isn't one is refused, so a bad body can never wipe the list.
      const named = body.endpoint !== undefined && body.endpoint !== null;
      if (named && !isAllowedPushEndpoint(body.endpoint)) {
        return json({ ok: false, error: "invalid_endpoint" }, { status: 400 });
      }
      const id = await deviceIdFromBody(body);
      const result = await play.removeDevices(sid, id);
      return reply(result, { pushOn: (result.ok && (result.devicesLeft ?? 0) > 0) || false });
    }
  }

  if (method === "GET" && pathname === "/coop/play/devices") {
    return json({ ok: true, devices: await play.listDevices(sid) });
  }

  const devicePath = method === "DELETE" ? DEVICE_PATH.exec(pathname) : null;
  if (devicePath) {
    if (!isDeviceId(devicePath[1])) return json({ ok: false, error: "invalid_device" }, { status: 400 });
    const result = await play.removeDevices(sid, devicePath[1]);
    return reply(result, { pushOn: (result.ok && (result.devicesLeft ?? 0) > 0) || false });
  }

  if (method === "POST" && pathname === "/coop/play/signout") {
    const id = await deviceIdFromBody(await readBody(req));
    const result = await play.signOut(sid, id);
    return reply(result, { devicesLeft: result.ok ? result.devicesLeft ?? 0 : undefined });
  }

  return json({ ok: false, error: "not_found" }, { status: 404 });
}

/** Local sandbox helpers (the caller gates these to localhost + LOCAL_DEBUG). */
export async function sandboxPlaySeed(
  env: Env,
  who: PlayerProfile,
  branch: unknown,
  character: unknown,
): Promise<PlayCallResult> {
  // push:true gives the seeded ticket the 10-minute lifetime, so a fake
  // persona stays in line without anyone polling for it.
  return stub(env).play(who, { branch, character, push: true });
}

export async function sandboxPlayAct(env: Env, sid: string, action: PlayAction): Promise<PlayCallResult> {
  return stub(env).act(sid, action);
}

export async function sandboxPlayPoll(env: Env, sid: string): Promise<PlayCallResult> {
  return stub(env).poll(sid);
}

export async function sandboxPlayReset(env: Env): Promise<void> {
  await stub(env).reset();
}
