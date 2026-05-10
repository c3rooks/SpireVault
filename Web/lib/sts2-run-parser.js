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
 * Schema versions we have explicitly tested against. STS2 is in early
 * access and ships every few weeks; the user already has runs from
 * schema 8 and schema 9 on disk simultaneously. We don't refuse to
 * parse unknown schema versions (most fields are stable across bumps,
 * so a degraded read is still useful), but we DO record the schema we
 * saw so the UI can show a "this run is from a newer build, some stats
 * may be off" banner instead of silently producing wrong numbers.
 *
 * To bump after testing: add the new number, ship a build. To support
 * a wholly new schema: write a sibling parser and dispatch in
 * `extractRuns` based on schema_version.
 */
export const KNOWN_SCHEMA_VERSIONS = new Set([8, 9]);

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

  // Schema-tolerant character extraction. Older STS2 builds wrote a
  // bare string at `players[0].character` ("CHARACTER.SILENT"). Newer
  // builds (schema 16+) sometimes ship the character under a different
  // key, or as a nested object with an `id` field, or lower-case it,
  // or drop the namespace prefix entirely, or in the worst case
  // promote it to the run-root level (`obj.character_id`,
  // `obj.run_class`). Rather than guess, we walk a list of likely
  // candidates and return on the first hit. Anything else falls
  // through to a last-resort scan that picks any string value on the
  // player or run root whose lowered form matches a known character
  // key — schema-bump-proof for the five characters we know about
  // today and forgiving when STS2 ships a sixth.
  //
  // Order: player → root → deck-card-namespace inference. Player wins
  // because in legacy schemas the root object can carry a `character`
  // field that's actually a *target* (event reward etc.), not the
  // player's class. Deck inference is the LAST resort because it's
  // load-bearing for schema-16+ partial writes where the explicit
  // character field is missing or empty but the deck has already
  // been seeded with the starter strike+defend cards, every one of
  // which is namespaced to the character (e.g. "CARD.SILENT_STRIKE",
  // "CARD.IRONCLAD_STRIKE"). The user reported "Unknown" rendering
  // for fresh Silent runs — this is the safety net.
  let character =
    extractCharacter(player) ||
    parseCharacter(player.character) ||
    extractCharacter(obj) ||
    parseCharacter(obj.character) ||
    parseCharacter(obj.character_id) ||
    parseCharacter(obj.run_class) ||
    null;
  if (!character) {
    character = inferCharacterFromDeck(player) || inferCharacterFromRelics(player) || null;
  }
  const ascension = Number.isFinite(obj.ascension) ? Math.max(0, Math.min(20, obj.ascension | 0)) : null;
  const seed = typeof obj.seed === "string" ? obj.seed : null;
  const won = obj.win === true || obj.win === 1;
  // In-progress detection. STS2 only writes the final `win` field
  // (true|false) when a run actually ends — either victory or defeat
  // or the player explicitly abandons. While the player is still
  // mid-run, the save state has the same run shape (players + map)
  // but `win` is missing entirely. We treat that as the live "you're
  // currently in a game" signal so the overview can surface it.
  // Belt-and-suspenders: also require either no `killed_by_encounter`
  // or no `run_time` so we don't false-positive a malformed completed
  // run with an explicit `win: null`.
  const winExplicit = obj.win === true || obj.win === false || obj.win === 1 || obj.win === 0;
  const killedByMissing = !obj.killed_by_encounter && !obj.killedByEncounter;
  const runTimeMissing = !Number.isFinite(obj.run_time) || obj.run_time === 0;
  const inProgress = !winExplicit && !obj.was_abandoned && (killedByMissing || runTimeMissing);
  // STS2 `game_mode` literal — typical values "standard", "daily",
  // "custom", "trial". We pass through whatever the file reports
  // (lower-cased + clamped) so downstream UI can decide how to badge
  // it without us having to ship a new client every time STS2 adds a
  // new mode. `null` means the field was missing (older schema).
  const rawMode = typeof obj.game_mode === "string" ? obj.game_mode.trim().toLowerCase() : "";
  const gameMode = rawMode ? rawMode.slice(0, 24) : null;
  const wasAbandoned = obj.was_abandoned === true || obj.was_abandoned === 1;
  // Daily-run modifiers (from STS2 `modifiers: ["MODIFIER.DOUBLE_TIME", ...]`).
  // Stripped of the prefix and lowercased so the UI can show pretty chips
  // without leaking the raw STS2 namespace.
  const modifiers = Array.isArray(obj.modifiers)
    ? obj.modifiers
        .map((m) => (typeof m === "string" ? stripPrefix("MODIFIER.", m).toLowerCase() : null))
        .filter(Boolean)
        .slice(0, 8)
    : [];

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

  // Per-floor card picks AND act-by-act path. Both walk the same
  // `map_point_history` so we do them in one pass.
  //
  // pathByAct shape:
  //   [
  //     { act: 1, nodes: [{ floor: 1, type: "combat" }, ...] },
  //     { act: 2, nodes: [...] },
  //     { act: 3, nodes: [...] },
  //     ... (architect / sub-acts if STS2 ships more)
  //   ]
  //
  // `type` is one of: "combat" | "elite" | "shop" | "rest" | "event"
  //                 | "chest" | "boss" | "unknown"
  //
  // This is what powers the "Act Timeline" view in the run-detail
  // modal — a faithful representation of the linear path the player
  // walked, not a fabricated branching map. The .run file does NOT
  // contain unvisited nodes or branch points, so we cannot draw a
  // full STS map without making things up. Every node in pathByAct
  // is a node the player physically visited.
  const cardPicks = [];
  const pathByAct = [];
  let floor = 0;
  // Track the latest `player_stats` we see across the whole walk so an
  // in-progress run can surface live HP / gold without us re-walking
  // the map. STS2 writes a stats block on every map point the player
  // visits, so the last one in chronological order is "right now".
  let latestStats = null;
  let latestRoomType = null;
  if (Array.isArray(obj.map_point_history)) {
    obj.map_point_history.forEach((act, actIdx) => {
      if (!Array.isArray(act)) return;
      const actNodes = [];
      for (const point of act) {
        floor += 1;
        const type = pickSource(point);
        actNodes.push({ floor, type });

        if (!point || typeof point !== "object") continue;
        const stats = Array.isArray(point.player_stats) ? point.player_stats[0] : null;
        if (stats) {
          latestStats = stats;
          latestRoomType = type;
        }
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
          cardPicks.push({ floor, offered, picked, source: type });
        }
      }
      pathByAct.push({ act: actIdx + 1, nodes: actNodes });
    });
  }

  // Live "current state" snapshot — only meaningful when this is an
  // in-progress run, but we always populate so the renderer can decide.
  // Numbers default to null (not 0) so the UI can show a dash instead
  // of misreporting "0 HP" when the field was simply absent.
  const currentHp = Number.isFinite(latestStats?.current_hp) ? latestStats.current_hp | 0 : null;
  const maxHp = Number.isFinite(latestStats?.max_hp) ? latestStats.max_hp | 0 : null;
  const currentGold = Number.isFinite(latestStats?.current_gold) ? latestStats.current_gold | 0 : null;
  const currentRoomType = typeof latestRoomType === "string" ? latestRoomType : null;

  // Record the schema version we saw on this run. Used by the stats
  // panel to surface a non-blocking "newer build" banner when any run
  // is from a schema we haven't explicitly tested. Without this signal
  // a future STS2 patch could silently produce wrong stats.
  const schemaVersion = Number.isFinite(obj.schema_version) ? obj.schema_version | 0 : null;
  const buildId = typeof obj.build_id === "string" ? obj.build_id : null;

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
    pathByAct,
    sourceFile: sourceName,
    schemaVersion,
    buildId,
    gameMode,
    wasAbandoned,
    modifiers,
    inProgress,
    currentHp,
    maxHp,
    currentGold,
    currentRoomType,
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

// Walk a player object looking for any field that resolves to a known
// character key. Tries the explicit fields STS2 has used or might use
// (character, character_id, class, class_id, etc.) as both bare
// strings and `{ id: "..." }` shapes, then falls back to scanning
// every string value on the object. Stops at the first hit.
//
// This is the safety net for schema bumps: STS2 0.104 (schema 9)
// emits `character: "CHARACTER.SILENT"`. If 0.105 (schema 16) renames
// it to `class_id` or wraps it in an object, we want the run to
// still surface the right character art instead of going to
// "Unknown" until we ship a parser update.
function extractCharacter(player) {
  if (!player || typeof player !== "object") return null;
  const direct = ["character", "character_id", "class", "class_id", "archetype", "playerClass"];
  for (const key of direct) {
    const v = player[key];
    if (typeof v === "string") {
      const got = parseCharacter(v);
      if (got) return got;
    } else if (v && typeof v === "object") {
      const inner = typeof v.id === "string" ? v.id
                  : typeof v.name === "string" ? v.name
                  : typeof v.key === "string" ? v.key
                  : null;
      if (inner) {
        const got = parseCharacter(inner);
        if (got) return got;
      }
    }
  }
  // Last-resort: any string value that parses as a character. We
  // intentionally cap the depth at one level — we don't want to
  // recurse into deck or relics arrays.
  for (const key of Object.keys(player)) {
    const v = player[key];
    if (typeof v !== "string") continue;
    const got = parseCharacter(v);
    if (got) return got;
  }
  return null;
}

/**
 * Last-resort character extraction: scan the player's deck for cards
 * whose id is namespaced to a known character class. STS2 cards ship
 * with ids like "CARD.SILENT_STRIKE", "CARD.IRONCLAD_STRIKE",
 * "CARD.DEFECT_STRIKE", etc. Even on a fresh / partial / schema-bumped
 * `.run` file where the explicit character field is missing, the
 * starter deck is always present (you can't begin a run without a
 * character's starting cards) so this fingerprint is reliable.
 *
 * Returns the canonical character key on the first match, null
 * otherwise. We tally rather than first-match because some classes
 * share a few neutral cards via curse pools and a single neutral
 * shouldn't outvote a deck of namespaced strikes.
 */
function inferCharacterFromDeck(player) {
  if (!player || !Array.isArray(player.deck)) return null;
  const tally = { ironclad: 0, silent: 0, defect: 0, regent: 0, necrobinder: 0 };
  for (const c of player.deck) {
    const raw = typeof c?.id === "string" ? c.id : "";
    if (!raw) continue;
    const stripped = stripPrefix("CARD.", raw).toLowerCase();
    if (stripped.startsWith("ironclad_") || stripped.startsWith("ic_")) tally.ironclad++;
    else if (stripped.startsWith("silent_") || stripped.startsWith("si_")) tally.silent++;
    else if (stripped.startsWith("defect_") || stripped.startsWith("df_") || stripped.startsWith("de_")) tally.defect++;
    else if (stripped.startsWith("regent_") || stripped.startsWith("watcher_") || stripped.startsWith("re_") || stripped.startsWith("rg_")) tally.regent++;
    else if (stripped.startsWith("necrobinder_") || stripped.startsWith("binder_") || stripped.startsWith("nb_")) tally.necrobinder++;
  }
  let best = null;
  let bestCount = 0;
  for (const k of Object.keys(tally)) {
    if (tally[k] > bestCount) { best = k; bestCount = tally[k]; }
  }
  // Require at least 2 namespaced cards before we trust the inference
  // — a single neutral with a coincidental prefix shouldn't decide
  // the character class.
  return bestCount >= 2 ? best : null;
}

/** Same idea as `inferCharacterFromDeck` but using starting relics.
 *  Each character's starter relic is unique (Burning Blood, Ring of
 *  the Snake, Cracked Core, etc.). When the deck inference comes back
 *  empty we look here as a final fallback. */
function inferCharacterFromRelics(player) {
  if (!player || !Array.isArray(player.relics)) return null;
  for (const r of player.relics) {
    const raw = typeof r?.id === "string" ? r.id : "";
    if (!raw) continue;
    const slug = stripPrefix("RELIC.", raw).toLowerCase();
    // Starter relics → character. Conservative list — only the canonical
    // starting relics, no upgrade variants.
    if (slug === "burningblood" || slug === "burning_blood") return "ironclad";
    if (slug === "ringofthesnake" || slug === "ring_of_the_snake") return "silent";
    if (slug === "crackedcore" || slug === "cracked_core") return "defect";
    if (slug === "puretruth" || slug === "pure_truth" || slug === "holytrinity") return "regent";
    if (slug === "necronomicon" || slug === "binders_book" || slug === "bindersbook") return "necrobinder";
  }
  return null;
}

function pickSource(point) {
  const mapType = (point?.map_point_type ?? "").toLowerCase();
  if (mapType === "boss")     return "boss";
  if (mapType === "elite")    return "elite";
  if (mapType === "shop")     return "shop";
  if (mapType === "rest" || mapType === "campfire") return "rest";
  const room = Array.isArray(point?.rooms) ? point.rooms[0] : null;
  const roomType = (room?.room_type ?? "").toLowerCase();
  if (roomType === "monster" || roomType === "combat") return "combat";
  if (roomType === "elite")    return "elite";
  if (roomType === "boss")     return "boss";
  if (roomType === "shop")     return "shop";
  if (roomType === "event")    return "event";
  if (roomType === "rest" || roomType === "campfire") return "rest";
  if (roomType === "ancient" || roomType === "treasure") return "chest";
  return "unknown";
}
