/**
 * GET /coop — the app, with co-op link-preview tags.
 *
 * The page a visitor gets is the same index.html as before; only the Open
 * Graph and Twitter tags differ, so a co-op link pasted into Discord shows a
 * co-op card (see _shared/coop-embed.js). If anything here goes wrong the
 * untouched page is served, so /coop can never be worse than it was.
 */
import { withCoopEmbed } from "./_shared/coop-embed.js";

export async function onRequestGet(context) {
  const page = await context.next();
  const type = page.headers.get("content-type") || "";
  if (!page.ok || !type.includes("text/html")) return page;
  try {
    const html = withCoopEmbed(await page.clone().text());
    const headers = new Headers(page.headers);
    // The body is no longer the stored file, so its length, validator and
    // encoding are not ours.
    headers.delete("content-length");
    headers.delete("etag");
    headers.delete("content-encoding");
    return new Response(html, { status: page.status, headers });
  } catch {
    return page;
  }
}
