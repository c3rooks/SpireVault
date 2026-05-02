/**
 * STS2 raw `.run` save file parser — JavaScript port of the Swift
 * `STS2RunParser` in TheVault/Sources/VaultCore/Parsing/STS2RunParser.swift.
 *
 * Why this exists: Slay the Spire 2 writes one `.run` file per game to
 *
 *   …/profile1/saves/history/<unix_timestamp>.run
 *
 * Each `.run` is a JSON object describing the entire run (character,
 * ascension, deck, relics, per-floor card picks, …).
 *
 * Until now the web companion only accepted the consolidated `history.json`
 * rollup that the macOS CLI produces. That rollup is a Vault-only artifact
 * — anyone who hasn't run the CLI doesn't have one. Windows users, Linux
 * users, and brand-new Mac users have a folder full of `.run` files
 * instead. This parser lets the browser read those files directly so the
 * web app stops being implicitly Mac-only.
 *
 * Schema reference (STS2 build 0.104.x, schema_version 9):
 *
 *   {
 *     "ascension": 6,
 *     "seed": "XRFSQVQP53",
 *     "start_time": 1777333156,
 *     "run_time": 1875,
 *     "win": false,
 *     "schema_version": 9,
 *     "killed_by_encounter": "ENCOUNTER.KNIGHTS_ELITE",
 *     "players": [{
 *         "id": 1,
 *         "character": "CHARACTER.DEFECT",
 *         "deck":   [{ "id": "CARD.STRIKE_DEFECT", "current_upgrade_level": 0 }],
 *         "relics": [{ "id": "RELIC.CRACKED_CORE" }],
 *         "potions": []
 *     }],
 *     "map_point_history": [[
 *         { "rooms": [{ "room_type": "monster" }],
 *           "player_stats": [{
 *               "card_choices":  [{ "card": {"id":"CARD.X"}, "was_picked": true }],
 *               "relic_choices": [{ "choice": "RELIC.X", "was_picked": true }],
 *               "current_hp": 54, "max_hp": 75, "current_gold": 114
 *           }]
 *         }
 *     ]]
 *   }
 *
 * Output shape: identical to what `normalizeRun()` in stats-engine.js
 * returns, so parsed `.run` files plug straight into `parsedRuns` and
 * the renderers don't know the difference.
 */

const VALID_CHAR_KEYS = new Set(["ironclad", "silent", "regent", "necrobinder", "defect"]);

/**
 * Quick fingerprint test: does this object look like an STS2 `.run`?
 * Returns true only if both `players[0]` and `map_point_history` are
 * present. Profile / settings / progress saves don't have both, which is
 * how we keep them from being mis-parsed as runs.
 */
export function looksLikeSTS2Run(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const players = obj.players;
  if (!Array.isArray(players) || players.length === 0) return false;
  if (!Array.isArray(obj.map_point_history)) return false;
  return true;
}

/**
 * Parse one STS2 `.run` JSON object → normalized run record.
 * Returns `null` if the object isn't actually an STS2 run (so callers
 * can chain through other parsers without throwing).
 */
export function parseSTS2Run(obj, sourceName = "unknown.run") {
  if (!looksLikeSTS2Run(obj)) return null;

  const player = obj.players[0];

  // Stable id. STS2 doesn't ship one, so we fingerprint with start_time
  // (a Unix epoch second). Falls back to seed+random if the run never
  // wrote start_time, which is rare but possible on aborted runs.
  const startEpoch = typeof obj.start_time === "number" ? obj.start_time : null;
  const id = startEpoch
    ? `sts2-${startEpoch}`
    : `sts2-${obj.seed || "noseed"}-${Math.floor(Math.random() * 1e9)}`;

  const character = parseCharacter(player.character);
  const ascension = Number.isFinite(obj.ascension) ? Math.max(0, Math.min(20, obj.ascension | 0)) : null;
  const seed = typeof obj.seed === "string" ? obj.seed : null;
  const won = obj.win === true || obj.win === 1;

  const playTimeSeconds = Number.isFinite(obj.run_time) ? obj.run_time | 0 : null;
  const startedAt = startEpoch ? new Date(startEpoch * 1000) : null;
  const endedAt = startedAt && playTimeSeconds != null
    ? new Date(startedAt.getTime() + playTimeSeconds * 1000)
    : null;

  // Floor reached = sum of every map point we visited across all acts.
  // Matches the Swift parser's behavior so the desktop and web apps
  // produce identical numbers from the same `.run` file.
  let floorReached = 0;
  if (Array.isArray(obj.map_point_history)) {
    for (const act of obj.map_point_history) {
      if (Array.isArray(act)) floorReached += act.length;
    }
  }

  // Final deck — preserve upgrade level so a +1 strike doesn't collide
  // with a base strike in the card-frequency stats. Same `<id>+<n>`
  // suffix scheme the macOS app uses.
  const deckAtEnd = Array.isArray(player.deck)
    ? player.deck
        .map((c) => {
          const raw = typeof c?.id === "string" ? c.id : null;
          if (!raw) return null;
          const upgrade = Number.isFinite(c.current_upgrade_level) ? c.current_upgrade_level | 0 : 0;
          const base = stripPrefix("CARD.", raw).toLowerCase();
          return upgrade > 0 ? `${base}+${upgrade}` : base;
        })
        .filter(Boolean)
    : [];

  const relics = Array.isArray(player.relics)
    ? player.relics
        .map((r) => (typeof r?.id === "string" ? stripPrefix("RELIC.", r.id).toLowerCase() : null))
        .filter(Boolean)
    : [];

  // Per-floor card picks. Same shape extractRuns/normalizeRun expect.
  const cardPicks = [];
  let floor = 0;
  if (Array.isArray(obj.map_point_history)) {
    for (const act of obj.map_point_history) {
      if (!Array.isArray(act)) continue;
      for (const point of act) {
        floor += 1;
        if (!point || typeof point !== "object") continue;
        const stats = Array.isArray(point.player_stats) ? point.player_stats[0] : null;
        if (!stats) continue;
        const choices = Array.isArray(stats.card_choices) ? stats.card_choices : null;
        if (!choices || choices.length === 0) continue;
        const offered = choices
          .map((c) => {
            const id = c?.card?.id;
            return typeof id === "string" ? stripPrefix("CARD.", id).toLowerCase() : null;
          })
          .filter(Boolean);
        const picked = (() => {
          const hit = choices.find((c) => c?.was_picked === true);
          if (!hit) return null;
          const id = hit?.card?.id;
          return typeof id === "string" ? stripPrefix("CARD.", id).toLowerCase() : null;
        })();
        if (offered.length || picked) {
          cardPicks.push({ floor, offered, picked, source: pickSource(point) });
        }
      }
    }
  }

  return {
    id,
    character,
    ascension,
    seed,
    won,
    floorReached,
    playTimeSeconds,
    startedAt,
    endedAt,
    relics,
    deckAtEnd,
    cardPicks,
    sourceFile: sourceName,
  };
}

function stripPrefix(prefix, raw) {
  if (typeof raw !== "string") return "";
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function parseCharacter(raw) {
  if (typeof raw !== "string") return null;
  const stripped = stripPrefix("CHARACTER.", raw).toLowerCase().replace(/\s+/g, "");
  if (stripped === "ironclad" || stripped === "ic") return "ironclad";
  if (stripped === "silent" || stripped === "si") return "silent";
  if (stripped === "regent" || stripped === "re" || stripped === "rg" || stripped === "watcher") return "regent";
  if (stripped === "necrobinder" || stripped === "nb" || stripped === "binder") return "necrobinder";
  if (stripped === "defect" || stripped === "df" || stripped === "de") return "defect";
  return null;
}

function pickSource(point) {
  const mapType = (point?.map_point_type ?? "").toLowerCase();
  if (mapType === "boss") return "boss";
  if (mapType === "elite") return "elite";
  if (mapType === "shop") return "shop";
  const room = Array.isArray(point?.rooms) ? point.rooms[0] : null;
  const roomType = (room?.room_type ?? "").toLowerCase();
  if (roomType === "monster" || roomType === "combat") return "combat";
  if (roomType === "elite") return "elite";
  if (roomType === "boss") return "boss";
  if (roomType === "shop") return "shop";
  if (roomType === "event") return "event";
  if (roomType === "ancient" || roomType === "treasure") return "chest";
  return "unknown";
}
