# Game data sync ledger

**Written:** 2026-08-23 · **Game state:** main branch **v0.107.1** ("Major Update 2",
Jun 2026) · beta branch **v0.111.0** (Aug 14, 2026). Mega Crit has said v0.111.0 is
the last beta for a while; a large content update is teased next.

## Why this file exists

The app displays game data in three layers — generated (`Web/assets/sts2/labels.json`,
`manifest.json`), hand-curated (`Web/lib/relic-info.js`, `ascension-info.js`,
`character-info.js`, `VaultApp/App/Overlay/STS2CardGlossary.swift`), and enumerations
(characters, schema versions). Every game patch can silently strand any of them. This
ledger nets out the official patch notes into the exact edits the app needs, and is the
backlog the release loop works through. `Web/scripts/check-game-data.mjs` enforces the
cross-source invariants at deploy time; this file records the judgment calls.

## Branch policy (important)

**Most players run main (v0.107.1). All default app copy describes main.** Beta-only
changes are recorded as clearly-labeled "beta watch" notes, exactly the convention the
glossary and relic-info already use. When the beta promotes to main, the watchlists
graduate into the primary text.

Getting this wrong in either direction is a correctness bug: describing beta text to a
main-branch player is just as wrong as the reverse. Sources that "just apply the latest
patch" are describing a branch 90% of players are not on.

## Netting the beta timeline (v0.108 → v0.111)

Several v0.109 redesigns were reverted or re-tuned within two patches. Watchlist entries
must reflect the **net state at v0.111.0**, not any intermediate:

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
| Defect · Hyperbeam | 24(30), still reduces Focus | 0.109 buff → 0.111 rework down |
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
| Ancients · Meat Cleaver | Heal 5 (was 9) | 0.109 |
| Ancients · History Course | Repeats ATTACKS only (was attack-or-skill) | 0.109 |
| Colorless · Rend | Cost 1, damage 10(12) | 0.111 |
| Colorless · Expect a Fight | Cost 3, Block 15(16) scaling with Strength; no energy-gain restriction | 0.109 + 0.111 |
| Enemies (A8/A9) | Exoskeleton A8 HP 26-30 · Globe Head A9 Galvanic 8 · Louse Progenitor A9 Str 7 · Soul Fysh A9 De-Gas 18 · Entomancer A8 HP 165 · Torchhead turn-1 26(32) | 0.108/0.109/0.111 |
| Enemies (all A) | Axebot: Hammer Uppercut 14(18), One-Two 10(11)x2, +10 HP per respawn · Mechaknight Flamethrower 8(12) · Aeonglass Ebb 22(26) | 0.109/0.111 |

### New beta-only content (labels needed so runs never show raw slugs)

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
