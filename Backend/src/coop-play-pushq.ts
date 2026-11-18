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
 *   - a player is queued once; a later "looking" for them changes nothing
 *   - "matched" pings are time-critical: they sit ahead of every "looking"
 *     ping, and a player already queued as "looking" is upgraded and moved up
 *   - a batch is at most PUSH_BATCH_SIZE requests: under the Free cap, with
 *     room for the few other requests the same invocation may make
 *
 * Pure functions with injected storage and sender, so the offline suite
 * (scripts/verify-coop-play.mjs) can drive them without a Durable Object.
 */

import type { PushOutcome, PushSubscriptionRecord } from "./coop-play-push";

export type PushKind = "matched" | "looking";

export interface QueuedPush {
  readonly sid: string;
  readonly kind: PushKind;
}

export type PushQueue = ReadonlyArray<QueuedPush>;

/** Pings sent per invocation: under the Free plan's 50 subrequests, with headroom. */
export const PUSH_BATCH_SIZE = 40;

/** How soon the alarm comes back while pings are still queued. */
export const PUSH_DRAIN_EVERY_MS = 1_000;

export interface PushBatchDeps {
  getSub(sid: string): Promise<PushSubscriptionRecord | null | undefined>;
  deleteSub(sid: string): Promise<void>;
  send(sub: PushSubscriptionRecord): Promise<PushOutcome>;
}

export interface PushBatchResult {
  sent: number;
  gone: number;
  skipped: number;
  failed: number;
}

/**
 * Returns a new queue with the targets added: deduplicated by player, every
 * "matched" ping ahead of every "looking" one, arrival order kept within each.
 */
export function enqueuePushes(queue: PushQueue, targets: Iterable<readonly [string, PushKind]>): PushQueue {
  const kinds = new Map<string, PushKind>();
  const order: string[] = [];
  const add = (sid: string, kind: PushKind) => {
    const had = kinds.get(sid);
    if (had === undefined) order.push(sid);
    if (had !== "matched") kinds.set(sid, kind);
  };
  for (const e of queue) add(e.sid, e.kind);
  for (const [sid, kind] of targets) add(sid, kind);
  const all = order.map((sid) => ({ sid, kind: kinds.get(sid) as PushKind }));
  return [...all.filter((e) => e.kind === "matched"), ...all.filter((e) => e.kind === "looking")];
}

/** Splits off at most one batch from the front of the queue. */
export function takeBatch(queue: PushQueue, size: number = PUSH_BATCH_SIZE): { batch: PushQueue; rest: PushQueue } {
  return { batch: queue.slice(0, size), rest: queue.slice(size) };
}

/**
 * Sends one batch, one request per player who still has a subscription.
 * A gone subscription (404/410) is deleted; one failing push never stops the
 * rest. Payload-free: the service worker asks /coop/play/peek what happened.
 */
export async function sendPushBatch(batch: PushQueue, deps: PushBatchDeps): Promise<PushBatchResult> {
  const result: PushBatchResult = { sent: 0, gone: 0, skipped: 0, failed: 0 };
  for (const { sid } of batch) {
    const sub = await deps.getSub(sid);
    if (!sub) {
      result.skipped++;
      continue;
    }
    try {
      const outcome = await deps.send(sub);
      if (outcome === "sent") result.sent++;
      else if (outcome === "gone") {
        result.gone++;
        await deps.deleteSub(sid);
      } else result.failed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
