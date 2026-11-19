/**
 * The co-op Play push queue: pings go out in batches, never all at once.
 *
 * Cloudflare caps the outbound requests one invocation may make (50 on Workers
 * Free, 1,000 on Paid). A "someone's looking" ping fans out to every opted-in
 * player, so sending them all from the call that triggered them would drop
 * every ping past the cap once enough players turn pings on. CoopPlayDO keeps
 * the pending pings in this queue (persisted under `pushq`), sends one batch in
 * the triggering call and drains the rest from its alarm, one batch per
 * invocation.
 *
 * Rules:
 *   - one entry per device (a player with pings on in two places is queued
 *     twice), so a batch counts requests, not players
 *   - a device is queued once; a later, less urgent ping for it changes nothing
 *   - "matched" pings are time-critical: they sit ahead of everything, then
 *     "ended" (your search ran out), then "looking"; a device already queued
 *     for something less urgent is upgraded and moved up
 *   - a batch is at most PUSH_BATCH_SIZE requests: under the Free cap, with
 *     room for the few other requests the same invocation may make
 *
 * Entries queued before device lists existed have no `device`; they go to the
 * player's most recent device.
 *
 * Pure functions with injected storage and sender, so the offline suite
 * (scripts/verify-coop-play.mjs) can drive them without a Durable Object.
 */

import type { PushOutcome, PushSubscriptionRecord } from "./coop-play-push";

export type PushKind = "matched" | "ended" | "looking";

/** Lower is more urgent. */
const URGENCY: Readonly<Record<PushKind, number>> = { matched: 0, ended: 1, looking: 2 };

export interface QueuedPush {
  readonly sid: string;
  readonly kind: PushKind;
  /** Device id (coop-play-devices.ts); missing on entries queued before device lists. */
  readonly device?: string;
}

export type PushQueue = ReadonlyArray<QueuedPush>;

/** Pings sent per invocation: under the Free plan's 50 subrequests, with headroom. */
export const PUSH_BATCH_SIZE = 40;

/** How soon the alarm comes back while pings are still queued. */
export const PUSH_DRAIN_EVERY_MS = 1_000;

export interface PushBatchDeps {
  /** The subscription for that device (or, with no device, the player's most recent one). */
  getSub(sid: string, device?: string): Promise<PushSubscriptionRecord | null | undefined>;
  /** The push service said the subscription is gone: forget that device. */
  deleteSub(sid: string, device?: string): Promise<void>;
  send(sub: PushSubscriptionRecord): Promise<PushOutcome>;
}

/** A target for enqueuePushes: player, kind, and the device (omitted only by old callers). */
export type PushTarget = readonly [sid: string, kind: PushKind, device?: string];

export interface PushBatchResult {
  sent: number;
  gone: number;
  skipped: number;
  failed: number;
}

/**
 * Returns a new queue with the targets added: deduplicated by device, the
 * most urgent kind kept, sorted matched → ended → looking with arrival order
 * kept within each.
 */
export function enqueuePushes(queue: PushQueue, targets: Iterable<PushTarget>): PushQueue {
  const entries = new Map<string, QueuedPush>();
  const add = (sid: string, kind: PushKind, device?: string) => {
    const key = `${sid}\u0000${device ?? ""}`;
    const had = entries.get(key);
    if (had === undefined) entries.set(key, device === undefined ? { sid, kind } : { sid, kind, device });
    else if (URGENCY[kind] < URGENCY[had.kind]) entries.set(key, { ...had, kind });
  };
  for (const e of queue) add(e.sid, e.kind, e.device);
  for (const [sid, kind, device] of targets) add(sid, kind, device);
  // Array.prototype.sort is stable, so arrival order holds within a kind.
  return [...entries.values()].sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind]);
}

/** Splits off at most one batch from the front of the queue. */
export function takeBatch(queue: PushQueue, size: number = PUSH_BATCH_SIZE): { batch: PushQueue; rest: PushQueue } {
  return { batch: queue.slice(0, size), rest: queue.slice(size) };
}

/**
 * Sends one batch, one request per device that still has a subscription.
 * A gone subscription (404/410) deletes only that device; one failing push
 * never stops the rest. Payload-free: the service worker asks
 * /coop/play/peek what happened.
 */
export async function sendPushBatch(batch: PushQueue, deps: PushBatchDeps): Promise<PushBatchResult> {
  const result: PushBatchResult = { sent: 0, gone: 0, skipped: 0, failed: 0 };
  for (const { sid, device } of batch) {
    const sub = await deps.getSub(sid, device);
    if (!sub) {
      result.skipped++;
      continue;
    }
    try {
      const outcome = await deps.send(sub);
      if (outcome === "sent") result.sent++;
      else if (outcome === "gone") {
        result.gone++;
        await deps.deleteSub(sid, device);
      } else result.failed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
