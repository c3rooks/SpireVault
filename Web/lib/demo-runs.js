/**
 * Demo run history.
 *
 * Powers the "no auth, no file uploaded" first impression. Every stats tab
 * looks alive the moment someone lands on app.spirevault.app — Overview
 * shows numbers, Characters shows portraits with win rates, Ascensions
 * shows a chart, Top Relics shows actual STS2 relic art, Cards shows
 * actual card images, Recent Runs shows victories and deaths.
 *
 * The data is synthetic but plausible: a player ~120 hours into STS2,
 * pushing Ironclad up the ascension ladder, dabbling in Silent and Defect,
 * occasionally trying Regent, just unlocked Necrobinder. Numbers were
 * tuned to match the shape of real history.json data parsed by
 * `extractRuns()` in stats-engine.js, so the same renderers produce the
 * same UI without any special-casing.
 *
 * Outputs runs in the **post-normalize** shape (the same shape
 * `normalizeRun()` returns), so we can drop them straight into
 * `parsedRuns` without going through the history.json parser.
 *
 * The UI overlays a clear "Sample data — drop your history.json to see
 * your own runs" banner above every stats tab while these are loaded.
 * The moment a real history.json arrives, demo mode flips off and the
 * user's real runs render in the same tabs.
 */

const NOW = Date.now();
const DAY = 86_400_000;

// ─── card / relic vocab (real STS2 IDs from our scraped manifest) ─────
// Relic IDs verified against Web/assets/sts2/manifest.json so art
// actually renders on first visit. Format matches what our asset
// library uses (camelCase/no-underscore), not the STS1-style
// snake_case the demo originally used.
const RELICS_COMMON = [
  "burningblood", "anchor", "artofwar", "bagofmarbles",
  "bloodvial", "theboot", "centennialpuzzle", "happyflower", "lantern",
  "letteropener", "mawbank", "meatonthebone", "nunchaku", "shovel",
  "thecourier", "vajra", "akabeko", "bronzescales",
  "oddlysmoothstone", "potionbelt", "regalpillow", "strawberry", "warpaint",
];
const RELICS_RARE = [
  "swordofjade", "kunai", "shuriken", "icecream",
  "runicpyramid", "sneckoeye", "girya", "philosophersstone",
  "tingsha", "ectoplasm", "callingbell", "blackstar",
  "dreamcatcher", "lizardtail", "bookoffiverings",
];

// Character-specific cards. Every ID below is verified against the
// shipped STS2 asset manifest (Web/assets/sts2/manifest.json), so the
// Cards tab renders real art on first visit rather than placeholder
// sparkles. If the manifest changes, regenerate this block via
// scripts/regen_demo_cards.py (or by hand) — otherwise placeholders
// come back.
//
// "common/uncommon/rare" here is for shape only (the demo doesn't
// model rarity economics); the manifest doesn't expose rarity metadata.
const CARDS = {
  ironclad: {
    base: ["ironclad_strike", "ironclad_strike", "ironclad_strike", "ironclad_strike", "ironclad_defend", "ironclad_defend", "ironclad_defend", "ironclad_defend", "ironclad_bash"],
    common: ["ironclad_perfectedstrike", "ironclad_stomp", "ironclad_drumofbattle", "ironclad_pillage", "ironclad_flamebarrier", "ironclad_rampage", "ironclad_break", "ironclad_moltenfist", "ironclad_secondwind", "ironclad_infernalblade", "ironclad_colossus", "ironclad_tearasunder", "ironclad_shrugitoff", "ironclad_impervious"],
    uncommon: ["ironclad_ironwave", "ironclad_stoke", "ironclad_evileye", "ironclad_rupture", "ironclad_unrelenting", "ironclad_anger", "ironclad_tremble", "ironclad_pyre", "ironclad_cruelty", "ironclad_tank", "ironclad_darkembrace", "ironclad_demonicshield"],
    rare: ["ironclad_bludgeon", "ironclad_barricade", "ironclad_corruption", "ironclad_feed", "ironclad_offering", "ironclad_demonform", "ironclad_bloodletting"],
  },
  silent: {
    base: ["silent_strike", "silent_strike", "silent_strike", "silent_strike", "silent_strike", "silent_defend", "silent_defend", "silent_defend", "silent_defend", "silent_neutralize", "silent_survivor"],
    common: ["silent_corrosivewave", "silent_untouchable", "silent_tracking", "silent_backflip", "silent_echoingslash", "silent_legsweep", "silent_anticipate", "silent_accelerant", "silent_haze", "silent_suppress", "silent_handtrick", "silent_bladeofink", "silent_knifetrap", "silent_noxiousfumes"],
    uncommon: ["silent_accuracy", "silent_bouncingflask", "silent_murder", "silent_deadlypoison", "silent_flechettes", "silent_leadingstrike", "silent_daggerspray", "silent_footwork", "silent_dash", "silent_abrasive", "silent_cloakanddagger", "silent_shadowmeld"],
    rare: ["silent_bullettime", "silent_envenom", "silent_wraithform", "silent_nightmare", "silent_burst"],
  },
  defect: {
    base: ["defect_strike", "defect_strike", "defect_strike", "defect_strike", "defect_defend", "defect_defend", "defect_defend", "defect_defend", "defect_zap", "defect_dualcast"],
    common: ["defect_overclock", "defect_modded", "defect_hologram", "defect_sweepingbeam", "defect_boostaway", "defect_quadcast", "defect_bootsequence", "defect_glasswork", "defect_coolant", "defect_null", "defect_chaos", "defect_chill", "defect_multicast", "defect_shadowshield"],
    uncommon: ["defect_barrage", "defect_whitenoise", "defect_spinner", "defect_leap", "defect_rocketpunch", "defect_focusedstrike", "defect_scavenge", "defect_fightthrough", "defect_rainbow", "defect_geneticalgorithm", "defect_gofortheeyes", "defect_whitenoise"],
    rare: ["defect_biasedcognition", "defect_echoform", "defect_buffer", "defect_creativeai", "defect_reboot", "defect_meteorstrike"],
  },
  regent: {
    base: ["regent_strike", "regent_strike", "regent_strike", "regent_strike", "regent_defend", "regent_defend", "regent_defend", "regent_defend"],
    common: ["regent_crushunder", "regent_kinglykick", "regent_terraforming", "regent_neutronaegis", "regent_palebluedot", "regent_royalgamble", "regent_guidingstar", "regent_parry", "regent_astralpulse", "regent_photoncut", "regent_bulwark", "regent_swordsage", "regent_makeitso", "regent_collisioncourse"],
    uncommon: ["regent_heirloomhammer", "regent_iaminvincible", "regent_crescentspear", "regent_summonforth", "regent_guards", "regent_arsenal", "regent_sevenstars", "regent_bundleofjoy", "regent_tyranny", "regent_quasar", "regent_monologue", "regent_knowthyplace"],
    rare: ["regent_gammablast", "regent_solarstrike", "regent_lunarblast", "regent_monarchsgaze", "regent_cosmicindifference", "regent_heavenlydrill", "regent_meteorshower"],
  },
  necrobinder: {
    base: ["necrobinder_strike", "necrobinder_strike", "necrobinder_strike", "necrobinder_strike", "necrobinder_defend", "necrobinder_defend", "necrobinder_defend", "necrobinder_defend"],
    common: ["necrobinder_endofdays", "necrobinder_deathmarch", "necrobinder_righthandhand", "necrobinder_thescythe", "necrobinder_eidolon", "necrobinder_blightstrike", "necrobinder_poke", "necrobinder_countdown", "necrobinder_dansemacabre", "necrobinder_pagestorm", "necrobinder_bansheescry", "necrobinder_veilpiercer", "necrobinder_neurosurge", "necrobinder_calcify"],
    uncommon: ["necrobinder_sculptingstrike", "necrobinder_dirge", "necrobinder_rattle", "necrobinder_lethality", "necrobinder_transfigure", "necrobinder_parse", "necrobinder_capturespirit", "necrobinder_fear", "necrobinder_spur", "necrobinder_defy", "necrobinder_spiritofash", "necrobinder_sleightofflesh"],
    rare: ["necrobinder_oblivion", "necrobinder_soulstorm", "necrobinder_forbiddengrimoire", "necrobinder_legionofbone", "necrobinder_eradicate", "necrobinder_defile"],
  },
};

// ─── deterministic randomness (so demo data is identical every load) ──
let seedState = 1234567;
function r01() {
  seedState = (seedState * 1664525 + 1013904223) >>> 0;
  return seedState / 4294967295;
}
function rInt(min, max) { return min + Math.floor(r01() * (max - min + 1)); }
function pickFrom(arr) { return arr[Math.floor(r01() * arr.length)]; }
function uniquePicks(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(r01() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

// ─── builders ─────────────────────────────────────────────────────────
function buildDeck(charKey, won) {
  const c = CARDS[charKey];
  const totalAdds = won ? rInt(18, 26) : rInt(8, 16);
  const deck = [...c.base];
  const rareCount = won ? rInt(1, 3) : 0;
  const uncCount = won ? rInt(4, 8) : rInt(2, 5);
  const cmnCount = totalAdds - rareCount - uncCount;
  for (let i = 0; i < cmnCount; i++) deck.push(pickFrom(c.common));
  for (let i = 0; i < uncCount; i++) deck.push(pickFrom(c.uncommon));
  for (let i = 0; i < rareCount; i++) deck.push(pickFrom(c.rare));
  return deck;
}

function buildRelics(won, ascension) {
  const baseCount = won ? rInt(10, 13) : rInt(3, 7);
  const out = uniquePicks(RELICS_COMMON, Math.max(2, baseCount - 2));
  // Sword of Jade is the obvious A20-sample relic the user noticed earlier.
  // Sprinkle it in only on a handful of high-ascension wins so the
  // Wilson-LB confidence math has something to talk about.
  if (won && ascension >= 12 && r01() < 0.4) out.push("swordofjade");
  if (won && r01() < 0.3) out.push(pickFrom(RELICS_RARE));
  return out;
}

function buildCardPicks(charKey, won) {
  const c = CARDS[charKey];
  const total = won ? rInt(18, 25) : rInt(9, 14);
  const picks = [];
  for (let i = 0; i < total; i++) {
    const isRareSlot = r01() < 0.18;
    const isUncSlot = !isRareSlot && r01() < 0.45;
    const pool = isRareSlot ? c.rare : isUncSlot ? c.uncommon : c.common;
    const three = uniquePicks(pool, Math.min(3, pool.length));
    if (three.length === 0) continue;
    picks.push({
      floor: 1 + i * 2,
      picked: three[0],
      not_picked: three.slice(1),
    });
  }
  return picks;
}

const KILLED_BY = ["Time Eater", "Awakened One", "Champ", "Bronze Automaton", "The Guardian", "Slime Boss", "Lagavulin", "Hexaghost", "Sentries"];

/** Build a synthetic per-act path that matches STS2's actual floor
 *  layout. STS2 has THREE acts in Early Access (no separate
 *  "Architect" act 4 — the Architect is encountered as the act 3
 *  boss / endgame, not its own zone). Each act is ~17 nodes,
 *  ending with a boss tile.
 *
 *  Floor caps:
 *    Act 1:  1–17 (boss at 17)
 *    Act 2: 18–34 (boss at 34)
 *    Act 3: 35–51 (Architect/final boss at 51)
 *
 *  Demo runs are truncated to the floor they reached (with a hard
 *  cap of 51 = full game complete). The Act Timeline never
 *  fabricates a phantom 4th act. */
function buildPathByAct(floor, victory) {
  const STS2_MAX_FLOOR = 51;       // act 3 boss
  const nodesPerAct    = 17;
  const cappedFloor    = Math.min(floor, STS2_MAX_FLOOR);
  const acts = [];
  let currentFloor = 0;
  let actNum = 1;
  while (currentFloor < cappedFloor && actNum <= 3) {
    const remaining     = cappedFloor - currentFloor;
    const thisActNodes  = Math.min(nodesPerAct, remaining);
    const isCompleteAct = thisActNodes === nodesPerAct;
    const actNodes = [];
    for (let i = 0; i < thisActNodes; i += 1) {
      currentFloor += 1;
      // Last node of a complete act is the boss (floor 17, 34, 51).
      // Mid-act distribution: ~50% combat, 18% elite, 12% event,
      // 10% rest, 6% shop, 4% chest. Roughly matches in-game pacing.
      let type;
      if (i === thisActNodes - 1 && isCompleteAct) {
        type = "boss";
      } else {
        const r = r01();
        if (r < 0.50)      type = "combat";
        else if (r < 0.68) type = "elite";
        else if (r < 0.80) type = "event";
        else if (r < 0.90) type = "rest";
        else if (r < 0.96) type = "shop";
        else               type = "chest";
      }
      actNodes.push({ floor: currentFloor, type });
    }
    acts.push({ act: actNum, nodes: actNodes });
    actNum += 1;
  }
  return acts;
}

function makeRun({ character, ascension, victory, floor, daysAgo, durationSec }) {
  const charKey = character;  // already lowercase canonical
  const startedAt = new Date(NOW - daysAgo * DAY + 18 * 3600_000 - durationSec * 1000);
  const endedAt   = new Date(NOW - daysAgo * DAY + 18 * 3600_000);
  return {
    id: `demo-${charKey}-${daysAgo}-${ascension}-${rInt(1000, 9999)}`,
    character: charKey,
    ascension,
    seed: `${1_000_000 + daysAgo * 137 + ascension * 17}`,
    won: victory,
    floorReached: floor,
    playTimeSeconds: durationSec,
    startedAt,
    endedAt,
    relics: buildRelics(victory, ascension),
    deckAtEnd: buildDeck(charKey, victory),
    cardPicks: buildCardPicks(charKey, victory),
    pathByAct: buildPathByAct(floor, victory),
    killedBy: victory ? null : pickFrom(KILLED_BY),
  };
}

// ─── the actual demo runs (~95 runs across 5 characters, A0–A9) ──────
//
// STS2 Early Access caps ascension at A9 ("combined challenges stack")
// — the previous A10–A18 entries were aspirational sample data from
// when we modeled this on STS1. Trimmed to the real game's range so
// the dashboard never shows ascensions that don't exist in the live
// game. Tuned to feel like a real STS2 player ~80 hours in: heavy
// losses at A7–A9, mixed at A4–A6, comfortable wins at A0–A3. Overall
// win rate ~33% — credible for an active ladder-pusher.
const DEMO_RUNS = [];
const SCHEDULE = {
  ironclad: [
    // A9 — 6 attempts, 1 win (current push)
    [9,  false, 47, 0],  [9,  false, 28, 1],  [9,  false, 51, 3],
    [9,  true,  57, 4],  [9,  false, 39, 6],  [9,  false, 33, 8],
    // A8 — 5 attempts, 2 wins
    [8,  true,  57, 9],  [8,  false, 41, 10], [8,  false, 35, 11],
    [8,  true,  57, 12], [8,  false, 44, 13],
    // A7 — 5 attempts, 2 wins
    [7,  true,  57, 14], [7,  false, 38, 15], [7,  false, 30, 16],
    [7,  true,  57, 17], [7,  false, 27, 18],
    // A6 — 4 attempts, 2 wins
    [6,  true,  57, 19], [6,  false, 33, 20], [6,  true,  57, 21], [6,  false, 41, 22],
    // A5 — 3 attempts, 2 wins
    [5,  true,  57, 23], [5,  false, 36, 24], [5,  true,  57, 25],
    // A4 — 2 attempts, 1 win
    [4,  true,  57, 26], [4,  false, 42, 27],
    // A3–A0 — comfortable wins
    [3,  true,  57, 28], [3,  true,  57, 30],
    [2,  true,  57, 33], [2,  false, 38, 34],
    [1,  true,  57, 38], [0,  true,  57, 42],
  ],
  silent: [
    // A6 push, mixed
    [6,  false, 41, 2],  [6,  false, 28, 5],  [6,  true,  57, 7],
    [5,  false, 35, 9],  [5,  true,  57, 11], [4,  false, 33, 13],
    [4,  false, 22, 16], [3,  true,  57, 18], [3,  false, 31, 20],
    [2,  true,  57, 22], [2,  true,  57, 24], [1,  false, 18, 26],
    [1,  true,  57, 28], [0,  true,  57, 30], [0,  true,  57, 32],
  ],
  defect: [
    [5,  false, 33, 6],  [5,  true,  57, 9],  [4,  false, 41, 12],
    [4,  false, 27, 14], [3,  true,  57, 17], [3,  false, 33, 19],
    [2,  true,  57, 22], [2,  false, 28, 24], [1,  true,  57, 27],
    [1,  true,  57, 33], [0,  false, 22, 36], [0,  true,  57, 38],
    [0,  true,  57, 43],
  ],
  regent: [
    [3,  false, 38, 11], [3,  true,  57, 14], [2,  false, 35, 19],
    [2,  false, 22, 22], [2,  true,  57, 26], [1,  false, 30, 29],
    [1,  true,  57, 32], [0,  false, 30, 39], [0,  true,  57, 45],
  ],
  necrobinder: [
    [0, false, 28, 5],   [0, false, 14, 12],  [0, false, 22, 17],
    [0, true,  57, 19],  [0, false, 31, 24],
  ],
};

for (const [character, list] of Object.entries(SCHEDULE)) {
  for (const [a, w, f, d] of list) {
    // Cap floor at 51 (STS2 max — Act 3 boss). The schedule above
    // uses 57 as a sentinel for "full game complete" because that
    // mirrored the historical STS1 Heart depth, but STS2 has no 4th
    // act. Clamping here keeps the Act Timeline honest: 3 acts max,
    // no phantom "Architect" zone.
    const cappedFloor = Math.min(f, 51);
    DEMO_RUNS.push(makeRun({
      character,
      ascension: a,
      victory: w,
      floor: cappedFloor,
      daysAgo: d,
      durationSec: 1500 + rInt(0, 1500),
    }));
  }
}

// Newest first so Recent Runs renders chronologically right out of the box.
DEMO_RUNS.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());

/**
 * Returns a fresh deep copy of the demo runs every call. Renderers
 * sometimes mutate enrichment fields, and we don't want them stomping
 * the shared module-level array.
 */
export function getDemoRuns() {
  return DEMO_RUNS.map((r) => ({
    ...r,
    startedAt: r.startedAt ? new Date(r.startedAt) : null,
    endedAt: r.endedAt ? new Date(r.endedAt) : null,
    relics: [...r.relics],
    deckAtEnd: [...r.deckAtEnd],
    cardPicks: r.cardPicks.map((p) => ({ ...p, not_picked: [...p.not_picked] })),
    pathByAct: Array.isArray(r.pathByAct)
      ? r.pathByAct.map((a) => ({ act: a.act, nodes: a.nodes.map((n) => ({ ...n })) }))
      : undefined,
  }));
}

export const DEMO_META = {
  totalRuns: DEMO_RUNS.length,
};
