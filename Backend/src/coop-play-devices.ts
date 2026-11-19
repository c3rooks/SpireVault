/**
 * The devices that can ping one player — pure functions, no I/O.
 *
 * A player can turn pings on in more than one place: the desktop browser
 * they queue from, the phone in their pocket, later the SpireVault iPhone
 * app. Each one is a Device, stored as a list under `dev:<steamID>` in
 * CoopPlayDO. A match pings every device on the list, so walking away from
 * the desk no longer means missing the party.
 *
 * Before this list existed there was one subscription per player
 * (`sub:<steamID>`), and the last browser to turn pings on silently replaced
 * the others. `legacyDevice` turns that record into the first entry of a list.
 *
 * Rules:
 *   - a device's id is a hash of its push endpoint, so turning pings on again
 *     in the same browser refreshes that device instead of adding a second
 *   - at most MAX_DEVICES per player; adding one more drops the device seen
 *     least recently
 *   - every function returns a new list and never edits the one passed in
 */

import type { PushSubscriptionRecord } from "./coop-play-push";

export const MAX_DEVICES = 8;
const LABEL_MAX = 40;
const ID_HEX_CHARS = 16;

export type DeviceKind = "webpush";

export interface Device {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly sub: PushSubscriptionRecord;
  /** "Chrome on Mac", "Safari on iPhone": shown in the Devices list. */
  readonly label: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/** What the browser is shown: never the endpoint or its keys. */
export interface DeviceView {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly label: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/** First 16 hex chars of SHA-256(endpoint). The browser computes the same to find "this device". */
export async function deviceIdFor(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, ID_HEX_CHARS);
}

export function isDeviceId(raw: unknown): raw is string {
  return typeof raw === "string" && new RegExp(`^[0-9a-f]{${ID_HEX_CHARS}}$`).test(raw);
}

/**
 * Adds a device, or refreshes the one with the same id (its first-seen time
 * is kept). Most recently seen first; the oldest falls off past MAX_DEVICES.
 */
export function upsertDevice(list: readonly Device[], incoming: Device): Device[] {
  const prior = list.find((d) => d.id === incoming.id);
  const merged: Device = prior ? { ...incoming, createdAt: prior.createdAt } : incoming;
  return [merged, ...list.filter((d) => d.id !== incoming.id)]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_DEVICES);
}

export function removeDevice(list: readonly Device[], id: string): Device[] {
  return list.filter((d) => d.id !== id);
}

export function findDevice(list: readonly Device[], id: string): Device | undefined {
  return list.find((d) => d.id === id);
}

/** The one subscription saved before device lists existed, as a device. */
export function legacyDevice(sub: PushSubscriptionRecord, id: string, fallbackNow: number): Device {
  const savedAt = Date.parse(sub.savedAt);
  const at = Number.isFinite(savedAt) ? savedAt : fallbackNow;
  return { id, kind: "webpush", sub, label: "A browser", createdAt: at, lastSeenAt: at };
}

export function deviceViews(list: readonly Device[]): DeviceView[] {
  return list.map(({ id, kind, label, createdAt, lastSeenAt }) => ({ id, kind, label, createdAt, lastSeenAt }));
}

/**
 * A short, human name for the device from its User-Agent. Never stores the
 * User-Agent itself.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? "");
  const platform = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "Chromebook"
            : /Macintosh|Mac OS X/.test(ua)
              ? "Mac"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  const label = browser && platform ? `${browser} on ${platform}` : browser || platform || "A browser";
  return label.slice(0, LABEL_MAX);
}
