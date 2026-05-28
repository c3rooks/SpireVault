#!/usr/bin/env node
/**
 * Emergency kill-switch for the SpireVault Discord LFG bridge.
 *
 * Two ways to kill the bridge instantly:
 *
 *   1. UNSET the Worker's DISCORD_BOT_SECRET — every POST /coop/mirror
 *      request returns 401, so the bot can't write anything new.
 *      Existing mirrors stay live until their 30-min TTL expires.
 *
 *   2. UNSET the Worker's DISCORD_PUBLIC_KEY — every POST
 *      /discord/interactions returns 401, so Discord users get an
 *      "interaction failed" error when they invoke the slash command
 *      or context-menu, with no impact on existing mirrors.
 *
 *   3. NUKE the mirror index — instant removal of every active mirror
 *      from the lobby surface. (Caches: the worker re-reads on every
 *      tick, so the change is visible in <30s.)
 *
 * This script PRINTS the commands; it does not execute them. The
 * operator runs the wrangler command themselves so the kill action
 * is a deliberate, traceable shell action.
 */

const action = process.argv[2];
const help = !action || action === "--help" || action === "-h" || action === "help";

if (help) {
  console.log(`Usage: kill-switch.mjs <mode>

Modes:
  pause-writes        Revoke DISCORD_BOT_SECRET; bot can no longer write.
                      Existing mirrors stay live until TTL (30 min).
  pause-interactions  Revoke DISCORD_PUBLIC_KEY; webhook returns 401.
  drain-now           Delete the mirror index, removing all live cards.
  status              Show the current state of all kill signals.

All modes print the exact wrangler commands to execute. Nothing
runs automatically — kill-switch is intentionally manual.`);
  process.exit(0);
}

if (action === "pause-writes") {
  console.log("\u26A0\uFE0F Pause-writes mode\n");
  console.log("Run from Backend/:");
  console.log("  wrangler secret delete DISCORD_BOT_SECRET");
  console.log("\nEffect:");
  console.log("  - POST /coop/mirror and DELETE /coop/mirror/:id return 401");
  console.log("  - Existing mirror cards continue to render until their 30-min TTL");
  console.log("  - To resume: wrangler secret put DISCORD_BOT_SECRET");
} else if (action === "pause-interactions") {
  console.log("\u26A0\uFE0F Pause-interactions mode\n");
  console.log("Run from Backend/:");
  console.log("  wrangler secret delete DISCORD_PUBLIC_KEY");
  console.log("\nEffect:");
  console.log("  - POST /discord/interactions returns 401");
  console.log("  - Discord slash command + context menu fail with 'interaction failed'");
  console.log("  - The Node bot path (POST /coop/mirror with shared secret) is unaffected");
  console.log("  - To resume: wrangler secret put DISCORD_PUBLIC_KEY");
} else if (action === "drain-now") {
  console.log("\u26A0\uFE0F Drain mode — DELETES every live mirror card\n");
  console.log("Run from Backend/:");
  console.log("  wrangler kv key delete --binding=LOBBIES --remote mirror:index");
  console.log("\nEffect:");
  console.log("  - The lobby list refresh on every client clears mirror cards on the next 30s tick");
  console.log("  - Individual mirror:lobby:* records remain until their TTL but are unindexed");
  console.log("  - Bot can immediately create new mirrors if the index is rebuilt");
} else if (action === "status") {
  console.log("Run from Backend/ to inspect the live kill state:\n");
  console.log("  # Check whether either secret is unset (will say 'No secret with name'):");
  console.log("  wrangler secret list | grep -E 'DISCORD_BOT_SECRET|DISCORD_PUBLIC_KEY'");
  console.log("  # Check whether the mirror index is empty:");
  console.log("  wrangler kv key get --binding=LOBBIES --remote mirror:index");
  console.log("  # Check live mirrors visible to clients:");
  console.log("  curl https://vault-coop.coreycrooks.workers.dev/coop/mirrors | jq '.mirrors | length'");
} else {
  console.error("Unknown mode: " + action);
  console.error("Try: kill-switch.mjs --help");
  process.exit(1);
}
