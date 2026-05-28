#!/usr/bin/env node
/**
 * Operator-controlled per-channel allowlist for SpireVault Discord
 * mirroring. The worker enforces this list — a channel that's not
 * here will get a "this channel isn't enabled" ephemeral reply when
 * a user tries to mirror.
 *
 * Usage:
 *
 *   # Add a channel to the allowlist:
 *   ADMIN_TOKEN=... API_BASE=... \
 *     node scripts/set-channel-allow.mjs add <guildId> <channelId>
 *
 *   # Remove a channel:
 *   ADMIN_TOKEN=... API_BASE=... \
 *     node scripts/set-channel-allow.mjs remove <guildId> <channelId>
 *
 *   # List the current allowlist for a guild:
 *   ADMIN_TOKEN=... API_BASE=... \
 *     node scripts/set-channel-allow.mjs list <guildId>
 *
 * This script talks to a TODO admin endpoint that doesn't exist yet
 * (planned for v0.12.1). In the interim, the allowlist can be
 * written directly via `wrangler kv:key put`:
 *
 *   wrangler kv:key put --binding=LOBBIES "mirror:allow:<guildId>" \
 *     '{"channelIds":["<channelId1>","<channelId2>"]}'
 *
 * The wrangler command is the source of truth until the admin
 * endpoint lands. This script is a stub that documents the intended
 * shape and prints the matching wrangler command for now.
 */

const action = process.argv[2];
const guildId = process.argv[3];
const channelId = process.argv[4];

if (!action || (action !== "add" && action !== "remove" && action !== "list")) {
  console.error("Usage: set-channel-allow.mjs <add|remove|list> <guildId> [channelId]");
  process.exit(1);
}
if (!guildId) {
  console.error("Missing <guildId>");
  process.exit(1);
}
if ((action === "add" || action === "remove") && !channelId) {
  console.error("Missing <channelId> for action: " + action);
  process.exit(1);
}

const key = `mirror:allow:${guildId}`;

console.log("=== SpireVault mirror allowlist ===");
console.log("Key:", key);
console.log("Action:", action);
if (channelId) console.log("Channel:", channelId);

console.log("\nUntil the /admin/mirror-allow endpoint lands in v0.12.1, run this with wrangler:");
console.log("");
if (action === "list") {
  console.log(`  cd Backend && wrangler kv key get --binding=LOBBIES --remote "${key}"`);
} else if (action === "add") {
  console.log("  # 1. Fetch the current list:");
  console.log(`  cd Backend && wrangler kv key get --binding=LOBBIES --remote "${key}"`);
  console.log("  # 2. Append <channelId> to channelIds, then put it back:");
  console.log(
    `  cd Backend && wrangler kv key put --binding=LOBBIES --remote "${key}" '{"channelIds":["${channelId}"]}'`,
  );
  console.log("  # (If the key already has entries, paste the merged JSON.)");
} else if (action === "remove") {
  console.log("  # Fetch the current list, drop the channelId, put it back:");
  console.log(`  cd Backend && wrangler kv key get --binding=LOBBIES --remote "${key}"`);
  console.log(
    `  cd Backend && wrangler kv key put --binding=LOBBIES --remote "${key}" '{"channelIds":[...remaining...]}'`,
  );
}
console.log("");
console.log("After write, the worker reads the allowlist on the next interaction (no cache).");
