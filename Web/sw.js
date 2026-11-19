// SpireVault service worker — co-op Play pings only.
//
// It does not cache anything and does not touch page loads: there is no
// "fetch" handler. Its one job is to turn an (empty) Web Push from the
// co-op Worker into a notification. Pushes carry no payload, so it asks
// /api/coop/play/peek — with the player's own cookie — what happened, and
// writes the notification from that answer. It must be the peek, not the
// poll: a poll counts as the player being back, which would end the five
// minutes they are given to return after being matched while away.

// The crest (scripts/build-brand-icons.mjs). Android draws the badge from its
// alpha alone, so it is a plain white shield.
const ICON = "/assets/brand/crest-icon-192-v1.png";
const BADGE = "/assets/brand/crest-badge-96-v1.png";
/** How recent "your search ended" must be for a push to be that ping (allows clock drift). */
const ENDED_FRESH_MS = 3 * 60 * 1000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function describe() {
  try {
    const resp = await fetch("/api/coop/play/peek", { credentials: "include", cache: "no-store" });
    const data = resp.ok ? await resp.json() : null;
    if (data && data.state === "matched" && data.match) {
      const others = (data.match.members || []).filter((m) => !m.isYou).map((m) => m.name);
      return {
        title: "Party found!",
        body: others.length
          ? `${others.join(", ")} ${others.length === 1 ? "is" : "are"} ready to climb. Open SpireVault to team up.`
          : "Your co-op party is ready. Open SpireVault to team up.",
        url: `/party/${data.match.matchId}`,
        matched: true,
      };
    }
    // Your pinged search ran out while you were away. That ping is sent the
    // moment it runs out, so only a fresh endedAt means this push is it; an
    // older one must not relabel a later "someone's looking" ping.
    if (data && data.state === "idle" && data.endedAt && Math.abs(Date.now() - data.endedAt) < ENDED_FRESH_MS) {
      return {
        title: "Your co-op search ended",
        body: "Nobody joined in time. Tap Play when you're back and you'll be first in line for the next player.",
        url: "/coop",
      };
    }
    if (data && data.lookingCount > 0) {
      return {
        title: "Someone's looking for co-op",
        body: "A player just tapped Play on SpireVault. Tap Play now and you'll be matched.",
        url: "/coop",
      };
    }
  } catch {
    /* fall through to the generic text */
  }
  return { title: "SpireVault co-op", body: "Something happened in co-op. Open SpireVault to see.", url: "/coop" };
}

// Buttons on "Party found!" (Chrome, Edge and Android show them; Safari shows
// none and a tap opens the party as before). Neither counts as the player
// being back at the page: "On my way" tells the party and restarts the five
// minutes they have to get there, "Pass" gives the seat back at once.
const MATCH_ACTIONS = [
  { action: "omw", title: "On my way" },
  { action: "pass", title: "Pass" },
];

self.addEventListener("push", (event) => {
  event.waitUntil(
    describe().then((n) =>
      self.registration.showNotification(n.title, {
        body: n.body,
        icon: ICON,
        badge: BADGE,
        tag: "coop-play",
        renotify: true,
        data: { url: n.url },
        ...(n.matched ? { actions: MATCH_ACTIONS, requireInteraction: true } : {}),
      }),
    ),
  );
});

/** A party step from a ping's button, sent with the player's own cookie. */
function partyStep(action) {
  return fetch("/api/coop/play/action", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, visible: false }),
  }).catch(() => null);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "omw") {
    event.waitUntil(partyStep("omw"));
    return;
  }
  if (event.action === "pass") {
    event.waitUntil(partyStep("leave"));
    return;
  }
  const url = (event.notification.data && event.notification.data.url) || "/coop";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      // A tab this worker does not control (a hard reload, a tab older than the
      // worker) can be focused but not navigated: open the party in a new one.
      const openNew = () => self.clients.openWindow(url);
      return open.focus().then((w) => (w && "navigate" in w ? w.navigate(url).catch(openNew) : openNew()), openNew);
    }),
  );
});
