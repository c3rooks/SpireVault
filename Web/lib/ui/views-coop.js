// Co-op tab views for the new UI. Pure functions: model in, HTML out.
//
// The Co-op surfaces are restyled in styles/src/surfaces/coop.css over the
// existing DOM. The one fork is the guest room list when /coop/rooms cannot
// be reached: classic leaves its "Loading live rooms…" placeholder up
// forever; the new look swaps it for the same invitation to host that the
// empty board shows. Classes and the `data-action` match the classic empty
// state, so the sign-in handler, the one-CTA rule in coop.css and the
// analytics CTA id (first class: btn-primary) all stay the same.

/**
 * Room-list-unreachable state for the guest browser (#guest-rooms-grid).
 * @returns {string}
 */
export function guestRoomsUnavailable() {
  return `
    <div class="guest-room-card guest-room-card--empty guest-room-card--offline">
      <h3>The fire&rsquo;s banked for a moment</h3>
      <p class="muted">We can&rsquo;t reach the room list right now. Sign in and host a room &mdash; it shows up for everyone browsing as soon as the list is back.</p>
      <button class="btn-primary sm" type="button" data-action="signin-cta">Sign in &amp; host a room</button>
    </div>`;
}
