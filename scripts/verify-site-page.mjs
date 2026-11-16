/**
 * Functions scripts/verify-site.mjs runs inside the page (through
 * page.evaluate). Each one is serialised and sent to the browser, so it may
 * use nothing from outside its own body.
 */

/** The first screen's parts, as they are drawn: the copy, the featured card and the hand. */
export function heroGeometry() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const one = (selector) => box(document.querySelector(selector));
  const shown = (selector) => Array.from(document.querySelectorAll(selector)).filter((el) => el.getClientRects().length > 0);
  const text = (el) => (el ? (el.textContent || "").trim() : "");
  const copy = document.querySelector(".hero-copy");
  const lastShown = copy ? Array.from(copy.children).filter((el) => el.getClientRects().length > 0).pop() : null;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    nav: one(".nav"),
    hero: one(".hero"),
    lastCopyChild: box(lastShown),
    primary: one("#web-cta"),
    featured: shown(".featured").map((el) => ({
      climber: el.dataset.c,
      box: box(el),
      name: text(el.querySelector(".featured-name")),
      rate: text(el.querySelector(".featured-rate strong")),
      line: text(el.querySelector(".featured-line")),
      art: getComputedStyle(el.querySelector(".featured-art")).backgroundImage,
    })),
    cards: shown(".hand-card").map((el) => ({
      climber: el.dataset.c,
      box: box(el),
      name: text(el.querySelector(".hand-name")),
      art: getComputedStyle(el.querySelector(".hand-art")).backgroundImage,
    })),
  };
}

/**
 * Pictures drawn larger than their own pixels allow on this screen: every
 * <img>, and every element painted with a picture as its background. A
 * picture stretched past its pixels is soft; that is what made the first
 * version's figures look like cut-outs.
 * @param {number} tolerance how far past 1 device pixel per picture pixel is still fine
 */
export async function drawnTooLarge(tolerance) {
  const dpr = window.devicePixelRatio || 1;
  const offenders = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  };
  const judge = (label, boxW, boxH, natW, natH, fit) => {
    if (!natW || !natH) return;
    // How many CSS px one picture px covers, then in device px.
    const perPixel = fit === "cover" ? Math.max(boxW / natW, boxH / natH) : fit === "contain" ? Math.min(boxW / natW, boxH / natH) : boxW / natW;
    const stretch = perPixel * dpr;
    if (stretch > tolerance) offenders.push(`${label}: ${natW}px wide, drawn ${Math.round(natW * perPixel)} CSS px wide (${stretch.toFixed(2)}x its pixels at ${dpr}x)`);
  };
  /** The file's own size: an <img> picked from a srcset reports its size divided by the density. */
  const sizeOf = async (url) => {
    const probe = new Image();
    probe.src = url;
    try {
      await probe.decode();
      return { w: probe.naturalWidth, h: probe.naturalHeight };
    } catch {
      return null; // a missing picture is reported by the health check
    }
  };
  for (const img of document.images) {
    if (!visible(img) || !img.complete || !img.naturalWidth) continue;
    const size = await sizeOf(img.currentSrc || img.src);
    if (!size) continue;
    const r = img.getBoundingClientRect();
    const fit = getComputedStyle(img).objectFit;
    judge(new URL(img.currentSrc || img.src).pathname, img.clientWidth || r.width, img.clientHeight || r.height, size.w, size.h, fit === "cover" || fit === "contain" ? fit : "fill");
  }
  const painted = Array.from(document.querySelectorAll("body *")).filter((el) => visible(el) && /url\(/.test(getComputedStyle(el).backgroundImage) && !/gradient/.test(getComputedStyle(el).backgroundImage));
  for (const el of painted) {
    const style = getComputedStyle(el);
    const url = /url\(["']?([^"')]+)["']?\)/.exec(style.backgroundImage)[1];
    const size = await sizeOf(url);
    if (!size) continue;
    const r = el.getBoundingClientRect();
    judge(new URL(url, location.href).pathname, el.clientWidth || r.width, el.clientHeight || r.height, size.w, size.h, style.backgroundSize === "contain" ? "contain" : "cover");
  }
  return offenders;
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
