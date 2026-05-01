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
const RELICS_COMMON = [
  "burning_blood", "anchor", "ancient_tea_set", "art_of_war", "bag_of_marbles",
  "blood_vial", "boot", "centennial_puzzle", "happy_flower", "lantern",
  "letter_opener", "maw_bank", "meat_on_the_bone", "nunchaku", "preserved_insect",
  "shovel", "smiling_mask", "strange_spoon", "the_courier", "vajra",
  "akabeko", "bronze_scales", "lucky_cat", "oddly_smooth_stone", "potion_belt",
  "regal_pillow", "strawberry", "war_paint",
];
const RELICS_RARE = [
  "sword_of_jade", "sundial", "ginger", "kunai", "shuriken",
  "ice_cream", "mark_of_pain", "runic_dome", "runic_pyramid", "snecko_eye",
  "fossilized_helix", "girya", "philosophers_stone", "tingsha", "ectoplasm",
];

// Character-specific cards. Real card IDs from the STS2 asset manifest.
// Use the same slug format the asset lookup expects so card art renders.
const CARDS = {
  ironclad: {
    base: ["strike_red", "strike_red", "strike_red", "strike_red", "defend_red", "defend_red", "defend_red", "defend_red", "bash"],
    common: ["pommelstrike", "anger", "cleave", "ironwave", "perfectedstrike", "bodyslam", "shrugitoff", "twinstrike", "uppercut", "thunderclap"],
    uncommon: ["bloodletting", "carnage", "drop_kick", "hemokinesis", "infernal_blade", "metallicize", "powerthrough", "secondwind", "spotweakness", "warcry"],
    rare: ["bludgeon", "limit_break", "demon_form", "feed", "offering", "reaper", "barricade", "berserk", "corruption"],
  },
  silent: {
    base: ["strike_green", "strike_green", "strike_green", "strike_green", "strike_green", "defend_green", "defend_green", "defend_green", "defend_green", "neutralize", "survivor"],
    common: ["bane", "dark_shackles", "deadly_poison", "footwork", "poisoned_stab", "preparedness", "quick_slice", "slice", "sneaky_strike", "underhanded_strike", "acrobatics"],
    uncommon: ["accuracy", "all_out_attack", "backstab", "blade_dance", "bouncing_flask", "calculated_gamble", "caltrops", "catalyst", "infinite_blades", "predator", "skewer"],
    rare: ["bullet_time", "tools_of_the_trade", "envenom", "wraith_form", "a_thousand_cuts", "die_die_die", "glass_knife", "storm_of_steel"],
  },
  defect: {
    base: ["strike_blue", "strike_blue", "strike_blue", "strike_blue", "defend_blue", "defend_blue", "defend_blue", "defend_blue", "zap", "dualcast"],
    common: ["coldsnap", "compile_driver", "consume", "darkness", "double_energy", "rebound", "skim", "stream_of_time", "streamline", "sweeping_beam"],
    uncommon: ["aggregate", "amplify", "auto_shields", "blizzard", "boot_sequence", "bullseye", "capacitor", "chaos", "force_field", "genetic_algorithm", "glacier"],
    rare: ["meteor_strike", "thunder_strike", "biased_cognition", "echo_form", "buffer", "core_surge", "creative_ai", "fission", "machine_learning"],
  },
  regent: {
    base: ["strike_purple", "strike_purple", "strike_purple", "strike_purple", "defend_purple", "defend_purple", "defend_purple", "defend_purple", "eruption", "vigilance"],
    common: ["bowling_bash", "consecrate", "crush_joints", "cut_through_fate", "halt", "inner_peace", "press", "prostrate", "protect", "smite"],
    uncommon: ["empty_body", "empty_fist", "empty_mind", "evaluate", "flurry_of_blows", "follow_up", "foreign_influence", "indignation", "like_water", "mental_fortress"],
    rare: ["alpha", "blasphemy", "deus_ex_machina", "establishment", "judgment", "master_reality", "ragnarok", "scrawl", "spirit_shield"],
  },
  necrobinder: {
    // Necrobinder card pool is small in the demo since it's a new unlock.
    base: ["strike_orange", "strike_orange", "strike_orange", "strike_orange", "defend_orange", "defend_orange", "defend_orange", "defend_orange", "rebirth"],
    common: ["bone_strike", "graveyard", "haunting", "lich_form", "marrow", "rot", "soul_drain", "summon_skeleton"],
    uncommon: ["bone_pile", "death_pact", "dead_branch", "ghoul_pact", "necrotic_slash", "summon_zombie"],
    rare: ["lich_king", "soul_chain", "undying_resolve"],
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
  if (won && ascension >= 12 && r01() < 0.4) out.push("sword_of_jade");
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
    killedBy: victory ? null : pickFrom(KILLED_BY),
  };
}

// ─── the actual demo runs (~118 runs across 5 characters, A0–A18) ────
//
// Tuned to feel like a real STS2 player ~120 hours in: a lot of losses
// at high ascensions, a comfortable win rate at low ones, recent runs
// pushing into the late teens. Overall win rate ~28%, which mirrors
// what an active ladder-pusher actually has on the books. A flashy 70%
// rate would smell like cherry-picked screenshot bait — credibility
// here matters more than aspiration.
const DEMO_RUNS = [];
const SCHEDULE = {
  ironclad: [
    // A18 — 6 attempts, 1 win (recent)
    [18, false, 47, 0],  [18, false, 28, 1],  [18, false, 51, 3],
    [18, true,  57, 4],  [18, false, 39, 6],  [18, false, 33, 8],
    // A17 — 5 attempts, 2 wins
    [17, true,  57, 9],  [17, false, 41, 10], [17, false, 35, 11],
    [17, true,  57, 12], [17, false, 44, 13],
    // A16 — 5 attempts, 2 wins
    [16, true,  57, 14], [16, false, 38, 15], [16, false, 30, 16],
    [16, true,  57, 17], [16, false, 27, 18],
    // A15 — 4 attempts, 2 wins
    [15, true,  57, 19], [15, false, 33, 20], [15, true,  57, 21], [15, false, 41, 22],
    // A14–A12 — pushed through, mixed
    [14, true,  57, 23], [14, false, 36, 24], [13, false, 28, 25],
    [12, true,  57, 26], [12, false, 42, 27],
    // A11–A8 — mostly wins, some losses
    [11, true,  57, 28], [10, false, 35, 29], [10, true,  57, 30],
    [9,  true,  57, 31], [9,  false, 22, 32], [8,  true,  57, 33], [8,  true,  57, 34],
    // A7–A0 — comfortable wins
    [7,  true,  57, 35], [6,  true,  57, 36], [5,  true,  57, 38],
    [5,  false, 38, 39], [4,  true,  57, 40], [3,  true,  57, 41],
    [2,  true,  57, 42], [1,  true,  57, 43], [0,  true,  57, 44],
  ],
  silent: [
    // A12 push, mostly losses
    [12, false, 41, 2],  [12, false, 28, 5],  [12, true,  57, 7],
    [11, false, 35, 9],  [11, true,  57, 11], [10, false, 33, 13],
    [10, false, 22, 16], [9,  true,  57, 18], [9,  false, 31, 20],
    [8,  true,  57, 22], [7,  true,  57, 24], [6,  false, 18, 26],
    [5,  true,  57, 28], [4,  true,  57, 30], [3,  true,  57, 32],
    [2,  false, 26, 34], [1,  true,  57, 36], [0,  true,  57, 39],
    [0,  false, 18, 41],
  ],
  defect: [
    [10, false, 33, 6],  [10, true,  57, 9],  [9,  false, 41, 12],
    [8,  false, 27, 14], [8,  true,  57, 17], [7,  false, 33, 19],
    [6,  true,  57, 22], [5,  false, 28, 24], [5,  true,  57, 27],
    [3,  true,  57, 33], [2,  false, 22, 36], [1,  false, 22, 38],
    [0,  true,  57, 43],
  ],
  regent: [
    [6,  false, 38, 11], [6,  true,  57, 14], [5,  false, 35, 19],
    [4,  false, 22, 22], [4,  true,  57, 26], [3,  false, 30, 29],
    [2,  true,  57, 32], [1,  false, 30, 39], [0,  true,  57, 45],
  ],
  necrobinder: [
    [0, false, 28, 5],   [0, false, 14, 12],  [0, false, 22, 17],
    [0, true,  57, 19],  [0, false, 31, 24],
  ],
};

for (const [character, list] of Object.entries(SCHEDULE)) {
  for (const [a, w, f, d] of list) {
    DEMO_RUNS.push(makeRun({
      character,
      ascension: a,
      victory: w,
      floor: f,
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
  }));
}

export const DEMO_META = {
  totalRuns: DEMO_RUNS.length,
};
