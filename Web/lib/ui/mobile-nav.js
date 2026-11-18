// Phone navigation for the new look (≤ 880px wide).
//
// The bottom bar keeps four of the real sidebar rows — Overview, Characters,
// Runs, Co-op — and adds a "More" button that opens a sheet with everything
// else. Nothing in the sidebar is moved or rebuilt: the six rows that live in
// the sheet stay in the bar's DOM (hidden by CSS, still laid out), so the
// 1–9 shortcuts, `switchTab`, analytics selectors and the desktop rail all
// keep working exactly as before. The sheet only *mirrors* those rows — their
// labels, icons, badges and active state — and switches tabs through the
// public `window.SpireVault.switchTab`.
//
// The CSS for all of this is gated on `.sidebar-nav[data-v-mnav]`, which only
// this module sets, so until it runs phones keep the old scrolling strip.

import { esc } from "./html.js?v=1";
import { reduced } from "./motion.js?v=2";
import { THEMES, getTheme, getThemePreference, lookSwitchHtml, onThemeChange, setTheme, themeSwatchesHtml } from "./theme.js?v=5";

const PHONE_QUERY = "(max-width: 880px)";
const SHEET_ID = "v-mnav-sheet";
const CLOSE_ANIMATION_MS = 200;
/** Tabs that keep a slot in the bar. The order is the sidebar's own. */
const BAR_TABS = Object.freeze(["overview", "characters", "runs", "coop"]);
const SHEET_GROUPS = Object.freeze([
  Object.freeze({ id: "stats", label: "Stats", tabs: Object.freeze(["ascensions", "relics", "cards"]) }),
  Object.freeze({ id: "community", label: "Community", tabs: Object.freeze(["highlights", "news", "beta"]) }),
]);
const SHEET_TABS = Object.freeze([...SHEET_GROUPS.flatMap((group) => group.tabs), "settings"]);
/** A bar slot is ~60–70px on a phone; "Recent Runs" does not fit. */
const BAR_SHORT_LABELS = Object.freeze({ runs: "Runs" });
/**
 * The dot on More means "something in here is new to you". Beta's NEW pill is
 * permanent, so a dot that tracked raw badge visibility would never go out;
 * instead a badge counts as seen once the sheet has been opened while it
 * showed, and counts as new again after it has gone away and come back.
 * Set to false to light the dot whenever any hidden row shows a badge.
 */
const DOT_CLEARS_WHEN_SEEN = true;
const STORAGE_SEEN = "vault.web.mnav.seen";

const ICONS = Object.freeze({
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="19" cy="12" r="2.4"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A3.7 3.7 0 0 0 21 10.6C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  steam: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-9.96 9.04l5.35 2.21a2.83 2.83 0 0 1 1.6-.49l2.39-3.46v-.05a3.78 3.78 0 1 1 3.78 3.78h-.09l-3.4 2.43a2.84 2.84 0 0 1-5.62.6L2.3 14.5A10 10 0 1 0 12 2Zm-4.73 15.17-1.23-.51a2.13 2.13 0 1 0 1.17-2.9l1.27.52a1.57 1.57 0 1 1-1.2 2.9Zm10.04-7.72a2.52 2.52 0 1 0-2.52 2.52 2.52 2.52 0 0 0 2.52-2.52Zm-4.4 0a1.89 1.89 0 1 1 1.89 1.89 1.89 1.89 0 0 1-1.9-1.89Z"/></svg>',
});

/** @type {{ nav: HTMLElement, more: HTMLButtonElement, sheet: HTMLDialogElement, phone: MediaQueryList } | null} */
let mounted = null;
let syncQueued = false;
let closeTimer = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {string} tab @returns {HTMLElement|null} */
function rowFor(tab) {
  return document.querySelector(`.sidebar-nav .nav-row[data-tab="${tab}"]`);
}

/** @param {string} tab @returns {string} the label the sidebar shows */
function labelFor(tab) {
  if (tab === "settings") return "Settings";
  return (rowFor(tab)?.querySelector(".nav-label")?.textContent || tab).trim();
}

/**
 * "Co-op, Highlights and Beta": the tabs that need a Steam account, by the
 * sidebar's own labels (index.html marks their rows `data-steam-lock`).
 * @returns {string}
 */
function steamOnlyTabNames() {
  // U+2011 keeps "Co-op" from breaking at its hyphen in the narrow sheet.
  const names = [...document.querySelectorAll(".sidebar-nav .nav-row[data-steam-lock]")].map((row) =>
    labelFor(/** @type {HTMLElement} */ (row).dataset.tab || "").replace(/-/g, "\u2011")
  );
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
}

/** @param {HTMLDialogElement} sheet @returns {boolean} */
function isModal(sheet) {
  try {
    return sheet.matches(":modal");
  } catch {
    return false;
  }
}

/** @returns {string} */
function currentTab() {
  try {
    const tab = window.SpireVault && typeof window.SpireVault.activeTab === "function" ? window.SpireVault.activeTab() : "";
    if (tab) return String(tab);
  } catch {
    // Fall through to the DOM.
  }
  const active = document.querySelector(".sidebar-nav .nav-row.is-active");
  return active instanceof HTMLElement ? active.dataset.tab || "" : "";
}

/** @returns {ReadonlyArray<string>} */
function readSeen() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_SEEN) || "[]");
    return Array.isArray(parsed) ? Object.freeze(parsed.map(String)) : Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
}

/** @param {ReadonlyArray<string>} seen */
function writeSeen(seen) {
  try {
    window.localStorage.setItem(STORAGE_SEEN, JSON.stringify(seen));
  } catch {
    // Storage disabled: the dot simply behaves as if nothing was ever seen.
  }
}

/** What a locked tab's mark is called aloud (the sidebar row says the same). */
const LOCK_LABEL = "Locked. Sign in with Steam to open.";

/**
 * The visible badge on a sidebar row, as data. A Steam-only tab that is
 * closed to a signed-out visitor (script.js marks its row `is-locked`)
 * shows a lock instead of whatever badge it would carry.
 * @param {string} tab
 * @returns {{ text: string, label: string, kind: "dot"|"new"|"count"|"lock" } | null}
 */
function badgeFor(tab) {
  if (rowFor(tab)?.classList.contains("is-locked")) return { text: "", label: LOCK_LABEL, kind: "lock" };
  const badge = rowFor(tab)?.querySelector(".nav-badge");
  if (!(badge instanceof HTMLElement) || badge.hidden) return null;
  const kind = badge.classList.contains("nav-badge--dot") ? "dot" : badge.classList.contains("nav-badge--new") ? "new" : "count";
  return { text: (badge.textContent || "").trim(), label: badge.getAttribute("aria-label") || "", kind };
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/** @param {string} tab @returns {string} */
function tileHtml(tab) {
  const label = labelFor(tab);
  const icon = rowFor(tab)?.querySelector(".nav-icon")?.innerHTML || "";
  return `
    <li>
      <button class="v-mnav-tile" type="button" data-mnav-tab="${esc(tab)}" data-analytics-cta="nav-tab-${esc(tab)}">
        <span class="v-mnav-tile-orb" aria-hidden="true">${icon}</span>
        <span class="v-mnav-tile-label">${esc(label)}</span>
        <span class="v-mnav-badge" data-mnav-badge="${esc(tab)}" hidden></span>
      </button>
    </li>`;
}

/** @returns {string} */
function themeRowHtml() {
  return `
    <li>
      <button class="v-mnav-row" type="button" data-mnav-action="themes" aria-expanded="false" aria-controls="v-mnav-themes">
        <span class="v-mnav-row-icon">${ICONS.palette}</span>
        <span class="v-mnav-row-text"><strong>Look &amp; theme</strong><small data-mnav-theme-name></small></span>
        <span class="v-mnav-theme-chip" data-mnav-theme-chip aria-hidden="true"><i></i></span>
        <span class="v-mnav-row-chev">${ICONS.chevron}</span>
      </button>
      <div class="v-mnav-themes" id="v-mnav-themes" data-mnav-themes hidden></div>
    </li>`;
}

/** @returns {string} */
function sheetHtml() {
  const groups = SHEET_GROUPS.map((group) => `
    <section class="v-mnav-group" aria-labelledby="v-mnav-g-${group.id}">
      <h3 class="v-mnav-eyebrow" id="v-mnav-g-${group.id}">${esc(group.label)}</h3>
      <ul class="v-mnav-tiles" role="list">${group.tabs.map(tileHtml).join("")}</ul>
    </section>`).join("");
  return `
    <div class="v-mnav-scrim" data-mnav-close></div>
    <section class="v-mnav-panel">
      <header class="v-mnav-head">
        <h2 class="v-mnav-title" id="v-mnav-title" tabindex="-1">More</h2>
        <button class="v-mnav-close" type="button" data-mnav-close aria-label="Close menu">${ICONS.close}</button>
      </header>
      <div class="v-mnav-scroll">
        <nav class="v-mnav-groups" aria-label="More sections">${groups}</nav>
        <section class="v-mnav-group v-mnav-you" aria-labelledby="v-mnav-g-you">
          <h3 class="v-mnav-eyebrow" id="v-mnav-g-you">You</h3>
          <div class="v-mnav-account" data-mnav-account></div>
          <ul class="v-mnav-list" role="list">
            <li>
              <button class="v-mnav-row" type="button" data-mnav-tab="settings" data-analytics-cta="nav-tab-settings">
                <span class="v-mnav-row-icon">${ICONS.settings}</span>
                <span class="v-mnav-row-text"><strong>Settings</strong><small>Save folder, import &amp; export, preferences</small></span>
                <span class="v-mnav-row-chev">${ICONS.chevron}</span>
              </button>
            </li>
            ${themeRowHtml()}
          </ul>
        </section>
      </div>
    </section>`;
}

/**
 * Who is signed in, read from the account chrome script.js already paints.
 * @returns {{ state: "guest" } | { state: "member", name: string, avatar: string } | { state: "unknown" }}
 */
function readAccount() {
  const signin = document.getElementById("signin-btn-mobile");
  const pill = document.getElementById("me-pill");
  if ((signin && !signin.hidden) || pill?.classList.contains("me-pill-guest")) return { state: "guest" };
  const signout = document.getElementById("signout-btn-mobile");
  if (!signout || signout.hidden) return { state: "unknown" };
  const name = (document.getElementById("me-pill-name")?.textContent || "").trim() || "Your profile";
  const avatar = document.getElementById("me-pill-avatar")?.getAttribute("src") || "";
  return { state: "member", name, avatar };
}

/** @returns {string} */
function accountHtml() {
  const account = readAccount();
  if (account.state === "guest") {
    return `
      <button class="v-btn v-btn--primary v-mnav-signin" type="button" data-action="signin-cta" data-analytics-cta="mnav-signin">
        ${ICONS.steam}<span>Sign in with Steam</span>
      </button>
      <p class="v-mnav-note">${esc(document.querySelector(".me-pill-guest-note")?.textContent.trim() || `Optional. Unlocks ${steamOnlyTabNames()}.`)}</p>`;
  }
  if (account.state === "member") {
    const avatar = account.avatar ? `<img class="v-mnav-avatar" src="${esc(account.avatar)}" alt="" width="36" height="36" />` : "";
    // The live connection line, in words and colour, as the laptop rail shows
    // it (the sheet is rebuilt every time it opens, so it is always current).
    const state = document.getElementById("status-dot-mobile")?.dataset.state || "";
    const label = (document.getElementById("status-label-mobile")?.textContent || "").trim();
    const status = label
      ? `<small class="v-mnav-status" data-state="${esc(state)}"><span class="status-dot" data-state="${esc(state)}" aria-hidden="true"></span>${esc(label)}</small>`
      : "<small>Profile, status &amp; invites</small>";
    return `
      <button class="v-mnav-row v-mnav-profile" type="button" data-mnav-action="profile">
        ${avatar}
        <span class="v-mnav-row-text"><strong>${esc(account.name)}</strong>${status}</span>
        <span class="v-mnav-row-chev">${ICONS.chevron}</span>
      </button>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// State sync: badges, active tab, the dot on More
// ---------------------------------------------------------------------------

/** @param {HTMLElement} el @param {boolean} want */
function setHidden(el, want) {
  if (el.hidden !== want) el.hidden = want;
}

/** @param {Element} el @param {string} name @param {string|null} value */
function setAttr(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

/** @param {HTMLElement} sheet */
function syncBadges(sheet) {
  sheet.querySelectorAll("[data-mnav-badge]").forEach((node) => {
    const el = /** @type {HTMLElement} */ (node);
    const badge = badgeFor(el.dataset.mnavBadge || "");
    setHidden(el, !badge);
    if (!badge) return;
    // A dot and a lock are drawn, not written: they need a spoken name.
    const isGlyph = badge.kind === "dot" || badge.kind === "lock";
    const text = isGlyph ? "" : badge.text;
    el.dataset.kind = badge.kind;
    if (el.textContent !== text) el.textContent = text;
    setAttr(el, "aria-label", isGlyph ? badge.label || "New" : null);
    setAttr(el, "role", isGlyph ? "img" : null);
  });
}

/**
 * Forgets badges that have gone away (so they count as new when they come
 * back) and reports which visible ones are still unseen.
 * @param {boolean} markSeen  the sheet is open: everything visible is seen
 * @returns {boolean} true when the dot on More should show
 */
function reconcileSeen(markSeen) {
  // A lock is a state, not news: it never lights the dot on More.
  const showing = SHEET_TABS.filter((tab) => {
    const badge = badgeFor(tab);
    return !!badge && badge.kind !== "lock";
  });
  if (!DOT_CLEARS_WHEN_SEEN) return showing.length > 0;
  const previous = readSeen();
  const kept = previous.filter((tab) => showing.includes(tab));
  const next = markSeen ? Object.freeze([...new Set([...kept, ...showing])]) : Object.freeze(kept);
  if (next.length !== previous.length || next.some((tab, i) => tab !== previous[i])) writeSeen(next);
  return showing.some((tab) => !next.includes(tab));
}

function sync() {
  syncQueued = false;
  if (!mounted) return;
  const { more, sheet } = mounted;
  const tab = currentTab();
  const inSheet = SHEET_TABS.includes(tab);
  more.classList.toggle("is-active", inSheet);
  setAttr(more, "aria-label", inSheet ? `More sections, ${labelFor(tab)} open` : "More sections");
  sheet.querySelectorAll("[data-mnav-tab]").forEach((button) => {
    setAttr(button, "aria-current", /** @type {HTMLElement} */ (button).dataset.mnavTab === tab ? "page" : null);
  });
  syncBadges(sheet);
  setHidden(/** @type {HTMLElement} */ (more.querySelector(".v-mnav-dot")), !reconcileSeen(sheet.open));
}

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(sync);
}

/**
 * @param {{ theme?: string }} [detail]  from onThemeChange. Its resolved theme
 *   is the truth: with the circular reveal running, <html> still carries the
 *   old theme when listeners fire.
 */
function syncTheme(detail = {}) {
  if (!mounted) return;
  const preference = getThemePreference();
  const def = THEMES.find((theme) => theme.id === preference);
  const name = mounted.sheet.querySelector("[data-mnav-theme-name]");
  if (name) name.textContent = def ? def.label : preference;
  const chip = mounted.sheet.querySelector("[data-mnav-theme-chip]");
  if (chip) setAttr(chip, "data-theme", detail.theme || getTheme());
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

/**
 * The theme picker, laid out for the sheet. Same contract as theme.js's own
 * swatches — `[data-theme-id]` radios, so its click handler and its
 * checked-state sync drive these too — but sheet-sized: two to a row, each a
 * live miniature beside its name. The Auto preview comes from theme.js's own
 * markup, which is the only place that knows the most-played hero.
 * @returns {string}
 */
function swatchesHtml() {
  const tpl = document.createElement("template");
  tpl.innerHTML = themeSwatchesHtml();
  const autoPreview = tpl.content.querySelector('[data-theme-id="auto"] [data-theme]');
  const preference = getThemePreference();
  const swatches = THEMES.map((theme) => {
    const preview = theme.id === "auto" ? autoPreview?.getAttribute("data-theme") || getTheme() : theme.id;
    const checked = theme.id === preference;
    return `
      <button class="v-mnav-swatch" type="button" role="radio" aria-checked="${checked}" tabindex="${checked ? 0 : -1}" data-theme-id="${esc(theme.id)}">
        <span class="v-mnav-theme-chip" data-theme="${esc(preview)}" aria-hidden="true"><i></i></span>
        <span class="v-mnav-swatch-text"><strong>${esc(theme.label)}</strong><small>${esc(theme.note)}</small></span>
      </button>`;
  }).join("");
  return `<div class="v-mnav-swatches" role="radiogroup" aria-label="Theme">${swatches}</div>`;
}

/**
 * Radio-group arrows for the sheet's swatches (theme.js handles its own
 * popover's group only): move, select, and keep focus on the new choice.
 * @param {KeyboardEvent} event
 */
function handleSwatchKeys(event) {
  const current = event.target instanceof Element ? event.target.closest(".v-mnav-swatch") : null;
  const group = current?.parentElement;
  if (!current || !group) return;
  const swatches = /** @type {HTMLElement[]} */ ([...group.querySelectorAll(".v-mnav-swatch")]);
  const index = swatches.indexOf(/** @type {HTMLElement} */ (current));
  const last = swatches.length - 1;
  const moves = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: last };
  if (!(event.key in moves)) return;
  event.preventDefault();
  const nextIndex = (moves[/** @type {keyof typeof moves} */ (event.key)] + swatches.length) % swatches.length;
  const next = swatches[nextIndex];
  setTheme(next.dataset.themeId || "", { source: "mobile-nav" });
  next.focus();
}

/** @param {boolean} expanded */
function setThemesOpen(expanded) {
  if (!mounted) return;
  const toggle = mounted.sheet.querySelector('[data-mnav-action="themes"]');
  const region = /** @type {HTMLElement|null} */ (mounted.sheet.querySelector("[data-mnav-themes]"));
  if (!toggle || !region) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  if (expanded) {
    region.innerHTML = `${lookSwitchHtml("mobile-nav")}${swatchesHtml()}
      <p class="v-mnav-themes-foot"><span>Themes change instantly; switching looks reloads the page once. Both are saved on this device.</span></p>`;
  }
  region.hidden = !expanded;
  if (expanded) region.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
}

/**
 * @param {{ fromKeyboard?: boolean }} [options]  Opened from the keyboard,
 *   focus lands on the current (or first) section, ready for Enter. Opened by
 *   a tap it lands on the sheet's title instead: a focus ring on the first
 *   tile reads as "this one is selected" to someone who did not use a key.
 */
export function openMoreSheet(options = {}) {
  if (!mounted || mounted.sheet.open) return;
  const { sheet, more } = mounted;
  window.clearTimeout(closeTimer);
  sheet.removeAttribute("data-closing");
  /** @type {HTMLElement} */ (sheet.querySelector("[data-mnav-account]")).innerHTML = accountHtml();
  setThemesOpen(false);
  syncTheme();
  document.documentElement.classList.add("v-mnav-lock");
  if (typeof sheet.showModal === "function") sheet.showModal();
  else sheet.setAttribute("open", "");
  more.setAttribute("aria-expanded", "true");
  sync();
  const target = options.fromKeyboard
    ? sheet.querySelector('[data-mnav-tab][aria-current="page"]') || sheet.querySelector("[data-mnav-tab]")
    : sheet.querySelector(".v-mnav-title");
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

/** Runs once the dialog has really closed, however it closed. */
function afterClose() {
  if (!mounted) return;
  window.clearTimeout(closeTimer);
  mounted.sheet.removeAttribute("data-closing");
  document.documentElement.classList.remove("v-mnav-lock");
  mounted.more.setAttribute("aria-expanded", "false");
  if (mounted.phone.matches && mounted.more.isConnected) mounted.more.focus({ preventScroll: true });
}

/** @param {{ instant?: boolean }} [options] */
export function closeMoreSheet(options = {}) {
  if (!mounted || !mounted.sheet.open) return;
  const { sheet } = mounted;
  const finish = () => {
    if (typeof sheet.close === "function" && sheet.open) sheet.close();
    else if (sheet.hasAttribute("open")) {
      sheet.removeAttribute("open");
      afterClose();
    }
  };
  if (options.instant || reduced()) {
    finish();
    return;
  }
  sheet.setAttribute("data-closing", "");
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(finish, CLOSE_ANIMATION_MS);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** @param {MouseEvent} event */
function handleSheetClick(event) {
  if (!mounted) return;
  const target = event.target instanceof Element ? event.target : null;
  // A tap on the dialog itself is a tap on the bar area under it.
  if (!target || target === mounted.sheet || target.closest("[data-mnav-close]")) {
    closeMoreSheet();
    return;
  }
  const tabButton = target.closest("[data-mnav-tab]");
  if (tabButton) {
    const tab = /** @type {HTMLElement} */ (tabButton).dataset.mnavTab || "";
    closeMoreSheet({ instant: true });
    window.SpireVault?.switchTab?.(tab);
    return;
  }
  const action = target.closest("[data-mnav-action]");
  const name = action instanceof HTMLElement ? action.dataset.mnavAction : "";
  if (name === "themes") setThemesOpen(action?.getAttribute("aria-expanded") !== "true");
  else if (name === "profile") {
    closeMoreSheet({ instant: true });
    document.getElementById("me-pill")?.click();
  } else if (target.closest('[data-action="signin-cta"], [data-action="ui-set"]')) {
    // script.js handles these on document; just get out of the way.
    closeMoreSheet({ instant: true });
  }
}

/** @param {KeyboardEvent} event  Only needed where <dialog> is not modal. */
function trapFocus(event) {
  if (!mounted || event.key !== "Tab" || isModal(mounted.sheet)) return;
  const focusable = /** @type {HTMLElement[]} */ ([...mounted.sheet.querySelectorAll("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")])
    .filter((el) => el.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** @param {HTMLDialogElement} sheet */
function wireSheet(sheet) {
  sheet.addEventListener("click", handleSheetClick);
  sheet.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !isModal(sheet)) {
      event.preventDefault();
      closeMoreSheet();
    }
    handleSwatchKeys(event);
    trapFocus(event);
  });
  // Escape on a modal dialog: animate out instead of vanishing. When the
  // browser will not let the cancel be prevented, `close` still cleans up.
  sheet.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeMoreSheet();
  });
  sheet.addEventListener("close", afterClose);
}

/** @param {HTMLElement} nav */
function addShortLabels(nav) {
  Object.entries(BAR_SHORT_LABELS).forEach(([tab, short]) => {
    const row = nav.querySelector(`.nav-row[data-tab="${tab}"]`);
    if (!row || row.querySelector(".v-mnav-short")) return;
    row.classList.add("v-mnav-has-short");
    row.querySelector(".nav-label")?.insertAdjacentHTML("afterend", `<span class="v-mnav-short" aria-hidden="true">${esc(short)}</span>`);
  });
}

/** @returns {HTMLButtonElement} */
function createMoreButton() {
  const more = document.createElement("button");
  more.type = "button";
  more.className = "v-mnav-more";
  more.setAttribute("aria-haspopup", "dialog");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-controls", SHEET_ID);
  more.setAttribute("aria-label", "More sections");
  more.innerHTML = `<span class="v-mnav-more-icon" aria-hidden="true">${ICONS.more}</span><span class="v-mnav-more-label">More</span><span class="v-mnav-dot" aria-hidden="true" hidden></span>`;
  return more;
}

/** @returns {HTMLDialogElement} */
function createSheet() {
  const sheet = /** @type {HTMLDialogElement} */ (document.createElement("dialog"));
  sheet.id = SHEET_ID;
  sheet.className = "v-mnav-sheet";
  sheet.setAttribute("aria-labelledby", "v-mnav-title");
  sheet.innerHTML = sheetHtml();
  return sheet;
}

/**
 * Builds the phone bar's More button and sheet. Idempotent; safe to call
 * before the first tab render (the sidebar rows are static HTML).
 */
export function mountMobileNav() {
  if (mounted) return;
  const nav = /** @type {HTMLElement|null} */ (document.querySelector(".sidebar-nav"));
  if (!nav || BAR_TABS.some((tab) => !nav.querySelector(`.nav-row[data-tab="${tab}"]`))) return;
  const more = createMoreButton();
  const sheet = createSheet();
  addShortLabels(nav);
  nav.appendChild(more);
  document.body.appendChild(sheet);
  nav.dataset.vMnav = "1";
  mounted = { nav, more, sheet, phone: window.matchMedia(PHONE_QUERY) };

  // `detail` is 0 for a click synthesised from Enter or Space.
  more.addEventListener("click", (event) => (sheet.open ? closeMoreSheet() : openMoreSheet({ fromKeyboard: event.detail === 0 })));
  wireSheet(sheet);
  window.addEventListener("spirevault:tab", () => {
    closeMoreSheet({ instant: true });
    queueSync();
  });
  mounted.phone.addEventListener("change", (event) => {
    if (!event.matches) closeMoreSheet({ instant: true });
  });
  const observer = new MutationObserver(queueSync);
  nav.querySelectorAll(".nav-row").forEach((row) => {
    observer.observe(row, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
  });
  onThemeChange(syncTheme);
  sync();
}
