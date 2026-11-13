# Game data sync ledger

**Written:** 2026-08-23 · **Updated:** 2026-11-13 · **Game state:** main branch
**v0.111.0** (promoted Nov 12, 2026) · beta branch **v0.113.0** (Nov 12, 2026 — The Fool,
Blitz, Dread). Before Nov 12, main was **v0.107.1** ("Major Update 2", Jun 2026).

> **Nov 12, 2026 branch shift.** Mega Crit's v0.113.0 notes: *"The main branch will be
> brought up-to-date with all content and changes in the previous, more stable beta
> version, v0.111.0."* (the October 2026 Neowsletter announced the same). So the whole
> v0.108 → v0.111 netted table below **now describes main** and graduated out of the
> watchlists into primary text; v0.113.0 is the new beta watch (section further down).
> Source: Steam news gid 1849192144184507, "Beta Patch Notes - v0.113.0".

## Why this file exists

The app displays game data in three layers — generated (`Web/assets/sts2/labels.json`,
`manifest.json`), hand-curated (`Web/lib/relic-info.js`, `ascension-info.js`,
`character-info.js`, `VaultApp/App/Overlay/STS2CardGlossary.swift`), and enumerations
(characters, schema versions). Every game patch can silently strand any of them. This
ledger nets out the official patch notes into the exact edits the app needs, and is the
backlog the release loop works through. `Web/scripts/check-game-data.mjs` enforces the
cross-source invariants at deploy time; this file records the judgment calls.

## Branch policy (important)

**Most players run main (v0.111.0 since 2026-11-12). All default app copy describes
main.** Beta-only
changes are recorded as clearly-labeled "beta watch" notes, exactly the convention the
glossary and relic-info already use. When the beta promotes to main, the watchlists
graduate into the primary text.

Getting this wrong in either direction is a correctness bug: describing beta text to a
main-branch player is just as wrong as the reverse. Sources that "just apply the latest
patch" are describing a branch 90% of players are not on.

## Beta watch: v0.113.0 (Nov 12, 2026)

Beta-only. Main-branch players have none of this. The "Main (v0.111.0)" column comes
from the notes' own "from X → Y" clauses, so it doubles as verified main-branch text.

| Subject | Beta v0.113.0 | Main v0.111.0 |
| --- | --- | --- |
| **New character: The Fool** | "A silly musician who wields a bow." Card pool, starter relic and save-file token not published | — |
| **New mode: Blitz** | Condensed deckbuilding mode, no map, Gold doesn't matter; own 5-level Ascension shared across characters; unlocked by finishing an Ascension run | — |
| **New mode: Dread** | Unlocked at A10 on every character (incl. The Fool); all Ascension modifiers on; bosses stronger and buff their Act's enemies; curses pile up | — |
| General · rest sites | Can appear one floor earlier in every act | — |
| Neow · Dowsing Rod | Dowsing transforms after **4** ? rooms; the transforming ? room can't be a combat | 5 ? rooms |
| Nonupeipe · Brilliant Scarf | **6th** card | 5th card |
| Defect · Power Cell (relic) | Picks zero-cost cards without Innate before Innate ones | — |
| Ringing Triangle (relic) | Gives Retain Hand at start of combat (stacks with Equilibrium etc.) | — |
| Ironclad · Expect a Fight | Uncommon Skill, cost 3: "Gain 15(20) Block. Attacks in your Hand cost 1 less Energy until played." | "Gain 15(16) Block. Gains 5(8) additional Block for each Strength you have." |
| Ironclad · Forgotten Ritual | Reverted: only gains 3(4) Energy if you Exhausted a card this turn | Implied unconditional (notes say "reverted"); exact main text not published |
| Silent · Expertise | "Draw 2(3) cards. Retain your Hand this turn." | "Draw 2(3) cards. They gain Retain this turn." |
| Silent · Memento Mori | Uncommon Attack, cost **3**: "Sly. Deal 19(23) damage to the enemy with the lowest HP." | Cost 1: "Deal 9(11) damage. Deals 4(5) additional damage for each card discarded this turn." |
| Silent · Speedster | Damage 3 | 2 |
| Silent · Phantom Blades | Extra Shiv damage 8(11) | 9(12) |
| Silent · Tracking | Wording only: "…from your Attacks" | "…from Attacks" |
| Regent · CHARGE!! | Minion Dive Bomb 11(13) | 13(16) |
| Colorless · Salvo | Damage 10(14) | 12(16) |
| Colorless · My Shinies | New card (text not published) | — |
| Events | New: Waterfall of Obvious Secrets, Wuppy in Trouble (Underdocks); Museum of Torture (Act 2); Shrine of the Warlord, Thermae Nonupeipe (Act 3); Byrdpip evolution | — |
| Event cards | New: Dingy Dagger; Mighty Weapon, Mighty Shield | — |
| Event relics | New: Wuppy; Obsidian Vice, Thumbscrew, Tormentous Collar; Mighty Wings; Bath Towel, Bath Robes (effects not published) | — |
| Doors of Light and Dark | Light Door upgrades 1 card of your choice | 2 random cards |
| Zen Weaver · Breathing Techniques | 25 gold, adds 1 Enlightenment; Enlightenment loses Exhaust | 50 gold, 2 Enlightenment |
| Waterlogged Scriptorium | Prickly Sponge costs 120 gold | 99 gold |
| Enemies | Axebot HP fixed 70 (80 at A8) · Infested Prism: no Radiate, Jab/Jab/Whirlwind/Pulsate, Pulsate applies 1 Vulnerable (no Block) · Tunneler "From Below" 24 (28 at A9) | Axebot 70-78 (76-86) · Pulsate 20 Block (22) · Attack from Below 23 (26) |
| Writing | Kaiser Crab moves: Targeting Reticle → Calculating, Precision Beam → Precise Smash, Laser → Rocket Claw · Ambergris buff named "Extra Turn" | — |
| Bug fixes with text impact | Jeweled Mask's free power stays free all combat · One for All only boosts autoplayed cards that would have cost 0 · Omnislice 2nd hit triggers on-attack effects | — |

## Netting the beta timeline (v0.108 → v0.111) — main since 2026-11-12

Several v0.109 redesigns were reverted or re-tuned within two patches. This table is the
**net state at v0.111.0**, which is what main got on Nov 12, 2026:

| Subject | Net state at v0.111.0 (beta) | Journey |
| --- | --- | --- |
| Silent · Outbreak | Rare Skill, applies Poison to ALL enemies and triggers it immediately | 0.108 Power dmg-per-application → 0.109 buff → 0.110 rework to Skill |
| Silent · Scare | **Renamed Sidestep**; no Weak; grants 1(2) Energy next turn | 0.110 |
| Silent · Haze | Cost 2; applies Poison + 1(2) Weak to all enemies | 0.110 |
| Silent · Mirage | Block from enemy Poison; **Exhausts, upgrade removes Exhaust** | 0.109 rework → 0.110 revert → 0.111 exhaust tweak |
| Silent · Well-Laid Plans | Cost 2(1); prevents discarding hand at end of turn; Rare | 0.109 rework → 0.110 cost nerf |
| Silent · Expertise | Draw 2(3) with Retain (was draw-to-6) | 0.109 |
| Silent · Echoing Slash | Uncommon (was Rare) | 0.110 |
| Silent · Accelerant | Uncommon (was Rare) | 0.109 |
| Silent · Tracking | +50% dmg vs Weak (was +100%) | 0.108 |
| Regent · Pillar of Creation | Block on EVERY created card, 2(3) | 0.109 once-per-turn → 0.110 revert at lower value |
| Regent · Regalite (relic) | Block on first created card per turn, **4** | 0.110 rework → 0.111 6→4 |
| Regent · Guiding Star | 1 star; draw happens NEXT turn | 0.111 |
| Regent · Alignment | 2 stars (was 3) | 0.111 |
| Necrobinder · Eidolon | Plays all Ethereal cards in Exhaust pile; can no longer be generated mid-combat | 0.109 rework → 0.110 restriction |
| Necrobinder · Sacrifice | Block = triple Osty's Max HP | 0.110 |
| Necrobinder · Soulbound (sp) | Souls shuffle into draw pile (was bottom) | 0.109 |
| Necrobinder · Legion of Bone | No longer Exhausts (missing from earlier revisions of this table) | 0.108 |
| Defect · Hyperbeam | 24(30) to ALL enemies; lose 3 Focus **this turn** (not permanently) | 0.109 buff → 0.111 rework down |
| Defect · Synchronize | Focus 1(2); no longer self-Exhausts | 0.110 buffs → 0.111 focus nerf |
| Defect · Rocket Punch | Status creation reduces cost by 1 (not to 0) | 0.110 |
| Ancients · Vakuu's Fiddle | Draw 2 (0.109's 3 was reverted) | 0.109 → 0.110 revert |
| Ancients · Nonupeipe's Diamond Diadem | Start combat with 20 persistent Block | 0.109 |
| Ancients · Beautiful Bracelet | Enchants 4 RANDOM cards; Swift 2 | 0.110 count+swift → 0.111 random |
| Ancients · Seal of Gold | Lose 3 gold (was 5) | 0.110 |
| Ancients · Toasty Mittens | Exhausts from HAND (was draw pile) | 0.110 |
| Ancients · Fur Coat | 8 marked combats (was 7) | 0.110 |
| Ancients · Signet Ring | 888 gold (was 999) | 0.110 |
| Ancients · Brightest Flame | Lose 2 max HP on activation (was 1) | 0.111 |
| Ancients · Toybox | 5 relics (was 4) | 0.109 |
| Ancients · Meat Cleaver | "HP gain decreased from 9 -> 5" (Mega Crit's wording; earlier revisions of this table said "heal") | 0.109 |
| Ancients · History Course | Repeats ATTACKS only (was attack-or-skill) | 0.109 |
| Colorless · Rend | Cost 1, damage 10(12) | 0.111 |
| Ironclad · Expect a Fight | Cost 3, "Gain 15(16) Block. Gains 5(8) additional Block for each Strength you have." (an Ironclad card — earlier revisions of this table filed it under Colorless) | 0.109 + 0.111 |
| Enemies (A8/A9) | Exoskeleton A8 HP 26-30 · Globe Head A9 Galvanic 8 · Louse Progenitor A9 Str 7 · Soul Fysh A9 De-Gas 18 · Entomancer A8 HP 165 · Torchhead turn-1 26(32) | 0.108/0.109/0.111 |
| Enemies (all A) | Axebot: Hammer Uppercut 14(18), One-Two 10(11)x2, +10 HP per respawn · Mechaknight Flamethrower 8(12) · Aeonglass Ebb 22(26) | 0.109/0.111 |

### Content added in v0.108 → v0.111 (beta then; main since 2026-11-12)

- **Multiplayer cards (0.108):** Ironclad — Midnight, Blaze, Outrage · Silent — Blade
  Symphony, Concoct, Fade · Regent — Plot, Constellation · Necrobinder — Underworld,
  Soulbound, Cacophony · Defect — Hibernate, One For All, Imitation Learning.
- **Multiplayer cards (0.109):** Regent — Tutor.
- **Neow relics + quest card (0.109):** Dowsing Rod, Neow's Sacrifice (labels already
  present from the May pass — verify), quest card **Neow's Abundance**.
- **System:** seeds are now 12 characters (0.109) — parser/display must not assume
  shorter; keyboard-only mode, map Share button (0.110); Indonesian + Traditional
  Chinese locales; low-HP idle animations (0.111).

## Work items

| # | Item | Surface | Status |
| --- | --- | --- | --- |
| 1 | Fix Silent starter slug `pureblood` → `ringofthesnake`, Defect `cracked_orb` → `crackedcore`; correct STS1 wording using companion DB text | `Web/lib/relic-info.js` | done |
| 2 | Fix `ring_of_the_snake` STS1 "draw 2" text; align starter slugs | `STS2CardGlossary.swift` | done |
| 3 | Refresh beta watchlists to net-v0.111 (table above) | `relic-info.js`, `STS2CardGlossary.swift` | done |
| 4 | A8/A9 enemy-tuning beta notes on ascension tiers | `Web/lib/ascension-info.js` | done |
| 5 | Add labels: `sidestep`, beta multiplayer cards, verify Neow relic labels | `Web/assets/sts2/labels.json` (+`MANIFEST_VERSION`) | done |
| 6 | NewsView posts for v0.110.0 + v0.111.0 (+ content-update teaser) | `VaultApp/App/NewsView.swift` | done |
| 7 | Remove Watcher leftovers (`CHAR_THEME`, `CHAR_META`, `CLASS_PREFIXES`) | `Web/script.js` | done |
| 8 | Reconcile labels 284 vs disk 288 relics; boss labels vs manifest (Aeonglass) | `labels.json` | done¹ |
| 9 | Regent glossary 3 → 25+ cards, Necrobinder 2 → 25+, + their starter relics | `STS2CardGlossary.swift` | done |
| 10 | relic-info coverage ~32 → 70+ (companion DB text, main-branch values) | `Web/lib/relic-info.js` | done |
| 11 | Cross-source drift guard in preflight | `Web/scripts/check-game-data.mjs` | done |
| 12 | Game-updates panel + "data synced" freshness badge | `Web/index.html` / `Web/lib` | done |
| 13 | Verify 12-char seed handling end to end | `sts2-run-parser.js`, share surfaces | done² |
| 14 | Demo-run slugs all resolve to labels | `Web/lib/demo-runs.js` | done |
| 15 | Nov 12 shift: graduate the v0.108 → v0.111 watchlists into main text (numbers from Mega Crit's own "from → to" notes; Distinguished Cape removed — its swapped downside was never published) | `relic-info.js`, `STS2CardGlossary.swift` | done⁴ |
| 16 | Glossary entries newly verifiable from v0.113 "from" clauses + v0.108 multiplayer cards (Expect a Fight, Memento Mori, Sidestep, Hyperbeam, Brightest Flame, 16 multiplayer cards) | `STS2CardGlossary.swift` | done |
| 17 | New beta watchlists: v0.113.0 (table above) | `relic-info.js`, `STS2CardGlossary.swift` | done |
| 18 | Labels: My Shinies, Dingy Dagger, Mighty Weapon, Mighty Shield (+upgrades); Wuppy, Obsidian Vice, Thumbscrew, Tormentous Collar, Mighty Wings, Bath Towel, Bath Robes; `MANIFEST_VERSION` 4 → 5 | `labels.json`, `script.js` | done |
| 19 | A8/A9 notes: v0.111 tuning now main; v0.113 Axebot / Infested Prism / Tunneler on beta | `ascension-info.js` | done |
| 20 | The Fool (`fool`, accepts `fool` / `thefool` / `the_fool`): parser, stats, labels, themes, run filters, co-op; rendered rosters add it only when the user has a Fool run, so main-branch layouts are unchanged | `sts2-run-parser.js`, `stats-engine.js`, `script.js`, co-op libs, `Backend/src/coop-*.ts`, `TheVault/…/RunRecord.swift` | done⁵ |
| 21 | Blitz / Dread: any `game_mode` containing "blitz"/"dread" folds to that word; tagged in run lists; excluded from the standard Ascension ladder (`byAscension`, average ascension, ascension filters); still count toward overall/character/relic/card stats like Daily/Custom | `sts2-run-parser.js`, `stats-engine.js`, `script.js`, `Backend/src/runs.ts` | done⁵ |
| 22 | News post 014 (web + native NewsView) | `index.html`, `script.js` (`LATEST_NEWS_POST_ID`), `NewsView.swift` | done |
| 23 | `GAME_SYNC` main v0.111.0 / betaWatch v0.113.0 | `game-sync.js` | done |
| 24 | Fool character-info entry, Fool art, Fool card labels | `character-info.js`, assets, `labels.json` | blocked — nothing published; the Characters tab falls back to personal stats |
| 25 | Swift `StatsEngine.byAscension` still counts Blitz/Dread (mode lives only in `raw["game_mode"]`) | `TheVault/…/StatsEngine.swift` | open |
| 26 | Watch `/admin` `ingest-unknown-schema` once beta players upload v0.113 runs; confirm the real Fool / Blitz / Dread save tokens and tighten the aliases | `sts2-run-parser.js` | watch |

### Footnotes / known gaps

1. **Aeonglass boss art is still missing** — labels, taunts and kill-by text all
   render correctly; the image falls back to the standard letter glyph. The wiki
   blocks scripted downloads (403) and the local companion checkout has no boss
   art, so closing this needs a manual asset drop like `architect-wiki.webp` was.
   Everything else in the labels-vs-art gap is naming-scheme variance the
   resolvers already handle (`gold_platedcables` vs `goldplatedcables`, `fake*`
   counterfeit art) plus five Neow relics that have labels but no published art.
2. Seeds: parser passes any string through, backend clamps at 64 chars, display
   slices at 12–14 — the beta's 12-character seeds fit every surface.
3. `KNOWN_SCHEMA_VERSIONS` stays `{8, 9}` — it only gates an admin beacon
   (unknown schemas still parse fine). Nobody has observed a schema bump on
   main v0.107.1; watch `ingest-unknown-schema` on `/admin` after each game
   patch and extend the set when a new schema is actually seen.

4. Two graduated relic sentences are not verbatim: **Beautiful Bracelet** (Mega Crit published
   only the numbers — 4 random cards, Swift 2 — so the sentence follows the game's phrasing
   for random enchants) and **Diamond Diadem** (v0.109 wording; v0.110 reworded it in-game
   "to be clearer about how long its effect lasts" without publishing the new sentence). The
   numbers are exact; both carry a code comment. Replace with in-game text when available.
5. The Worker must be deployed for co-op lobbies to accept `fool` and for cloud copies to
   keep the Blitz/Dread mode; until then the server drops both silently.

### Deployed 2026-11-13

Web **v219** (Pages deployment `f2ba7d89`, built from a data-only copy of commit 78571ea —
no redesign code) and Worker `vault-coop` version `20ce03bf-3362-4bd2-93ff-872a352093ee`.
The redesign working tree moved to v220 so it can never reuse the v219 script URL.
Desktop (VaultApp) changes — glossary and NewsView post 014 — ship with the next app build.

## Verification

- `make -C Web preflight` — parse, version pins, asset versions, **game-data guard**.
- `make -C Backend preflight` — tsc + 29 offline logic checks.
- Manual: local stack at `127.0.0.1:8788`, glossary/relic tooltips spot-checked against
  companion DB text.

## Sources

- Official notes mirrored at patchdiff.com and sts2.untapped.gg (v0.108.0 Jul 3,
  v0.109.0 Jul 17, v0.110.0 Jul 31, v0.111.0 Aug 14, all beta).
- Main-branch status: v0.107.1 confirmed current as of Aug 2026 (multiple databases
  hold main-branch data at v0.107.1 and mark 0.108+ as beta).
- Ground truth for main-branch card/relic text: local companion checkout
  `SlayTheSpire2Companion/SlayTheSpire2Companion/Data/GameDatabase*.swift`
  (gitignored; the richest STS2 database available to this repo).
