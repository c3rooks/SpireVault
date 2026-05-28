/**
 * Discord Interactions webhook — handles slash commands and message
 * commands ("right-click → Apps → Mirror to SpireVault") from the
 * Discord LFG bridge bot.
 *
 * Two routes the bot may invoke:
 *
 *   1. Application command MESSAGE (type=3) — context-menu on a
 *      Discord message. The webhook receives the full target message
 *      object in `data.resolved.messages`. We extract author + text
 *      and create a SpireVault mirror.
 *
 *   2. Application command CHAT_INPUT (type=1) — `/spire-mirror`
 *      slash command. The user types it in a channel; the next
 *      message they paste in the channel becomes the mirror source.
 *      (Less ergonomic than the message context-menu, but useful for
 *      Discord clients that don't expose context-menus.)
 *
 * Security:
 *
 *   Every request is Ed25519-signed by Discord. The bot's public key
 *   (env.DISCORD_PUBLIC_KEY) is on Discord's General Information
 *   page. We MUST verify EVERY incoming request — Discord even tests
 *   this during the initial endpoint validation by sending invalid
 *   signatures and expecting us to 401 them.
 *
 *   Web Crypto's SubtleCrypto supports Ed25519 in modern Cloudflare
 *   Workers runtimes (nodejs_compat_v2 / pulled in by default since
 *   late 2024). No third-party crypto library required.
 *
 * Response shape (subset of the Interactions documented schema we
 * actually use):
 *
 *   { type: 1 }                                    // PONG (for the verify ping)
 *   { type: 4, data: { content, flags: 64 } }      // ephemeral message
 *
 *   "flags: 64" = MessageFlags.EPHEMERAL — the reply is only visible
 *   to the user who triggered the command. We always reply ephemeral
 *   so the bot doesn't spam the channel.
 *
 * NOT in scope for v0:
 *
 *   - Deferred responses (we always respond inside the 3s window)
 *   - Component interactions (buttons / select menus)
 *   - Modal submissions
 *   - Autocomplete
 *
 *   These can land in v1 if the bot grows a richer UX. For now the
 *   single end-to-end path is "user right-clicks a message → mirror
 *   is created → ephemeral 'mirrored' reply with the SpireVault URL."
 */

import type { Env } from "./types";
import { createMirror } from "./coop-mirror";

// ────────────────────────────────────────────────────────────────────
// Discord constants
// ────────────────────────────────────────────────────────────────────

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
} as const;

const ApplicationCommandType = {
  CHAT_INPUT: 1,
  USER: 2,
  MESSAGE: 3,
} as const;

const MessageFlags = {
  EPHEMERAL: 64,
} as const;

const MIRROR_COMMAND_NAME = "Mirror to SpireVault";
const SLASH_MIRROR_NAME = "spire-mirror";

// Public web URL where mirrored lobbies are displayed. Reply links
// users back here so the click-through has a friendly destination.
const PUBLIC_LOBBY_URL = "https://app.spirevault.app/?tab=coop";

// ────────────────────────────────────────────────────────────────────
// Public entrypoint — called from src/index.ts route dispatch
// ────────────────────────────────────────────────────────────────────

export async function handleDiscordInteractions(
  req: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/discord/interactions") return null;
  if (req.method !== "POST") {
    return jsonResp({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (!env.DISCORD_PUBLIC_KEY) {
    // Endpoint not configured. Return 401 (not 404) so the operator
    // can tell from logs that the webhook is reaching us but not
    // configured, vs. silently 404ing.
    return new Response("Discord interactions not configured", { status: 401 });
  }

  // Read body as text BEFORE verifying — verify needs raw bytes.
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) {
    return new Response("missing signature", { status: 401 });
  }
  const ok = await verifyEd25519(env.DISCORD_PUBLIC_KEY, signature, timestamp, rawBody);
  if (!ok) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: any;
  try { body = JSON.parse(rawBody); } catch {
    return new Response("invalid json", { status: 400 });
  }

  // PING — Discord uses this on first endpoint validation AND
  // periodically to check liveness. ALWAYS respond with PONG.
  if (body && body.type === InteractionType.PING) {
    return jsonResp({ type: InteractionResponseType.PONG });
  }

  if (body && body.type === InteractionType.APPLICATION_COMMAND) {
    return await handleAppCommand(env, body);
  }

  // Unknown interaction type — be defensive and reply ephemerally
  // rather than 500ing. Discord retries 5xx responses, which would
  // double-create mirrors.
  return ephemeralReply("Hmm, I don\u2019t know how to handle that yet.");
}

// ────────────────────────────────────────────────────────────────────
// Command dispatch
// ────────────────────────────────────────────────────────────────────

async function handleAppCommand(env: Env, body: any): Promise<Response> {
  const data = body.data || {};
  const commandName: string = data.name || "";
  const commandType: number = data.type || ApplicationCommandType.CHAT_INPUT;

  if (commandType === ApplicationCommandType.MESSAGE) {
    return await handleMessageContextMenu(env, body, data);
  }

  if (
    commandType === ApplicationCommandType.CHAT_INPUT &&
    commandName === SLASH_MIRROR_NAME
  ) {
    return await handleSlashMirror(env, body, data);
  }

  return ephemeralReply(
    `Unknown command. Try the right-click \u201C${MIRROR_COMMAND_NAME}\u201D ` +
    `menu on any LFG message.`,
  );
}

/**
 * MESSAGE command — user right-clicked a Discord message and chose
 * "Apps → Mirror to SpireVault". The interaction payload includes
 * the target message in data.resolved.messages keyed by data.target_id.
 */
async function handleMessageContextMenu(
  env: Env,
  body: any,
  data: any,
): Promise<Response> {
  const targetId: string | undefined = data.target_id;
  const resolved = data.resolved || {};
  const messages = resolved.messages || {};
  const message = targetId ? messages[targetId] : null;
  if (!message || typeof message !== "object") {
    return ephemeralReply("Couldn\u2019t find that message. Try again.");
  }

  const guildId: string = body.guild_id || "";
  const channelId: string = body.channel_id || message.channel_id || "";
  const allowed = await isChannelAllowed(env, guildId, channelId);
  if (!allowed) {
    return ephemeralReply(
      "This channel isn\u2019t enabled for SpireVault mirroring. " +
      "Ask a mod to enable it.",
    );
  }

  const author = message.author || {};
  const authorName: string =
    author.global_name || author.username || "Discord user";
  const authorAvatarUrl: string | undefined = author.avatar
    ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`
    : undefined;
  const messageContent: string = message.content || "";
  if (!messageContent.trim()) {
    return ephemeralReply(
      "That message has no text content I can mirror " +
      "(probably an embed or attachment-only post).",
    );
  }

  // Build the jump URL — Discord canonical form is
  // https://discord.com/channels/<guild>/<channel>/<message>.
  const jumpUrl = guildId && channelId && targetId
    ? `https://discord.com/channels/${guildId}/${channelId}/${targetId}`
    : "";

  const mirror = await createMirror(env, {
    discordMessageId: targetId!,
    discordChannelId: channelId,
    discordChannelName: await resolveChannelName(env, guildId, channelId),
    discordGuildId: guildId,
    discordGuildName: body.guild?.name || "Discord",
    discordJumpUrl: jumpUrl,
    authorName,
    authorAvatarUrl,
    rawMessage: messageContent,
  });

  return ephemeralReply(
    `\u2705 Mirrored to SpireVault. Other players will see this in the ` +
    `lobby list for ~30 minutes.\n\n` +
    `View live: ${PUBLIC_LOBBY_URL}\n` +
    `Mirror id: \`${mirror.mirrorId}\``,
  );
}

/**
 * Slash command path — user typed `/spire-mirror message:"..."`.
 * The first option of the command is the LFG message text.
 */
async function handleSlashMirror(
  env: Env,
  body: any,
  data: any,
): Promise<Response> {
  const options: Array<{ name: string; value: string }> = data.options || [];
  const messageOpt = options.find((o) => o.name === "message");
  const messageContent = typeof messageOpt?.value === "string" ? messageOpt.value : "";
  if (!messageContent.trim()) {
    return ephemeralReply(
      "Usage: `/spire-mirror message:<your LFG post>`. " +
      "Try the right-click menu on an existing message for a smoother flow.",
    );
  }

  const guildId: string = body.guild_id || "";
  const channelId: string = body.channel_id || "";
  const allowed = await isChannelAllowed(env, guildId, channelId);
  if (!allowed) {
    return ephemeralReply(
      "This channel isn\u2019t enabled for SpireVault mirroring. " +
      "Ask a mod to enable it.",
    );
  }

  const member = body.member || {};
  const user = (member.user || body.user || {});
  const authorName: string =
    user.global_name || user.username || "Discord user";
  const authorAvatarUrl: string | undefined = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : undefined;

  // Slash-command-created mirrors have no source message to jump to,
  // so we use the channel URL as the fallback destination.
  const jumpUrl = guildId && channelId
    ? `https://discord.com/channels/${guildId}/${channelId}`
    : "";

  // Synthesize a stable dedup id from user + content hash + day-
  // bucket so re-running the same slash command in a 30-min window
  // doesn't duplicate, but a different message creates a new mirror.
  const dedupId = await synthesizeDedupId(
    `${user.id || "?"}:${channelId}:${messageContent}`,
  );

  const mirror = await createMirror(env, {
    discordMessageId: dedupId,
    discordChannelId: channelId,
    discordChannelName: await resolveChannelName(env, guildId, channelId),
    discordGuildId: guildId,
    discordGuildName: body.guild?.name || "Discord",
    discordJumpUrl: jumpUrl,
    authorName,
    authorAvatarUrl,
    rawMessage: messageContent,
  });

  return ephemeralReply(
    `\u2705 Mirrored to SpireVault. Visible in the lobby list for ~30 min.\n` +
    `View live: ${PUBLIC_LOBBY_URL}\n` +
    `Mirror id: \`${mirror.mirrorId}\``,
  );
}

// ────────────────────────────────────────────────────────────────────
// Channel allowlist (KV-backed, mod-controlled)
// ────────────────────────────────────────────────────────────────────

/**
 * The channel allowlist is stored at `mirror:allow:<guildId>` as a
 * JSON `{ channelIds: string[] }`. Mods toggle channels by hitting
 * a separate operator endpoint (TODO: add to /admin in v0.12.1).
 *
 * For the very first deploy, if NO allowlist exists for the guild,
 * mirroring is DISABLED for safety. A mod must explicitly opt in
 * any channel before the bot will create mirrors from it.
 *
 * Bypass for testing: set env.DISCORD_BOT_ALLOW_ALL = "1" via
 * wrangler secret to skip the allowlist (use ONLY on the test
 * guild, never in production with the official STS server).
 */
async function isChannelAllowed(
  env: Env,
  guildId: string,
  channelId: string,
): Promise<boolean> {
  if (!guildId || !channelId) return false;
  // Test-only bypass — set in localdev / staging only.
  const bypass = (env as any).DISCORD_BOT_ALLOW_ALL;
  if (bypass === "1") return true;
  const key = `mirror:allow:${guildId}`;
  const blob = await env.LOBBIES.get(key, { type: "json" }) as
    | { channelIds?: string[] } | null;
  if (!blob || !Array.isArray(blob.channelIds)) return false;
  return blob.channelIds.includes(channelId);
}

/**
 * Best-effort channel name resolver. Discord's interaction payload
 * doesn't include channel name reliably; for v0 we leave it blank
 * (frontend falls back to the channel id). v0.12.1 can hit Discord's
 * REST API to look it up with a bot token, cached in KV.
 */
async function resolveChannelName(
  _env: Env,
  _guildId: string,
  _channelId: string,
): Promise<string> {
  return "discord";
}

// ────────────────────────────────────────────────────────────────────
// Ed25519 verification (Web Crypto)
// ────────────────────────────────────────────────────────────────────

/**
 * Verify the Discord-signed body. The signature payload is the raw
 * timestamp string concatenated with the raw body text.
 *
 * Discord's public key is hex-encoded; we have to import it as raw
 * key material with the Ed25519 algorithm name.
 *
 * Failure modes are all treated as "invalid" — never throw, never
 * accidentally allow.
 */
async function verifyEd25519(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  try {
    const publicKey = hexToBytes(publicKeyHex);
    const signature = hexToBytes(signatureHex);
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      message,
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const len = clean.length / 2 | 0;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Stable dedup id derived from "<userId>:<channel>:<content>". We
 * SHA-256 it so the value is fixed-length and safe to use as a key.
 */
async function synthesizeDedupId(seed: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(seed),
  );
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 12; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return "slash_" + hex;
}

// ────────────────────────────────────────────────────────────────────
// Response helpers
// ────────────────────────────────────────────────────────────────────

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ephemeralReply(content: string): Response {
  return jsonResp({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: MessageFlags.EPHEMERAL },
  });
}
