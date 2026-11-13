// Keeps runtime-injected legacy CSS inside the `legacy` cascade layer.
//
// The co-op code injects ~13 stylesheets at runtime (`<link>` elements from
// lib/party-finder*.js, coop-sandbox.js, party-room.js). In the new UI,
// styles.css itself is loaded into `@layer legacy`. An injected <link> would
// be *unlayered*, and unlayered CSS outranks every layer — it would beat both
// the new components and the `.pf-*` overrides inside styles.css that the
// co-op page relies on.
//
// Rather than edit those lib files (their URLs are cached immutable for a
// year, and a stale tab must keep working), this watches for each injected
// same-origin stylesheet <link>, makes it inert (`media="not all"`), and adds
// a sibling `<style>@import … layer(legacy)</style>` that applies the same
// file inside the layer.
//
// The <link> is deliberately left in the document rather than replaced: the
// injectors dedupe on it (by id, or by selectors such as
// `link[data-pf-scale-css]`), so removing it would make them inject again on
// every render.
//
// Removed together with styles.css.

const LAYERED_FLAG = "vLayered";
const LEGACY_PATH = /^\/(lib|assets)\/.+\.css(\?|$)/;

/**
 * @param {Node} node
 * @returns {node is HTMLLinkElement}
 */
function isLegacyStylesheetLink(node) {
  if (!(node instanceof HTMLLinkElement) || node.rel !== "stylesheet") return false;
  if (node.dataset[LAYERED_FLAG] === "1") return false;
  try {
    const url = new URL(node.href, window.location.href);
    return url.origin === window.location.origin && LEGACY_PATH.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

/** @param {HTMLLinkElement} link */
function relayer(link) {
  const url = new URL(link.href, window.location.href);
  const style = document.createElement("style");
  style.dataset.vLayerFor = url.pathname;
  // URL-parsed, so quotes and parentheses arrive percent-encoded.
  style.textContent = `@import url("${url.pathname}${url.search}") layer(legacy);`;
  link.dataset[LAYERED_FLAG] = "1";
  link.media = "not all";
  link.after(style);
}

/**
 * Starts re-layering. Handles stylesheets already present and any added
 * later. Returns a function that stops the observer.
 * @returns {() => void}
 */
export function startLegacyLayering() {
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    if (isLegacyStylesheetLink(link)) relayer(link);
  });
  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (isLegacyStylesheetLink(node)) relayer(node);
      });
    });
  });
  observer.observe(document.head, { childList: true });
  observer.observe(document.body, { childList: true });
  return () => observer.disconnect();
}
