// Co-op Play — the ways we tell a player "you've been matched".
//
//   · Web Push (tab closed): service worker /sw.js + a VAPID subscription the
//     Worker sends empty pushes to. The worker answers "what happened?" when
//     the service worker asks /api/coop/play, so no payload crypto is needed.
//   · Tab open: a short chime (Web Audio, unlocked by the Play tap), a system
//     notification if the tab is in the background, and a flashing title.
//
// Everything here is feature-detected. The macOS app's WKWebView and the
// Windows shell have no Notification / Push API; they fall back to the chime
// and the title flash.

const SW_URL = "/sw.js";

/** @returns {{ supported: boolean, reason?: string }} */
export function pushSupport() {
  const hasApis =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  if (hasApis) return { supported: true };
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  if (isIOS) {
    return {
      supported: false,
      reason: "To get pings on iPhone, add SpireVault to your Home Screen (Share → Add to Home Screen). Until then, keep this tab open while you wait.",
    };
  }
  return { supported: false, reason: "This browser can't ping you, so keep the tab open while you wait." };
}

function urlBase64ToUint8Array(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Ask for permission, subscribe and register with the Worker.
 * @param {(path: string, opts?: object) => Promise<any>} api
 * @param {"stable"|"beta"} branch
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function enablePush(api, branch) {
  if (!pushSupport().supported) return { ok: false, message: pushSupport().reason };
  const config = await api("/coop/play/push/config");
  if (!config.ok || !config.data?.enabled || !config.data?.publicKey) {
    return { ok: false, message: "Pings aren't available yet. Keep this tab open while you wait." };
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, message: "Notifications are blocked for SpireVault. Allow them in your browser's site settings to get pings." };
  }
  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.data.publicKey),
      }));
    const saved = await api("/coop/play/push", {
      method: "POST",
      body: { subscription: sub.toJSON(), looking: true, branch },
    });
    if (!saved.ok) return { ok: false, message: "Couldn't save your ping settings. Try again in a moment." };
    return { ok: true };
  } catch (err) {
    console.warn("[coop-play] push subscribe failed", err);
    return { ok: false, message: "Your browser refused the ping subscription. Keep this tab open while you wait." };
  }
}

/** @param {(path: string, opts?: object) => Promise<any>} api */
export async function disablePush(api) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration(SW_URL);
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (err) {
    console.warn("[coop-play] push unsubscribe failed", err);
  }
  const r = await api("/coop/play/push", { method: "DELETE" });
  return { ok: r.ok };
}

// MARK: - Tab-open alerts

let audioCtx = null;

/** Call from a user gesture (the Play tap) so the chime is allowed later. */
export function unlockSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

/** Two rising notes, quiet. No asset to load. */
export function chime() {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime + 0.02;
    [659.25, 987.77].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = t0 + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.55);
    });
  } catch {
    /* sound is a nicety */
  }
}

/** System notification while the tab is hidden (needs prior permission). */
export function notifyMatched(text) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    const n = new Notification("SpireVault co-op: party found", {
      body: text,
      tag: "coop-play",
      icon: "/assets/brand/crest-icon-192-v1.png",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some shells expose Notification but throw */
  }
}

let flashTimer = 0;
let baseTitle = "";

export function flashTitle(text) {
  stopTitleFlash();
  baseTitle = document.title;
  let on = false;
  flashTimer = window.setInterval(() => {
    on = !on;
    document.title = on ? text : baseTitle;
  }, 1000);
  const stop = () => {
    if (document.visibilityState === "visible") stopTitleFlash();
  };
  document.addEventListener("visibilitychange", stop);
  window.addEventListener("focus", stop, { once: true });
}

export function stopTitleFlash() {
  if (!flashTimer) return;
  window.clearInterval(flashTimer);
  flashTimer = 0;
  if (baseTitle) document.title = baseTitle;
}
