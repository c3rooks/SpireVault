#!/usr/bin/env node
/**
 * Register the SpireVault Discord application commands.
 *
 * Run ONCE after creating the Discord application:
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... \
 *     node scripts/register-commands.mjs            # global
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
 *     node scripts/register-commands.mjs --guild    # guild-scoped (instant)
 *
 * Guild-scoped commands are recommended for the TEST guild during
 * development — they propagate to clients within ~1 second, vs. the
 * 1-hour propagation window for global commands. Production rollout
 * should use global registration so anyone who installs the app gets
 * the commands automatically.
 *
 * Commands registered:
 *
 *   1. Message context-menu command "Mirror to SpireVault"
 *      → right-click any message → Apps → Mirror to SpireVault
 *      Discord docs call this an APPLICATION_COMMAND of type MESSAGE (3).
 *
 *   2. Slash command /spire-mirror message:<text>
 *      → typed directly in chat for clients that don't expose Apps menu
 *      APPLICATION_COMMAND of type CHAT_INPUT (1).
 *
 * Both terminate at the same Worker endpoint
 * (POST /discord/interactions) — the worker dispatches by command
 * type. See Backend/src/discord-interactions.ts for the handler.
 *
 * Idempotent: re-running OVERWRITES the existing command set rather
 * than appending. This is the documented Discord behavior for the
 * PUT /applications/{id}/commands endpoint.
 */

const APP_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const useGuild = process.argv.includes("--guild");

if (!APP_ID) {
  console.error("Missing DISCORD_APPLICATION_ID env var.");
  process.exit(1);
}
if (!BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN env var.");
  process.exit(1);
}
if (useGuild && !GUILD_ID) {
  console.error("--guild requires DISCORD_GUILD_ID env var.");
  process.exit(1);
}

// Discord command shape — see
// https://discord.com/developers/docs/interactions/application-commands.
// type 2 = USER, type 3 = MESSAGE (context-menu), type 1 = CHAT_INPUT.
const commands = [
  {
    name: "Mirror to SpireVault",
    type: 3,
    // Allow only mods in the official server context. The bot
    // operator can adjust default_member_permissions in the Discord
    // dev portal AFTER install — leaving it null here means anyone
    // in the server can mirror, which is the right default for an
    // LFG channel (the whole point is community participation).
    default_member_permissions: null,
    dm_permission: false,
  },
  {
    name: "spire-mirror",
    type: 1,
    description: "Mirror an LFG post into SpireVault's lobby finder",
    options: [
      {
        name: "message",
        description: "Your LFG post (e.g. 'Need 1 for A10 Silent, voice optional')",
        type: 3, // STRING
        required: true,
        min_length: 4,
        max_length: 280,
      },
    ],
    dm_permission: false,
  },
];

const url = useGuild
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const r = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${BOT_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!r.ok) {
  const text = await r.text();
  console.error(`Registration failed: ${r.status} ${r.statusText}\n${text}`);
  process.exit(2);
}

const data = await r.json();
console.log(`Registered ${data.length} command(s) ${useGuild ? "to guild " + GUILD_ID : "globally"}:`);
for (const cmd of data) console.log(`  - ${cmd.name} (type=${cmd.type}, id=${cmd.id})`);
console.log(
  useGuild
    ? "\nGuild commands propagate within ~1 second."
    : "\nGlobal commands can take up to 1 hour to propagate to all clients.",
);
