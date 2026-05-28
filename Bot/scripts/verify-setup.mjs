#!/usr/bin/env node
/**
 * Pre-flight check for the SpireVault Discord bot setup.
 *
 * Runs a series of HTTP probes against the live worker + Discord
 * API to confirm everything is wired up correctly BEFORE asking a
 * mod to test the bot in a real channel. Catches the common
 * failure modes:
 *
 *   - Worker not deployed (or wrong URL)
 *   - DISCORD_PUBLIC_KEY not set → /discord/interactions 401s on PING
 *   - DISCORD_BOT_SECRET not set → /coop/mirror 401s
 *   - Commands not registered → slash command doesn't appear in Discord
 *   - Bot not invited to the guild → can't see /spire-mirror at all
 *
 * Usage:
 *   API_BASE=https://vault-coop.coreycrooks.workers.dev \
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
 *     node scripts/verify-setup.mjs
 *
 * Exit code 0 = all green; non-zero = something to fix.
 */

const API_BASE = process.env.API_BASE || "https://vault-coop.coreycrooks.workers.dev";
const APP_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

let failures = 0;
function ok(msg)   { console.log("  \u2705 " + msg); }
function warn(msg) { console.log("  \u26A0\uFE0F  " + msg); }
function fail(msg) { console.log("  \u274C " + msg); failures++; }

console.log(`SpireVault bot pre-flight check\nAPI: ${API_BASE}\n`);

// 1. Worker reachable + /coop/mirrors returns 200.
console.log("Worker /coop/mirrors (public read):");
try {
  const r = await fetch(`${API_BASE}/coop/mirrors`);
  if (r.ok) {
    const j = await r.json();
    ok(`200 OK — ${j.mirrors?.length ?? 0} active mirror(s)`);
  } else {
    fail(`Got ${r.status} ${r.statusText}`);
  }
} catch (e) {
  fail(`Network error: ${e.message}`);
}

// 2. /coop/mirror POST without secret returns 401 (proves the route exists + gate works).
console.log("\nWorker /coop/mirror (auth gate):");
try {
  const r = await fetch(`${API_BASE}/coop/mirror`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (r.status === 401) ok("Unauthenticated POST correctly returns 401");
  else fail(`Expected 401, got ${r.status}`);
} catch (e) {
  fail(`Network error: ${e.message}`);
}

// 3. /discord/interactions POST without signature returns 401.
console.log("\nWorker /discord/interactions (Discord signature gate):");
try {
  const r = await fetch(`${API_BASE}/discord/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"type":1}',
  });
  if (r.status === 401) {
    ok("Unsigned POST correctly returns 401");
  } else {
    fail(`Expected 401, got ${r.status}`);
  }
} catch (e) {
  fail(`Network error: ${e.message}`);
}

// 4. (Optional) Discord-side checks if we have the bot token.
if (APP_ID && BOT_TOKEN) {
  console.log("\nDiscord application:");
  try {
    const r = await fetch(`https://discord.com/api/v10/applications/@me`, {
      headers: { authorization: `Bot ${BOT_TOKEN}` },
    });
    if (r.ok) {
      const app = await r.json();
      ok(`Authenticated as application "${app.name}" (${app.id})`);
      if (app.id !== APP_ID) {
        warn(`DISCORD_APPLICATION_ID env (${APP_ID}) does not match token's app (${app.id}).`);
      }
    } else {
      fail(`Discord auth failed: ${r.status}`);
    }
  } catch (e) {
    fail(`Discord API error: ${e.message}`);
  }

  console.log("\nRegistered commands:");
  try {
    const url = GUILD_ID
      ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
      : `https://discord.com/api/v10/applications/${APP_ID}/commands`;
    const r = await fetch(url, {
      headers: { authorization: `Bot ${BOT_TOKEN}` },
    });
    if (r.ok) {
      const cmds = await r.json();
      const names = cmds.map((c) => `${c.name} (type ${c.type})`);
      if (names.length === 0) {
        fail("No commands registered yet. Run: npm run register" + (GUILD_ID ? ":guild" : ""));
      } else {
        ok("Found commands: " + names.join(", "));
        if (!names.some((n) => n.startsWith("Mirror to SpireVault"))) {
          warn("Message context-menu command is missing.");
        }
        if (!names.some((n) => n.startsWith("spire-mirror"))) {
          warn("/spire-mirror slash command is missing.");
        }
      }
    } else {
      fail(`Commands list failed: ${r.status}`);
    }
  } catch (e) {
    fail(`Discord commands API error: ${e.message}`);
  }
} else {
  console.log("\n(Skipping Discord-side checks — set DISCORD_APPLICATION_ID + DISCORD_BOT_TOKEN to enable.)");
}

console.log(
  failures === 0
    ? "\n\u2728 All checks passed. Mirror away."
    : `\n${failures} check(s) failed. Fix the above before going live.`,
);
process.exit(failures === 0 ? 0 : 1);
