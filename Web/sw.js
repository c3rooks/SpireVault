// SpireVault service worker — co-op Play pings only.
//
// It does not cache anything and does not touch page loads: there is no
// "fetch" handler. Its one job is to turn an (empty) Web Push from the
// co-op Worker into a notification. Pushes carry no payload, so it asks
// /api/coop/play — with the player's own cookie — what happened, and writes
// the notification from that answer.

const ICON = "/assets/icon-192.png?v=1";
const BADGE = "/assets/icon-32.png?v=1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function describe() {
  try {
    const resp = await fetch("/api/coop/play", { credentials: "include", cache: "no-store" });
    const data = resp.ok ? await resp.json() : null;
    if (data && data.state === "matched" && data.match) {
      const others = (data.match.members || []).filter((m) => !m.isYou).map((m) => m.name);
      return {
        title: "Party found!",
        body: others.length
          ? `${others.join(", ")} ${others.length === 1 ? "is" : "are"} ready to climb. Open SpireVault to team up.`
          : "Your co-op party is ready. Open SpireVault to team up.",
        url: `/party/${data.match.matchId}`,
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
      }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/coop";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        return open.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : w));
      }
      return self.clients.openWindow(url);
    }),
  );
});
