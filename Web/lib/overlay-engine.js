// overlay-engine.js
// =========================================================================
// Run Companion Overlay — local decision engine.
//
// Pure, dependency-free, deterministic. No network. Given the player's
// current overlay state (run status + deck-direction tags + which decision
// they're staring at + active reminders), return ONE ranked recommendation:
//
//   {
//     action: "Pick a Strength scaling card here",
//     confidence: "medium",   // "low" | "medium" | "high"
//     score: 0.62,            // 0..1, internal use; UI can show a bar
//     why: ["Boss is Architect (high block).", "Your deck flagged need_scaling."],
//     assumptions: ["Deck direction is what the player tagged, not measured."],
//     decisionKey: "cardReward",
//   }
//
// The rules below are intentionally simple and STS2-aware. They're meant to
// model how an experienced friend would coach you in 10 seconds, not to
// replace deep solver advice. We bias toward "useful default" rather than
// "perfect", and surface the reasoning so the player can disagree fast.
//
// All copy stays trust-first: never claims to read game memory, never
// promises the move is optimal, always describes itself as "support."
// =========================================================================

const TAG_FAMILIES = {
  damage: { kind: "offense", weight: 1.0 },
  block: { kind: "defense", weight: 1.0 },
  scaling: { kind: "scaling", weight: 1.2 },
  draw: { kind: "consistency", weight: 0.8 },
  energy: { kind: "consistency", weight: 0.9 },
  exhaust: { kind: "thinning", weight: 0.7 },
  poison: { kind: "scaling", weight: 1.1 },
  orbs: { kind: "scaling", weight: 1.0 },
  stance: { kind: "scaling", weight: 1.0 },
  strength: { kind: "scaling", weight: 1.1 },
  defensive: { kind: "defense", weight: 1.0 },
  unknown: { kind: "unknown", weight: 0.4 },
};

const REMINDER_TO_NEED = {
  need_damage: "damage",
  need_block: "block",
  need_scaling: "scaling",
  need_draw: "draw",
  need_energy: "energy",
  save_potion: "potion",
  avoid_elite: "avoid_elite",
  take_elite: "take_elite",
  look_for_removal: "removal",
  upgrade_priority: "upgrade",
};

// Active decision the player is staring at, in priority order. We resolve
// the first checked one because card rewards / shop / boss-relic-pick are
// the moments where bad picks compound the worst.
const DECISION_PRIORITY = [
  "cardReward",
  "bossRelic",
  "shop",
  "pathChoice",
  "restSite",
  "remove",
  "upgrade",
  "potionUse",
  "coopCoordination",
];

function pickActiveDecision(decisions) {
  if (!decisions || typeof decisions !== "object") return null;
  for (const key of DECISION_PRIORITY) {
    if (decisions[key]) return key;
  }
  return null;
}

function activeNeeds(reminders) {
  const set = new Set();
  for (const r of reminders || []) {
    const need = REMINDER_TO_NEED[r];
    if (need) set.add(need);
  }
  return set;
}

function tagSet(tags) {
  return new Set((tags || []).filter((t) => TAG_FAMILIES[t]));
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function scoreToConfidence(score) {
  if (score >= 0.7) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

// =========================================================================
// Per-decision recommenders
//
// Each returns the same shape so the top-level resolver can just pick the
// active decision and run that recommender. They never throw — they always
// return a recommendation, even if it's a generic checklist nudge.
// =========================================================================

function recommendCardReward(state) {
  const needs = activeNeeds(state.reminders);
  const tags = tagSet(state.tags);
  const why = [];
  const assumptions = ["Deck direction is what you tagged, not what we read from the game."];
  let action = "Take the card that solves your most painful problem next fight.";
  let score = 0.4;

  if (needs.has("scaling") && !tags.has("scaling") && !tags.has("strength") && !tags.has("poison") && !tags.has("orbs") && !tags.has("stance")) {
    action = "Prioritize a scaling card (Strength, Poison, Orbs, Stance — character-appropriate).";
    why.push("You flagged Need scaling and your deck has no scaling tagged.");
    score = 0.78;
  } else if (needs.has("damage") && !tags.has("damage")) {
    action = "Take a real damage card — your deck is light on offense.";
    why.push("You flagged Need damage and damage is not tagged in your deck.");
    score = 0.72;
  } else if (needs.has("block") && !tags.has("block") && !tags.has("defensive")) {
    action = "Take block. Skipping a card here is fine if all options are damage.";
    why.push("You flagged Need block and your deck has no defensive tags.");
    score = 0.7;
  } else if (needs.has("draw") && !tags.has("draw")) {
    action = "Take draw if it's offered. Consistency compounds.";
    why.push("You flagged Need draw and your deck has no draw tagged.");
    score = 0.62;
  } else if (needs.has("energy") && !tags.has("energy")) {
    action = "Take energy if it's offered (relic > card most acts).";
    why.push("You flagged Need energy.");
    score = 0.58;
  } else if (tags.size === 0) {
    action = "Skip is on the table. Don't take filler before you know your deck shape.";
    why.push("No deck direction tagged yet — early act, decisions are still cheap.");
    score = 0.5;
  } else {
    action = "Take the card that fits your tagged direction; otherwise skip.";
    why.push("You already have a deck direction; only take cards that reinforce it.");
    score = 0.55;
  }

  if ((state.status?.act || 1) >= 3) {
    why.push("Act 3 — every card has to earn its slot.");
    score = clamp01(score + 0.05);
  }

  return {
    action,
    confidence: scoreToConfidence(score),
    score: clamp01(score),
    why,
    assumptions,
    decisionKey: "cardReward",
  };
}

function recommendBossRelic(state) {
  const tags = tagSet(state.tags);
  const why = [];
  const assumptions = ["Boss-relic comparisons assume your tagged direction is the build you're committing to."];
  let action = "Pick the boss relic that scales the deck you're already on.";
  let score = 0.55;

  if (tags.has("strength")) { action = "Lean toward Strength multipliers (e.g. Sozu-class trades only if needed)."; why.push("Strength tagged — Strength multipliers compound."); score = 0.7; }
  else if (tags.has("orbs"))  { action = "Lean toward orb / Focus support (or energy with safe downside)."; why.push("Orbs tagged — anything that boosts orbs or energy helps."); score = 0.7; }
  else if (tags.has("poison")) { action = "Lean toward extra-energy or draw relics; poison wants tempo."; why.push("Poison tagged — tempo and energy beat raw stats."); score = 0.68; }
  else if (tags.has("stance")) { action = "Lean toward stance / draw payoff relics."; why.push("Stance tagged — payoff relics are the move."); score = 0.66; }

  if (!tags.size) {
    action = "Pick the boss relic with the smallest downside if your deck is undecided.";
    why.push("No deck direction tagged — minimize regret rather than maximize ceiling.");
    score = 0.5;
  }

  return {
    action,
    confidence: scoreToConfidence(score),
    score: clamp01(score),
    why,
    assumptions,
    decisionKey: "bossRelic",
  };
}

function recommendShop(state) {
  const needs = activeNeeds(state.reminders);
  const why = [];
  const assumptions = ["Shop priority depends on gold; engine doesn't see your gold count."];
  let action = "Spend on Removal first if available; then Potion or Relic by need.";
  let score = 0.62;

  if (needs.has("removal")) {
    action = "Buy Removal. Card Removal is the strongest gold sink in the run.";
    why.push("You flagged Look for removal.");
    score = 0.82;
  } else if (needs.has("damage") || needs.has("block")) {
    action = "Buy a relic or potion that solves the immediate need; only buy a card if it fits the deck.";
    why.push("You flagged a deck need — close that gap first.");
    score = 0.7;
  } else if ((state.status?.act || 1) >= 2) {
    action = "Strongly consider buying Removal even if not tagged. Strikes/Defends drag in Act 2+.";
    why.push("Act 2+ — base cards become anti-scaling.");
    score = 0.66;
  }

  return {
    action,
    confidence: scoreToConfidence(score),
    score: clamp01(score),
    why,
    assumptions,
    decisionKey: "shop",
  };
}

function recommendPathChoice(state) {
  const needs = activeNeeds(state.reminders);
  const risk = state.status?.pathRisk || "medium";
  const why = [];
  const assumptions = ["Path advice uses your tagged path risk, not the actual map."];
  let action = "Aim for a rest before the boss; route through one elite if you can survive.";
  let score = 0.55;

  if (needs.has("avoid_elite")) {
    action = "Skip elites. Take ?-events and shops over elites until your deck improves.";
    why.push("You flagged Avoid elite.");
    score = 0.78;
  } else if (needs.has("take_elite")) {
    action = "Take at least one elite for the relic; rest after it if HP allows.";
    why.push("You flagged Take elite.");
    score = 0.74;
  } else if (risk === "high") {
    action = "Drop a planned elite. High path risk + this deck = bad EV.";
    why.push("Path risk tagged High.");
    score = 0.7;
  } else if (risk === "low") {
    action = "Stack elites. Low risk path is the main scaling lever you have.";
    why.push("Path risk tagged Low.");
    score = 0.7;
  }

  if ((state.status?.act || 1) === 2) {
    why.push("Act 2 — elite relics matter most here.");
  }

  return {
    action,
    confidence: scoreToConfidence(score),
    score: clamp01(score),
    why,
    assumptions,
    decisionKey: "pathChoice",
  };
}

function recommendRestSite(state) {
  const needs = activeNeeds(state.reminders);
  const why = [];
  const assumptions = ["Rest site advice ignores HP — rule of thumb only."];
  let action = "Smith if you have a key card to upgrade; rest if HP is below half.";
  let score = 0.6;

  if (needs.has("upgrade")) {
    action = "Smith. You flagged Upgrade priority.";
    why.push("Upgrade priority reminder is on.");
    score = 0.78;
  } else if ((state.status?.act || 1) >= 3) {
    action = "Rest before boss unless you have an explicit Smith plan.";
    why.push("Act 3 — boss HP matters more than one upgrade.");
    score = 0.72;
  }

  return {
    action,
    confidence: scoreToConfidence(score),
    score: clamp01(score),
    why,
    assumptions,
    decisionKey: "restSite",
  };
}

function recommendRemove(state) {
  const why = ["Removal is one of the strongest decisions in the run."];
  const assumptions = ["Engine assumes the basic deck still has Strikes/Defends."];
  return {
    action: "Remove a Strike first; only remove Defend if you have heavy block elsewhere.",
    confidence: "high",
    score: 0.85,
    why,
    assumptions,
    decisionKey: "remove",
  };
}

function recommendUpgrade(state) {
  const tags = tagSet(state.tags);
  const why = [];
  const assumptions = ["Upgrade ranks vary by character — engine uses general STS2 priorities."];
  let action = "Upgrade your most-played key card before generic Strikes.";
  let score = 0.68;

  if (tags.has("scaling") || tags.has("strength") || tags.has("poison") || tags.has("orbs") || tags.has("stance")) {
    action = "Upgrade your scaling enabler first (Strength, Catalyst, Defragment, Wallop, etc.).";
    why.push("Scaling tagged — upgrade the scaling enabler card.");
    score = 0.78;
  } else if (tags.has("draw") || tags.has("energy")) {
    action = "Upgrade draw/energy cards before damage.";
    why.push("Consistency tags present — upgrade those first.");
    score = 0.72;
  }

  return {
    action,
    confidence: scoreToConfidence(score),
    score: clamp01(score),
    why,
    assumptions,
    decisionKey: "upgrade",
  };
}

function recommendPotionUse(state) {
  const needs = activeNeeds(state.reminders);
  const why = [];
  const assumptions = ["Potion advice ignores belt slots."];
  let action = "Use potions on elite/boss turns where they prevent a death, not minor pressure.";
  let score = 0.62;

  if (needs.has("save_potion")) {
    action = "Save the potion. You flagged Save for elite/boss.";
    why.push("Save potion reminder is on.");
    score = 0.78;
  }

  return {
    action,
    confidence: scoreToConfidence(score),
    score: clamp01(score),
    why,
    assumptions,
    decisionKey: "potionUse",
  };
}

function recommendCoopCoordination(state) {
  const why = ["Co-op planning is the cheapest swing per click."];
  const assumptions = ["Engine doesn't see partner's deck."];
  return {
    action: "Decide who tanks elite/boss before the fight; align removal vs scaling roles.",
    confidence: "medium",
    score: 0.6,
    why,
    assumptions,
    decisionKey: "coopCoordination",
  };
}

const RECOMMENDERS = {
  cardReward: recommendCardReward,
  bossRelic: recommendBossRelic,
  shop: recommendShop,
  pathChoice: recommendPathChoice,
  restSite: recommendRestSite,
  remove: recommendRemove,
  upgrade: recommendUpgrade,
  potionUse: recommendPotionUse,
  coopCoordination: recommendCoopCoordination,
};

// =========================================================================
// Public API
// =========================================================================

/** Return ONE ranked recommendation for the current overlay state. */
export function recommendNextAction(state) {
  const safeState = state || {};
  const decisionKey = pickActiveDecision(safeState.decisions);
  if (decisionKey && RECOMMENDERS[decisionKey]) {
    return RECOMMENDERS[decisionKey](safeState);
  }
  // No active decision tagged — fall back to a deck-shape suggestion.
  const tags = tagSet(safeState.tags);
  const needs = activeNeeds(safeState.reminders);
  if (needs.size > 0) {
    const first = [...needs][0];
    return {
      action: `Plan around: ${first.replace(/_/g, " ")}.`,
      confidence: "low",
      score: 0.35,
      why: ["No decision selected; advice is generic until you check one."],
      assumptions: ["Engine uses your reminders only."],
      decisionKey: null,
    };
  }
  if (tags.size === 0) {
    return {
      action: "Tag your current deck direction to get sharper advice.",
      confidence: "low",
      score: 0.25,
      why: ["No deck-direction tags selected."],
      assumptions: ["Engine starts cold without tags."],
      decisionKey: null,
    };
  }
  return {
    action: "Hold your deck direction. Don't pivot without a real reason.",
    confidence: "low",
    score: 0.4,
    why: [`Deck direction tagged: ${[...tags].join(", ")}.`],
    assumptions: ["No active decision was selected."],
    decisionKey: null,
  };
}

/** Build the strict prompt the AI vision call uses. Caller is responsible
 *  for sending it. We keep prompt construction here so the contract is
 *  unit-testable and not buried in UI code. */
export function buildVisionPrompt(state) {
  const safeState = state || {};
  const status = safeState.status || {};
  const tags = (safeState.tags || []).join(", ") || "(none)";
  const reminders = (safeState.reminders || []).join(", ") || "(none)";
  const decisionKey = pickActiveDecision(safeState.decisions) || "(none selected)";
  const note = (safeState.notes || "").slice(0, 600);

  const system = [
    "You are a Slay the Spire 2 run advisor for an in-game companion app.",
    "You are NOT a bot. You do not play the game. You give the player ONE ranked recommendation for the decision they are looking at, with a confidence and short reasoning.",
    "You must NEVER claim to read game memory. The only inputs you have are: a single screenshot the player chose to share, plus the player's tagged context.",
    "Slay the Spire 2 Early Access caps at A9 ascension and 3 acts. Do not invent acts or relics that don't exist.",
    "Output STRICTLY this JSON object and nothing else:",
    `{"action": "string", "confidence": "low|medium|high", "why": ["string", "string"], "assumptions": ["string"]}`,
  ].join("\n");

  const user = [
    "Player context:",
    `- Active decision: ${decisionKey}`,
    `- Character: ${status.character || "(unknown)"}`,
    `- Act ${status.act || "?"} · Floor ${status.floor || "?"} · Ascension ${status.ascension ?? "?"}`,
    `- Path risk: ${status.pathRisk || "(unset)"}`,
    `- Boss: ${status.boss || "(unset)"}`,
    `- Goal: ${status.goal || "(unset)"}`,
    `- Deck direction tags: ${tags}`,
    `- Active reminders: ${reminders}`,
    note ? `- Player notes: ${note}` : "- Player notes: (none)",
    "",
    "Use ONE screenshot the player attached. Recommend the BEST single action for the active decision. Keep `why` to 1-2 short bullets the player can verify by looking at the screen. Add `assumptions` for anything you couldn't see.",
    "If you can't tell what the screen shows, return action='Cannot read screen confidently. Ask player to retake screenshot of the choice.', confidence='low'.",
  ].join("\n");

  return { system, user };
}

/** Validate and sanitize a vision response before we render it. */
export function validateVisionResponse(json) {
  if (!json || typeof json !== "object") return null;
  const action = typeof json.action === "string" ? json.action.trim() : "";
  const conf = json.confidence;
  const confidence = ["low", "medium", "high"].includes(conf) ? conf : "low";
  const why = Array.isArray(json.why) ? json.why.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 4) : [];
  const assumptions = Array.isArray(json.assumptions) ? json.assumptions.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 4) : [];
  if (!action || action.length < 4) return null;
  return {
    action: action.slice(0, 400),
    confidence,
    why: why.map((s) => s.slice(0, 280)),
    assumptions: assumptions.map((s) => s.slice(0, 280)),
    source: "ai-screenshot",
  };
}
