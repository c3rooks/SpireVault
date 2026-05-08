// character-info.js
// =========================================================================
// Hand-curated character drill-down content for the Characters tab.
//
// Why hand-curated and not a live fetch?
//   We want this to render instantly with zero network dependency, work
//   offline in the DMG build, and survive third-party site changes (CORS,
//   layout shifts, takedowns). The content here is summarized from the
//   public Mobalytics character pages
//     https://mobalytics.gg/slay-the-spire-2/characters
//   and Slay the Spire 2 Early Access in-game flavor text. Update when
//   Mega Crit ships balance changes that move the archetypes.
//
// Each entry is the same shape so the renderer can iterate cleanly:
//   - tagline: one-liner pitch (shown next to the name, italics)
//   - role:    short role tag (e.g. "Strength bruiser")
//   - difficulty: 1–5 stars, novice → expert
//   - summary: 1–2 sentences on the play pattern
//   - mechanics: array of named mechanics (the "what's unique" beats)
//   - archetypes: build paths people climb on (shown as chips)
//   - tips: array of short, useful "do this" lines
//   - playstyle: { aggression, complexity } 1–5 for tiny radar bars
//
// All strings are HTML-safe — no raw HTML allowed in this file.
// =========================================================================

export const CHARACTER_INFO = {
  ironclad: {
    name: "Ironclad",
    tagline: "Hard-hitting bruiser. Trade HP for power, survive on raw damage.",
    role: "Strength · Block · Self-damage",
    difficulty: 1,
    summary:
      "The starter character. Big numbers, big swings. Most builds key off of Strength stacking, exhaust-engine self-damage payoffs, or block-into-thorns defensive walls. Forgiving floor, surprisingly deep ceiling on high ascensions.",
    mechanics: [
      { title: "Strength scaling", detail: "Permanent damage modifier on every Attack — the more you stack it, the harder every Strike hits." },
      { title: "Exhaust engine", detail: "Burn cards to fuel payoff cards (Dark Embrace, Feel No Pain, Corruption). High variance, high reward." },
      { title: "Self-damage payoff", detail: "Take damage on purpose to trigger relics and cards. Hemokinesis, Brutality, Rupture, Bloodletting." },
      { title: "Heavy block", detail: "Defensive Stance, Barricade, Body Slam — turn block into damage and survival into pressure." },
    ],
    archetypes: ["Strength", "Exhaust", "Block-thorns", "Self-damage"],
    tips: [
      "Don't skip Strength scaling on offer — Limit Break + Demon Form turn fights into clean-ups.",
      "Exhaust decks need Feel No Pain or Dark Embrace early — without a payoff, you're just thinning.",
      "Body Slam scales with Block. Pair with Barricade for a one-card win condition.",
      "Reaper is your sustain on long acts — pair with Strength for the heal swing.",
    ],
    playstyle: { aggression: 5, complexity: 2 },
  },

  silent: {
    name: "Silent",
    tagline: "Glass-cannon technician. Death by a thousand cuts — or one giant Catalyst.",
    role: "Poison · Shivs · Discard",
    difficulty: 3,
    summary:
      "Card-quantity over card-quality. Silent decks rely on draw-and-discard engines to keep a constant flow of cheap effects. Three core paths — Poison stacking, Shiv flurries, and Discard synergies — all want different cards, and committing matters more than for any other character.",
    mechanics: [
      { title: "Poison", detail: "Stacking debuff that ticks damage at end of turn. Catalyst doubles current poison — a setup-then-blow-up plan." },
      { title: "Shivs", detail: "0-cost 4-damage attacks. Blade Dance, Cloak and Dagger, Storm of Steel turn shivs into a flood." },
      { title: "Discard payoffs", detail: "Acrobatics, Reflex, Tactician — triggering effects when cards are discarded, not played." },
      { title: "Status defense", detail: "Footwork, Wraith Form, Tactician give shockingly high block ceilings if you commit." },
    ],
    archetypes: ["Poison", "Shivs", "Discard", "Wraith control"],
    tips: [
      "Don't blend all three archetypes — each one wants 6+ commitment cards. Pick early.",
      "Catalyst+ on a 9-stack of poison is most boss kills. Pyramid lets it fire turn after turn.",
      "Wraith Form is one of the strongest cards in the game; build for it if you find it.",
      "Storm of Steel turns a dead hand into a winning one. Slot it once your shiv count is real.",
    ],
    playstyle: { aggression: 4, complexity: 4 },
  },

  defect: {
    name: "Defect",
    tagline: "Orb-engineer. Set up the engine for two acts, then cruise the third.",
    role: "Orbs · Focus · Power scaling",
    difficulty: 4,
    summary:
      "Defect plays a slow, deliberate game. You spend the first act building an orb engine — Lightning, Frost, Dark, Plasma — and a Focus payload, then let the powers carry you through Acts 2 and 3 with minimal hand interaction. High skill ceiling, very satisfying when it clicks.",
    mechanics: [
      { title: "Channeled orbs", detail: "Lightning hits, Frost blocks, Dark stacks damage, Plasma generates energy. Each turn one of your orbs auto-triggers." },
      { title: "Focus", detail: "Permanent multiplier on Lightning and Frost output. Stacking 2-3 Focus is the win condition for most builds." },
      { title: "Power retains", detail: "Powers are persistent — Echo Form, Creative AI, Biased Cognition all snowball if you survive the turn they enter play." },
      { title: "Orb slots", detail: "Default 3, expandable to 10. Capacitor and the orb-slot relics dictate ceiling." },
    ],
    archetypes: ["Lightning", "Frost", "Dark", "Claw", "Power-scaling"],
    tips: [
      "Take Focus early. Without it, Defect's orbs are tickle damage.",
      "Don't channel Plasma without somewhere to spend the energy — it's not a free orb.",
      "Echo Form on turn 1 is a game-winner. Find a way to play it before your block runs out.",
      "Claw decks want every Claw on offer, plus 4-5 cost reducers (Mind Blast / Glacier / Recursion).",
    ],
    playstyle: { aggression: 3, complexity: 5 },
  },

  regent: {
    name: "Regent",
    tagline: "Royal commander. Buff the king, stack the parade, win the room.",
    role: "Cosmic · Royal · Banner buffs",
    difficulty: 3,
    summary:
      "The Regent (introduced in STS2) leans on accumulating royal banner buffs and cosmic-themed scaling. Builds tend to want either a wide tempo plan that pumps each turn or a slow scaling plan around persistent multipliers. Rewards smart sequencing more than raw card power.",
    mechanics: [
      { title: "Banner buffs", detail: "Temporary stat-stack buffs that tick up each turn until cashed out — long fights play very differently than short ones." },
      { title: "Cosmic scaling", detail: "Several cards reference Strength and block at the same time, rewarding dual-stat decks." },
      { title: "Royal kit", detail: "Heirloom Hammer, Crescent Spear, Royal Gamble — power tools that need a deck willing to spend energy." },
      { title: "Self-buff loops", detail: "Tyranny + a buff source = exponential turn-3 swings. Worth playing around if Tyranny shows up." },
    ],
    archetypes: ["Banner stack", "Cosmic", "Hammer", "Tempo"],
    tips: [
      "Don't dilute your buff plan. Two banner sources beat four mediocre ones.",
      "Solar Strike is a hard reset against Act 3 elites — keep one in the deck even on aggro builds.",
      "Heavenly Drill is a cheap dig, not a finisher. Use it to fish for a key card early.",
      "Cosmic Indifference rewards survival. Pair with a strong block source so you reach the payoff.",
    ],
    playstyle: { aggression: 3, complexity: 4 },
  },

  necrobinder: {
    name: "Necrobinder",
    tagline: "Death engineer. Bind, sacrifice, summon — turn losses into resources.",
    role: "Summon · Sacrifice · Curses",
    difficulty: 5,
    summary:
      "The hardest character in STS2 to pilot. Necrobinder builds revolve around binding spirits (mini-summons), sacrificing them for payoffs, and weaponizing curses. Decks live and die by their ability to convert disadvantage into damage — the cards punishing you are usually the ones you wanted in your deck on purpose.",
    mechanics: [
      { title: "Bound spirits", detail: "Persistent mini-allies that trigger on conditions (turn start, on damage, on play). You sacrifice them for big effects." },
      { title: "Curse payoffs", detail: "Cards like Defile and Blight Strike scale off curses in your deck. You want curses, deliberately." },
      { title: "Sacrifice loops", detail: "Eidolon, Capture Spirit, Soul Storm — generate spirits, then convert them in damage windows." },
      { title: "Death tempo", detail: "Several cards cost HP to play. Run economy lives and dies by HP-as-resource." },
    ],
    archetypes: ["Summon", "Curse", "Sacrifice", "HP-as-resource"],
    tips: [
      "Don't fear curses. Bag of Marbles + Defile is one of the best loops in the game.",
      "Soul Storm is a finisher AND a setup tool. Cast it before, not after, your spirits resolve.",
      "Skip self-damage relics if you don't have HP-cost cards yet — the synergy is the deck, not the relic.",
      "Necrobinder rewards 100% reading every card in shops — pick rates lie about which ones carry her.",
    ],
    playstyle: { aggression: 2, complexity: 5 },
  },
};

/** Returns the canonical character info entry, or null if we don't
 *  ship hand-written copy for this slug. The renderer should fall
 *  back to the personal-stats-only view if this is null. */
export function characterInfoFor(slug) {
  const k = String(slug || "").trim().toLowerCase();
  return CHARACTER_INFO[k] || null;
}
