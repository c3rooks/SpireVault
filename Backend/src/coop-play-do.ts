/**
 * CoopPlayDO — the one live copy of the co-op Play queue.
 *
 * There is exactly one instance (`idFromName("global")`). A Durable Object
 * handles one request at a time, so matching two strangers can never race:
 * the match happens inside the Play call itself. The rules live in
 * coop-play-core.ts; this class only loads/saves state, keeps daily counters,
 * sends push pings and runs an alarm while anyone is waiting or matched.
 *
 * Storage keys (SQLite-backed DO storage, not KV — no KV write budget used):
 *   state            PlayState (tickets, matches, ping prefs)
 *   c:<YYYYMMDD>     daily counters { play_tap: n, matched: n, … }
 *   u:<YYYYMMDD>     Steam IDs that tapped Play that day (unique players)
 *   dev:<steamID>    the devices that can ping this player (coop-play-devices.ts)
 *   sub:<steamID>    the single Web Push subscription saved before device lists;
 *                    turned into a one-device list the first time it is read
 *   pushq            pings still to send (coop-play-pushq.ts): one batch goes
 *                    out in the call that queued them, the alarm drains the
 *                    rest, so no invocation passes the subrequest cap
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import {
  act,
  cancel,
  emptyState,
  isQuiet,
  leaveEverything,
  peek,
  play,
  poll,
  pulse,
  setLookingPings,
  setPushFlag,
  tick,
  type Branch,
  type CounterKey,
  type PlayAction,
  type PlayerProfile,
  type PlayEvent,
  type PlayRequest,
  type PlayState,
  type PlayView,
  type Result,
} from "./coop-play-core";
import {
  deviceIdFor,
  deviceViews,
  findDevice,
  legacyDevice,
  removeDevice,
  upsertDevice,
  type Device,
  type DeviceView,
} from "./coop-play-devices";
import { sendPush, type PushSubscriptionRecord } from "./coop-play-push";
import {
  enqueuePushes,
  PUSH_DRAIN_EVERY_MS,
  sendPushBatch,
  takeBatch,
  type PushBatchDeps,
  type PushKind,
  type PushQueue,
  type PushTarget,
} from "./coop-play-pushq";
import { appendCoopHistory } from "./coop-reputation";

const ALARM_EVERY_MS = 30_000;
const PERSIST_SEEN_EVERY_MS = 30_000;
const COUNTER_DAYS_KEPT = 90;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 60;

export interface DayStats {
  day: string;
  counters: Partial<Record<CounterKey, number>>;
  players: number;
}

export type PlayCallResult = { ok: true; view: PlayView } | { ok: false; error: "rate_limited" };

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

export class CoopPlayDO extends DurableObject<Env> {
  private state: PlayState = emptyState();
  private pushQueue: PushQueue = [];
  private lastPersistAt = 0;
  private readonly hits = new Map<string, { start: number; n: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<PlayState>("state")) ?? emptyState();
      this.pushQueue = (await ctx.storage.get<PushQueue>("pushq")) ?? [];
    });
  }

  // MARK: - RPC surface (called from coop-play-routes.ts)

  async play(who: PlayerProfile, req: PlayRequest): Promise<PlayCallResult> {
    if (this.limited(who.sid)) return { ok: false, error: "rate_limited" };
    // Pings are on if any device can be pinged, whatever this browser says:
    // queueing from a laptop without pings still reaches the phone.
    const push = req.push === true || (await this.devices(who.sid)).length > 0;
    const r = play(this.state, who, { ...req, push }, this.coreCtx());
    await this.apply(r, true);
    return { ok: true, view: r.view };
  }

  /** `visible` is false for a tab in the background: it keeps the place but doesn't count as being back. */
  async poll(sid: string, visible = true): Promise<PlayCallResult> {
    if (this.limited(sid)) return { ok: false, error: "rate_limited" };
    const r = poll(this.state, sid, this.coreCtx(), visible);
    await this.apply(r, false);
    return { ok: true, view: r.view };
  }

  /**
   * Read-only: no keep-alive, no storage write, and outside the rate limit,
   * so a push arriving for an away player costs them nothing.
   */
  async peek(sid: string): Promise<PlayCallResult> {
    return { ok: true, view: peek(this.state, sid) };
  }

  async cancel(sid: string): Promise<PlayCallResult> {
    if (this.limited(sid)) return { ok: false, error: "rate_limited" };
    const hadTicket = Boolean(this.state.tickets[sid]);
    const r = cancel(this.state, sid, this.coreCtx());
    // Leaving a line you were not in is not worth a storage write of its own.
    await this.apply(r, hadTicket);
    return { ok: true, view: r.view };
  }

  /** `visible` is false when the step comes from a ping's button (the service worker). */
  async act(sid: string, action: PlayAction, visible = true): Promise<PlayCallResult> {
    if (this.limited(sid)) return { ok: false, error: "rate_limited" };
    const r = act(this.state, sid, action, this.coreCtx(), visible);
    await this.apply(r, true);
    return { ok: true, view: r.view };
  }

  async pulse(): Promise<ReturnType<typeof pulse>> {
    return pulse(this.state);
  }

  /**
   * Turn pings on for one device (or refresh it), with the "someone's
   * looking" choice. Someone already waiting keeps their ticket; it only
   * gains pings. Other devices on the account are untouched.
   */
  async addDevice(sid: string, device: Device, looking: boolean, branch: Branch): Promise<PlayCallResult> {
    if (this.limited(sid)) return { ok: false, error: "rate_limited" };
    await this.saveDevices(sid, upsertDevice(await this.devices(sid), device));
    const flagged = setPushFlag(this.state, sid, true);
    const r = setLookingPings(flagged, sid, looking, branch, this.coreCtx());
    await this.apply(r, true);
    return { ok: true, view: r.view };
  }

  /**
   * Turn pings off for one device (`id`), or for all of them (`null`, what
   * clients from before device lists send). Pings stay on while any device
   * is left.
   */
  async removeDevices(sid: string, id: string | null): Promise<PlayCallResult & { devicesLeft?: number }> {
    if (this.limited(sid)) return { ok: false, error: "rate_limited" };
    const left = await this.dropDevices(sid, id);
    const r = this.withPings(sid, left.length > 0);
    await this.apply(r, true);
    return { ok: true, view: r.view, devicesLeft: left.length };
  }

  /**
   * Sign-out on one device: forget that device. Only when no device can ping
   * the player any more do they leave the line and any party that has not
   * started, so signing out of a laptop doesn't cancel the search their phone
   * is watching.
   */
  async signOut(sid: string, id: string | null): Promise<PlayCallResult & { devicesLeft?: number }> {
    if (this.limited(sid)) return { ok: false, error: "rate_limited" };
    const left = id ? await this.dropDevices(sid, id) : await this.devices(sid);
    if (left.length > 0) {
      const r = this.withPings(sid, true);
      await this.apply(r, true);
      return { ok: true, view: r.view, devicesLeft: left.length };
    }
    const flagged = this.withPings(sid, false);
    const r = leaveEverything(flagged.state, sid, this.coreCtx());
    await this.apply({ state: r.state, events: [...flagged.events, ...r.events] }, true);
    return { ok: true, view: r.view, devicesLeft: 0 };
  }

  async hasPush(sid: string): Promise<boolean> {
    return (await this.devices(sid)).length > 0;
  }

  async listDevices(sid: string): Promise<DeviceView[]> {
    return deviceViews(await this.devices(sid));
  }

  /** Daily counters for /admin/stats, newest first. */
  async stats(days = 14): Promise<DayStats[]> {
    const out: DayStats[] = [];
    const now = Date.now();
    for (let i = 0; i < days; i++) {
      const day = ymd(now - i * 86_400_000);
      const [counters, players] = await Promise.all([
        this.ctx.storage.get<Partial<Record<CounterKey, number>>>(`c:${day}`),
        this.ctx.storage.get<string[]>(`u:${day}`),
      ]);
      out.push({ day, counters: counters ?? {}, players: players?.length ?? 0 });
    }
    return out;
  }

  /** Local sandbox only (gated by the caller): wipe everything. */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.state = emptyState();
    this.pushQueue = [];
    this.hits.clear();
  }

  // MARK: - Alarm

  /**
   * Expire what timed out, then send at most one batch of queued pings. While
   * pings remain the alarm comes back in PUSH_DRAIN_EVERY_MS; otherwise every
   * ALARM_EVERY_MS while anyone is waiting or matched.
   */
  async alarm(): Promise<void> {
    await this.apply(tick(this.state, Date.now()), true, { drain: false, schedule: false });
    if (this.pushQueue.length > 0) await this.drainOneBatch();
    await this.scheduleAlarm();
  }

  // MARK: - Devices

  /**
   * The player's device list. A subscription saved before device lists
   * existed (`sub:<sid>`) becomes a one-device list the first time it is read.
   */
  private async devices(sid: string): Promise<Device[]> {
    const list = await this.ctx.storage.get<Device[]>(`dev:${sid}`);
    if (list) return list;
    const legacy = await this.ctx.storage.get<PushSubscriptionRecord>(`sub:${sid}`);
    if (!legacy) return [];
    const migrated = [legacyDevice(legacy, await deviceIdFor(legacy.endpoint), Date.now())];
    await this.ctx.storage.put(`dev:${sid}`, migrated);
    await this.ctx.storage.delete(`sub:${sid}`);
    return migrated;
  }

  private async saveDevices(sid: string, list: readonly Device[]): Promise<void> {
    if (list.length > 0) await this.ctx.storage.put(`dev:${sid}`, list);
    else await this.ctx.storage.delete(`dev:${sid}`);
  }

  /** Removes one device (or every device for `null`) and returns what is left. */
  private async dropDevices(sid: string, id: string | null): Promise<Device[]> {
    const left = id ? removeDevice(await this.devices(sid), id) : [];
    await this.saveDevices(sid, left);
    return left;
  }

  /**
   * The state with the player's ping flag set. Losing the last device also
   * turns off "ping me when someone's looking", which has nowhere to go.
   */
  private withPings(sid: string, on: boolean): Result {
    const flagged = setPushFlag(this.state, sid, on);
    if (on) return { state: flagged, view: peek(flagged, sid), events: [] };
    return setLookingPings(flagged, sid, false, "stable", this.coreCtx());
  }

  // MARK: - Internals

  private coreCtx(): { now: number; newId: () => string } {
    return {
      now: Date.now(),
      newId: () => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      },
    };
  }

  /** In-memory per-player limiter; resets if the object is evicted, which is fine. */
  private limited(sid: string): boolean {
    const now = Date.now();
    const h = this.hits.get(sid);
    if (!h || now - h.start > RATE_WINDOW_MS) {
      this.hits.set(sid, { start: now, n: 1 });
      return false;
    }
    this.hits.set(sid, { start: h.start, n: h.n + 1 });
    return h.n + 1 > RATE_MAX_PER_WINDOW;
  }

  /**
   * Adopt the new state and act on events. Polls only refresh "last seen"
   * times, so they are saved at most every 30 s; anything that changes who is
   * waiting or matched is saved right away.
   */
  private async apply(
    r: Pick<Result, "state" | "events">,
    structural: boolean,
    { drain = true, schedule = true }: { drain?: boolean; schedule?: boolean } = {},
  ): Promise<void> {
    this.state = r.state;
    const now = Date.now();
    const mustSave = structural || r.events.length > 0 || now - this.lastPersistAt > PERSIST_SEEN_EVERY_MS;
    if (mustSave) {
      await this.ctx.storage.put("state", this.state);
      this.lastPersistAt = now;
    }
    if (r.events.length > 0) await this.handleEvents(r.events, now);
    // One batch per invocation at most. drainOneBatch takes its batch before
    // its first await, so the alarm below already sees what is left.
    if (drain && this.pushQueue.length > 0) this.ctx.waitUntil(this.drainOneBatch());
    if (schedule) await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const draining = this.pushQueue.length > 0;
    if (!draining && isQuiet(this.state)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const existing = await this.ctx.storage.getAlarm();
    const due = Date.now() + (draining ? PUSH_DRAIN_EVERY_MS : ALARM_EVERY_MS);
    if (existing === null || (draining && existing > due)) await this.ctx.storage.setAlarm(due);
  }

  private async handleEvents(events: PlayEvent[], now: number): Promise<void> {
    const day = ymd(now);
    const counts = events.filter((e): e is Extract<PlayEvent, { type: "count" }> => e.type === "count");
    const players = events.filter((e): e is Extract<PlayEvent, { type: "player" }> => e.type === "player");

    if (counts.length > 0) {
      const prev = (await this.ctx.storage.get<Partial<Record<CounterKey, number>>>(`c:${day}`)) ?? {};
      const next = { ...prev };
      for (const e of counts) next[e.key] = (next[e.key] ?? 0) + 1;
      await this.ctx.storage.put(`c:${day}`, next);
    }
    if (players.length > 0) {
      const prev = (await this.ctx.storage.get<string[]>(`u:${day}`)) ?? [];
      const merged = Array.from(new Set([...prev, ...players.map((p) => p.sid)]));
      if (merged.length !== prev.length) await this.ctx.storage.put(`u:${day}`, merged);
    }
    if (counts.length > 0 || players.length > 0) await this.pruneOldDays(now);

    for (const e of events) {
      if (e.type === "history") {
        this.ctx.waitUntil(
          appendCoopHistory(this.env, e.sid, "started_party_run", { partyId: e.matchId, role: e.role }),
        );
      }
    }

    const pinged: Array<[string, PushKind]> = [];
    for (const e of events) {
      if (e.type === "push_matched") pinged.push([e.sid, "matched"]);
      if (e.type === "push_ended") pinged.push([e.sid, "ended"]);
      if (e.type === "push_looking") for (const sid of e.sids) pinged.push([sid, "looking"]);
    }
    if (pinged.length > 0) {
      // One queue entry per device, so a batch counts real requests. Storage
      // reads keep the input gate closed: nothing else runs in between.
      const targets: PushTarget[] = [];
      for (const [sid, kind] of pinged) {
        for (const d of await this.devices(sid)) targets.push([sid, kind, d.id]);
      }
      if (targets.length > 0) {
        this.pushQueue = enqueuePushes(this.pushQueue, targets);
        await this.ctx.storage.put("pushq", this.pushQueue);
      }
    }
  }

  private async pruneOldDays(now: number): Promise<void> {
    const cutoff = ymd(now - COUNTER_DAYS_KEPT * 86_400_000);
    const old = await this.ctx.storage.list({ prefix: "c:", end: `c:${cutoff}` });
    const oldU = await this.ctx.storage.list({ prefix: "u:", end: `u:${cutoff}` });
    const keys = [...old.keys(), ...oldU.keys()];
    if (keys.length > 0) await this.ctx.storage.delete(keys);
  }

  /**
   * Sends the front batch of the push queue. The batch is taken from memory
   * synchronously, before the first await, so two invocations can never send
   * the same pings. Payload-free: the service worker asks /coop/play/peek
   * what happened.
   */
  private async drainOneBatch(): Promise<void> {
    const { batch, rest } = takeBatch(this.pushQueue);
    if (batch.length === 0) return;
    this.pushQueue = rest;
    await this.ctx.storage.put("pushq", rest);
    await sendPushBatch(batch, this.pushDeps());
  }

  private pushDeps(): PushBatchDeps {
    return {
      getSub: async (sid, device) => {
        const list = await this.devices(sid);
        // Entries queued before device lists have no device: the most recent one.
        return (device ? findDevice(list, device) : list[0])?.sub;
      },
      deleteSub: async (sid, device) => {
        const list = await this.devices(sid);
        const gone = device ?? list[0]?.id;
        if (!gone) return;
        const left = removeDevice(list, gone);
        await this.saveDevices(sid, left);
        // The last device is gone: their place in line goes back to the
        // short clock, since nothing can reach them any more.
        if (left.length === 0) {
          this.state = setPushFlag(this.state, sid, false);
          await this.ctx.storage.put("state", this.state);
        }
      },
      send: (sub) => sendPush(this.env, sub),
    };
  }
}
