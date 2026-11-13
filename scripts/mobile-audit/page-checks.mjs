/**
 * Page-side checks for the phone audit (scripts/audit-mobile.mjs).
 *
 * `collectFindings` is serialised by Playwright and run inside the page, so it
 * must not reference anything outside its own body — every helper lives inside
 * it. It only reads the page; the one thing it changes is scroll position,
 * which it puts back before returning.
 *
 * What it looks for is what makes a page hard to use on a phone, measured
 * rather than judged by eye:
 *
 *   offscreen   text or a control that runs past the edge of the screen and
 *               is not inside something you can swipe sideways
 *   clipped     text or a control cut by a box that hides its overflow
 *   truncated   text cut by its own box (with or without an ellipsis)
 *   targets     controls smaller than a fingertip
 *   smallText   text below a readable size
 *   zoomInputs  form fields under 16px, which make iOS Safari zoom the page
 *   covered     controls sitting under something else, so a tap misses them
 *   pinned      bars that stay on screen while scrolling, and how much of the
 *               screen they take
 *   scrollers   areas that scroll sideways (not a fault; reported for review)
 *
 * @param {{
 *   root?: string,
 *   ignore?: string,
 *   minTapPx: number,
 *   goodTapPx: number,
 *   minTextPx: number,
 *   goodTextPx: number,
 *   zoomSafeInputPx: number,
 *   maxSamples: number,
 *   maxCoveredProbes: number,
 * }} limits
 */
export function collectFindings(limits) {
  const EDGE_TOLERANCE_PX = 1;
  const MIN_BOX_PX = 0.5;
  // Smaller than this in either direction is a visually-hidden helper (a
  // screen-reader label, a file input behind a button), not something on screen.
  const MIN_SEEN_PX = 2;
  const WIDE_BAR_RATIO = 0.6;
  const PIN_PROBE_PX = 120;
  const PIN_MIN_SCROLL_PX = 240;
  const SNIPPET_LENGTH = 48;
  const INTERACTIVE = [
    "a[href]",
    "button",
    '[role="button"]',
    '[role="tab"]',
    '[role="link"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="option"]',
    'input:not([type="hidden"])',
    "select",
    "textarea",
    "summary",
    "[data-action]",
  ].join(",");
  const TEXT_FIELD_SKIP = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "file", "color", "image"]);

  const root = (limits.root && document.querySelector(limits.root)) || document.body;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const startScroll = { x: window.scrollX, y: window.scrollY };
  const styleCache = new WeakMap();

  /** @param {Element} el */
  const styleOf = (el) => {
    const cached = styleCache.get(el);
    if (cached) return cached;
    const style = getComputedStyle(el);
    styleCache.set(el, style);
    return style;
  };

  /** A short, stable label for an element: tag, id, first classes, some text. */
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return "(nothing)";
    const id = el.id ? `#${el.id}` : "";
    const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    const cls = classes.length ? `.${classes.join(".")}` : "";
    const action = el.getAttribute("data-action");
    const attr = action ? `[data-action=${action}]` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}${attr}`;
  };

  /** @param {Element} el */
  const snippet = (el) => {
    const label = el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.getAttribute("placeholder") || "";
    const text = label.replace(/\s+/g, " ").trim();
    return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
  };

  /** Text that belongs to this element itself, not to its children. */
  const ownText = (el) => {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.nodeValue;
    }
    return text.replace(/\s+/g, " ").trim();
  };

  /** @param {Element} el */
  const isShown = (el) => {
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > MIN_BOX_PX && rect.height > MIN_BOX_PX;
  };

  /** @param {CSSStyleDeclaration} style */
  const scrollsSideways = (style) => style.overflowX === "auto" || style.overflowX === "scroll";
  /** @param {CSSStyleDeclaration} style */
  const hidesSideways = (style) => style.overflowX === "hidden" || style.overflowX === "clip";
  /** @param {CSSStyleDeclaration} style */
  const hidesVertically = (style) => style.overflowY !== "visible";

  /**
   * Where an element can actually be seen: its box intersected with every
   * ancestor that clips. Also reports the nearest sideways scroller (content
   * inside one is reachable by swiping) and whether a non-scrolling ancestor
   * is what cut it.
   * @param {Element} el
   */
  const visibility = (el) => {
    const rect = el.getBoundingClientRect();
    let left = rect.left;
    let right = rect.right;
    let top = rect.top;
    let bottom = rect.bottom;
    let scroller = null;
    let clipper = null;
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = styleOf(node);
      const box = node.getBoundingClientRect();
      if (scrollsSideways(style) && node.scrollWidth > node.clientWidth + EDGE_TOLERANCE_PX) {
        scroller = scroller || node;
        continue;
      }
      if (hidesSideways(style) && node !== document.body) {
        if (!scroller && (box.left > left + EDGE_TOLERANCE_PX || box.right < right - EDGE_TOLERANCE_PX)) clipper = clipper || node;
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (hidesVertically(style) && node !== document.body) {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
      if (style.position === "fixed") break;
    }
    return {
      rect,
      seenWidth: Math.max(0, right - left),
      seenHeight: Math.max(0, bottom - top),
      scroller,
      clipper,
    };
  };

  /** Keeps at most `limits.maxSamples` examples but counts every case. */
  const bucket = () => ({ count: 0, samples: [] });
  const add = (target, sample) => {
    target.count += 1;
    if (target.samples.length < limits.maxSamples) target.samples.push(sample);
  };

  const report = {
    viewport: { width: viewportWidth, height: viewportHeight },
    pageOverflowPx: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
    pageHeightPx: document.documentElement.scrollHeight,
    offscreen: bucket(),
    clipped: bucket(),
    truncated: bucket(),
    targetsTooSmall: bucket(),
    targetsTight: bucket(),
    targetsChecked: 0,
    textTooSmall: bucket(),
    textSmall: bucket(),
    textChecked: 0,
    zoomInputs: bucket(),
    covered: bucket(),
    scrollers: [],
    pinned: { topPx: 0, bottomPx: 0, bars: [], floating: [] },
    contentStartPx: null,
    brokenImages: bucket(),
  };

  window.scrollTo(0, 0);

  // ---- walk every element once -------------------------------------------
  // Developer-only widgets are taken out of the page for the measurement:
  // they are not what a visitor gets, and one floating over the tab bar would
  // otherwise be reported as covering it.
  const ignored = limits.ignore ? Array.from(root.querySelectorAll(limits.ignore)) : [];
  const ignoredDisplay = ignored.map((el) => el.style.display);
  ignored.forEach((el) => {
    el.style.display = "none";
  });
  const all = Array.from(root.querySelectorAll("*")).filter(isShown);
  const interactive = [];
  const seenScrollers = new Set();

  for (const el of all) {
    const style = styleOf(el);
    const text = ownText(el);
    const isControl = el.matches(INTERACTIVE);
    const isTopControl = isControl && !(el.parentElement && el.parentElement.closest(INTERACTIVE));

    if (scrollsSideways(style) && el.scrollWidth > el.clientWidth + EDGE_TOLERANCE_PX && !seenScrollers.has(el)) {
      seenScrollers.add(el);
      report.scrollers.push({
        el: describe(el),
        shows: Math.round(el.clientWidth),
        holds: Math.round(el.scrollWidth),
      });
    }

    if (el.tagName === "IMG" && el.complete && el.naturalWidth === 0 && el.getAttribute("src")) {
      add(report.brokenImages, { el: describe(el), src: el.getAttribute("src") });
    }

    if (!text && !isTopControl) continue;
    const seen = visibility(el);
    if (seen.seenWidth < MIN_SEEN_PX || seen.seenHeight < MIN_SEEN_PX) continue;
    const { rect } = seen;
    // Parked wholly above or left of the page (a skip link waiting for focus,
    // an off-canvas file input): hidden on purpose, so not a finding.
    if (rect.bottom <= 0 || rect.right <= 0) continue;

    // -- runs past the edge of the screen ----------------------------------
    if (!seen.scroller) {
      const overhang = Math.max(rect.right - viewportWidth, -rect.left);
      if (overhang > EDGE_TOLERANCE_PX) {
        add(report.offscreen, { el: describe(el), text: snippet(el), px: Math.round(overhang) });
      } else if (seen.clipper && seen.seenWidth < rect.width - EDGE_TOLERANCE_PX) {
        add(report.clipped, {
          el: describe(el),
          text: snippet(el),
          px: Math.round(rect.width - seen.seenWidth),
          by: describe(seen.clipper),
        });
      }
    }

    // -- cut by its own box --------------------------------------------------
    if (text && hidesSideways(style) && el.scrollWidth > el.clientWidth + EDGE_TOLERANCE_PX) {
      add(report.truncated, {
        el: describe(el),
        text: snippet(el),
        px: Math.round(el.scrollWidth - el.clientWidth),
        ellipsis: style.textOverflow === "ellipsis",
      });
    }

    // -- text size -------------------------------------------------------------
    if (text) {
      report.textChecked += 1;
      const size = parseFloat(style.fontSize);
      if (size < limits.minTextPx) add(report.textTooSmall, { el: describe(el), text: snippet(el), px: Math.round(size * 10) / 10 });
      else if (size < limits.goodTextPx) add(report.textSmall, { el: describe(el), text: snippet(el), px: Math.round(size * 10) / 10 });
    }

    // -- form fields that make iOS zoom ---------------------------------------
    const isTextField =
      el.tagName === "SELECT" || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !TEXT_FIELD_SKIP.has(el.type));
    if (isTextField && parseFloat(style.fontSize) < limits.zoomSafeInputPx) {
      add(report.zoomInputs, { el: describe(el), text: snippet(el), px: parseFloat(style.fontSize) });
    }

    // -- tap targets -------------------------------------------------------------
    if (!isTopControl || el.disabled || el.getAttribute("aria-disabled") === "true" || style.pointerEvents === "none") continue;
    interactive.push(el);
    // A link inside a sentence is exempt: it cannot be bigger than its line.
    const parentText = el.parentElement ? ownText(el.parentElement) : "";
    if (style.display.startsWith("inline") && el.tagName === "A" && parentText.length > 0) continue;
    // A checkbox or radio is tapped through its label.
    const label = (el.tagName === "INPUT" && el.closest("label")) || null;
    const box = label ? label.getBoundingClientRect() : rect;
    const smallest = Math.min(box.width, box.height);
    report.targetsChecked += 1;
    const sample = { el: describe(el), text: snippet(el), size: `${Math.round(box.width)}x${Math.round(box.height)}` };
    if (smallest < limits.minTapPx) add(report.targetsTooSmall, sample);
    else if (smallest < limits.goodTapPx) add(report.targetsTight, sample);
  }

  // ---- where the tab's own content starts --------------------------------
  const panel = root.querySelector(".tab-panel:not([hidden])");
  const body = panel && panel.querySelector(".panel-body, [id$='-body']");
  const firstContent = body && Array.from(body.children).find(isShown);
  if (firstContent) report.contentStartPx = Math.round(firstContent.getBoundingClientRect().top + window.scrollY);

  // ---- bars that stay on screen while scrolling ----------------------------
  const maxScroll = document.documentElement.scrollHeight - viewportHeight;
  const positioned = all.filter((el) => {
    const position = styleOf(el).position;
    return position === "fixed" || position === "sticky";
  });
  const probeA = Math.min(Math.max(0, maxScroll), PIN_MIN_SCROLL_PX + PIN_PROBE_PX);
  const probeB = Math.max(0, probeA - PIN_PROBE_PX);
  const canScroll = probeA - probeB >= PIN_PROBE_PX - 1;
  window.scrollTo(0, probeB);
  const topsAtB = positioned.map((el) => el.getBoundingClientRect().top);
  window.scrollTo(0, probeA);
  const intervals = { top: [], bottom: [] };
  positioned.forEach((el, index) => {
    const rect = el.getBoundingClientRect();
    const isFixed = styleOf(el).position === "fixed";
    const held = isFixed || (canScroll && Math.abs(rect.top - topsAtB[index]) < 1);
    const onScreen = rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
    if (!held || !onScreen) return;
    const seenTop = Math.max(0, rect.top);
    const seenBottom = Math.min(viewportHeight, rect.bottom);
    const entry = { el: describe(el), top: Math.round(rect.top), height: Math.round(seenBottom - seenTop), width: Math.round(rect.width) };
    if (rect.width < viewportWidth * WIDE_BAR_RATIO) {
      report.pinned.floating.push(entry);
      return;
    }
    // A full-screen layer (backdrop, page wrapper) is not a bar.
    if (seenBottom - seenTop > viewportHeight * 0.9) return;
    report.pinned.bars.push(entry);
    const side = (seenTop + seenBottom) / 2 < viewportHeight / 2 ? "top" : "bottom";
    intervals[side].push([seenTop, seenBottom]);
  });
  const unionLength = (ranges) => {
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
    let total = 0;
    let end = -Infinity;
    for (const [from, to] of sorted) {
      if (to <= end) continue;
      total += to - Math.max(from, end);
      end = to;
    }
    return Math.round(total);
  };
  report.pinned.topPx = unionLength(intervals.top);
  report.pinned.bottomPx = unionLength(intervals.bottom);

  // ---- controls sitting under something else --------------------------------
  // Bringing each control into view can scroll any box on the page, including
  // ones that hide their overflow, so every scroll position is put back after.
  const scrollState = [document.documentElement, document.body, ...all]
    .filter((el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)
    .map((el) => [el, el.scrollLeft, el.scrollTop]);
  for (const el of interactive.slice(0, limits.maxCoveredProbes)) {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || x >= viewportWidth || y < 0 || y >= viewportHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    const label = hit.closest("label");
    if (label && (label.contains(el) || label.htmlFor === el.id)) continue;
    add(report.covered, { el: describe(el), text: snippet(el), by: describe(hit) });
  }
  scrollState.forEach(([el, left, top]) => {
    el.scrollLeft = left;
    el.scrollTop = top;
  });
  window.scrollTo(startScroll.x, startScroll.y);
  ignored.forEach((el, index) => {
    el.style.display = ignoredDisplay[index];
  });

  return report;
}
