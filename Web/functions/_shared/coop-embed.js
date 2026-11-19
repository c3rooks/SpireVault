/**
 * Link-preview tags for /coop, the address the "Share to Discord" post
 * carries (lib/coop-play-share.js).
 *
 * /coop is the app itself (the same index.html every path gets), so pasted
 * into Discord it used to unfurl as the stats pitch: "Drop your STS2 save
 * folder…" with the stats picture. `withCoopEmbed` swaps the seven Open Graph
 * and Twitter tags for co-op ones and leaves every other byte alone,
 * including the browser-tab title and the search description.
 *
 * Plain string work, no HTMLRewriter, so Web/scripts/verify-coop-share.mjs
 * can run it over the real index.html in Node.
 */

export const COOP_EMBED = Object.freeze({
  title: "Play Slay the Spire 2 co-op · SpireVault",
  description:
    "Tap Play and get matched with other Slay the Spire 2 players, up to four in a party. Add each other on Steam and climb together. Free.",
  image: "https://app.spirevault.app/assets/og-coop-v3.jpg",
  url: "https://app.spirevault.app/coop",
});

const TAGS = Object.freeze([
  ['property="og:title"', COOP_EMBED.title],
  ['property="og:description"', COOP_EMBED.description],
  ['property="og:image"', COOP_EMBED.image],
  ['property="og:url"', COOP_EMBED.url],
  ['name="twitter:title"', COOP_EMBED.title],
  ['name="twitter:description"', COOP_EMBED.description],
  ['name="twitter:image"', COOP_EMBED.image],
]);

/**
 * @param {string} html the app's index.html
 * @returns {string} the same page with co-op preview tags; unchanged if a tag is missing
 */
export function withCoopEmbed(html) {
  return TAGS.reduce(
    (page, [key, value]) => page.replace(new RegExp(`(<meta ${key} content=")[^"]*(")`), (_all, open, close) => `${open}${value}${close}`),
    html,
  );
}
