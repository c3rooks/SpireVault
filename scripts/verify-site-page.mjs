/**
 * Functions scripts/verify-site.mjs runs inside the page (through
 * page.evaluate). Each one is serialised and sent to the browser, so it may
 * use nothing from outside its own body.
 */

/** Rectangles of the hero's parts, for the fold and duel checks. */
export function heroGeometry() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const one = (selector) => box(document.querySelector(selector));
  const copy = document.querySelector(".hero-copy");
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    nav: one(".nav"),
    hero: one(".hero"),
    copy: one(".hero-copy"),
    copyOverflow: copy ? copy.scrollHeight - copy.clientHeight : 0,
    lastCopyChild: copy && copy.lastElementChild ? box(copy.lastElementChild) : null,
    climber: one(".actor--climber .actor-art"),
    boss: one(".actor--boss .actor-art"),
    balloon: one(".duel .balloon"),
    hand: one(".hand"),
    cards: Array.from(document.querySelectorAll(".stat-card"), box),
    handScrolls: (() => {
      const hand = document.querySelector(".hand");
      return hand ? getComputedStyle(hand).overflowX !== "visible" : false;
    })(),
  };
}

/** Text whose colour does not stand out enough from the solid colour behind it. */
export function lowContrast() {
  const parse = (value) => {
    const rgb = /rgba?\(([^)]+)\)/.exec(value || "");
    if (rgb) {
      const parts = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    // color-mix() results are reported as color(srgb r g b / a), channels 0 to 1.
    const srgb = /color\(srgb ([^)]+)\)/.exec(value || "");
    if (srgb) {
      const parts = srgb[1].split(/[/\s]+/).filter(Boolean).map(Number);
      return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
    }
    return null;
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  /** The nearest solid background, or null when a picture is in the way. */
  const backgroundOf = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      const colour = parse(style.backgroundColor);
      if (colour && colour.a >= 0.99) return colour;
      if (style.backgroundImage && style.backgroundImage !== "none" && node !== el) return null;
    }
    return parse(getComputedStyle(document.body).backgroundColor);
  };
  const failures = [];
  let unmeasured = 0;
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent || "").trim();
    const el = node.parentElement;
    if (!text || !el || seen.has(el)) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || rect.width < 2 || rect.height < 2) continue;
    if (el.closest(".sr, .skip-link, [hidden]")) continue;
    const fg = parse(style.color);
    const bg = backgroundOf(el);
    if (!fg || !bg) {
      unmeasured += 1;
      continue;
    }
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const got = ratio(fg, bg);
    if (got < (large ? 3 : 4.5)) failures.push(`${got.toFixed(2)}:1 "${text.slice(0, 40)}" (${el.tagName.toLowerCase()}.${el.className || "-"}, ${Math.round(size)}px)`);
  }
  if (unmeasured) failures.push(`${unmeasured} text element(s) could not be measured (unreadable colour, or a picture directly behind)`);
  return failures.slice(0, 12);
}
