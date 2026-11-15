# Stage art masters

Masters for the new look's header stage. The page never loads these; the
build scripts turn them into web assets:

| Folder | Built by | Writes |
| --- | --- | --- |
| `scenes/<id>.webp` (3840x1280, 3:1) | `node scripts/build-stage-scenes.mjs` | `Web/assets/stage/scenes/*`, `Web/lib/ui/stage-scene-list.js` |
| `figures/<id>.webp` (transparent) | `node scripts/build-stage-sprites.mjs` | `Web/assets/stage/<id>-ink-v3.webp`, `Web/lib/ui/stage-actors.js` |

All of them were generated with GPT Image 2.6 (Higgsfield), quality `high`.
Scenes: `size 3840x1280`, resolution `4k`, PNG, re-saved here as WebP q92.
Figures: `2:3` (or `1:1` for wide poses), resolution `2k`,
`background: transparent`, with the game's own sprite
(`Web/assets/sts2/characters/<id>-v2.webp`, the Architect:
`Web/assets/sts2/bosses/architect-crystal-v4@2x.webp`) as the reference
image, re-saved here as WebP q95 with lossless alpha.

## Adding one

1. Generate it with the prompt below, download the PNG.
2. Scene: `cwebp -q 92 -m 6 in.png -o scripts/stage-art/scenes/<id>.webp`, add
   its entry (colours, `veil`, `mist`, lights, shafts, air layers, `focus`) to
   `SCENES` in `build-stage-scenes.mjs`, run it. Place lights from a preview
   with a 5% grid over it: positions are fractions of the picture. A wide
   desktop header shows roughly the band from `focus - 0.46` to `focus`, so
   a light meant to be seen there has to sit in that band (the aurora's
   upper curtains only show on phones).
   Figure: generate two and keep the cleaner one, then
   `cwebp -q 95 -alpha_q 100 -exact -m 6 in.png -o scripts/stage-art/figures/<id>.webp`,
   point the actor's `drawn` at it in `build-stage-sprites.mjs`, bump its
   `version`, run it. Then check the seat / `headX` / `footY` staging and the
   `glows` (eyes, flame, cores) in `ACTOR_STAGING`, `Web/lib/ui/stage.js`,
   against the built sprite and a capture: they are fractions of the built
   art, so a redraw moves them.
3. `node scripts/verify-ui-next.mjs --only scene` and look at captures with
   every climber at 1728px and 390px before showing anyone.

## Scene prompt

Shared part (keep it word for word so the set stays consistent):

> Ultra-wide panoramic environment background (3:1) for the header banner of
> a dark-fantasy card game companion app. Hand-painted 2D game environment
> art: bold dark ink linework, flat cel-shaded colour shapes with soft painted
> gradients, rich saturated jewel tones, clear atmospheric depth (near forms
> darker and crisper, distance hazier and lighter). It must match stylised
> hand-inked characters that will stand on top of it. COMPOSITION: eye-level
> side view like a 2D side-scrolling battle scene. A flat, continuous,
> walkable ground plane spans the full width along the bottom 18% of the
> image. The right 40% is the stage where two characters will stand: keep it
> open, uncluttered and mid-dark, just plain floor and a calm softly lit back
> wall or distant scenery, no bright light sources, no props or architecture
> in the lower two thirds there. The far left 35% stays darker and low in
> detail so white title text reads on top. Put the hero landmark and main
> light source in the middle distance, center-left to center. Strictly no
> characters, creatures, people, animals, statues of people, text, letters,
> logos, UI, frames or borders. SCENE: …

Scenes (all twelve are in; every one came out usable on the first try):

| id | status | SCENE: … |
| --- | --- | --- |
| glory | done | THE HALL OF GLORY near the top of a colossal spire: a vast moonlit marble throne hall with towering gilded columns, tall arched windows pouring cool cyan moonlight, hanging crimson-and-gold banners, a polished stone floor with soft reflections. Palette: deep indigo, cyan moonlight, burnished gold. |
| hive | done | THE HIVE: a cavernous honeycomb chamber of amber wax, walls of hexagonal cells glowing with golden honey light, slow drips of resin, organic arches and pillars. Palette: amber, ochre, burnt orange, deep brown shadows, a hint of toxic green. |
| study | done | THE ARCHITECT'S OBSERVATORY: a circular arcane study at the summit of a tower, a great brass orrery with planets, star globes, towering bookshelves, drafting tables with scrolls and blueprints, a huge domed window showing a starry night sky, warm candlelight. Palette: copper, amber candlelight, midnight blue. |
| overgrowth | done | THE OVERGROWTH: crumbling ancient temple ruins swallowed by a giant jungle, mossy broken pillars, thick hanging vines and roots, bioluminescent flowers, soft green god rays slanting through the canopy. Palette: emerald, moss, chartreuse glow, teal shadows. |
| underdocks | done | THE UNDERDOCKS: a flooded underground harbour beneath a city, a wide stone quay along the bottom, rotting wooden piers and moored skiffs in the middle distance, iron chains, hanging green lanterns, still dark water with glowing reflections, great stone vaults overhead. Palette: violet, deep plum, toxic sea-green lantern light. |
| campfire | done | A CAMPFIRE REST SITE: a quiet clearing at night at the foot of the spire, a crackling campfire placed center-left with logs and a bedroll, ancient standing stones, a starry sky and distant mountains, warm firelight fading into cool blue night. Palette: ember orange against deep navy. |
| merchant | done | THE MERCHANT'S TENT: inside a cosy travelling merchant's tent, layered patterned rugs on the floor, hanging brass lanterns, shelves of potion bottles, chests of relics and scrolls, draped silk walls. Palette: magenta, plum, gold, warm lamplight. |
| crystal | done | THE CRYSTAL DEPTHS: a vast cavern of giant amethyst and rose quartz crystals glowing from within, a still underground pool reflecting the light, faint mist. Palette: violet, magenta, cool pink, deep purple shadows. |
| aurora | done | THE FROZEN LEDGE: a windswept snowy cliff ledge high on the spire under a swirling green-and-teal aurora, jagged icy peaks in the distance, gently falling snow. Palette: ice blue, teal and green aurora, navy night. |
| embers | done | THE EMBER WASTES: a scorched volcanic plain with rivers of glowing lava in the distance, obsidian spires, ash clouds lit red from below, drifting embers. Palette: crimson, molten orange, charcoal black. |
| clouds | done | ABOVE THE CLOUDS: the very top of the spire breaking through a sea of clouds at dawn, floating ruined stone platforms, a huge pale sun low in the sky, layered pastel cloud banks. Palette: rose gold, peach, lavender, pale teal sky. |
| crypt | done | THE OSSUARY: an ancient crypt of bone-lined arches and stone sarcophagi, candles burning with eerie green ghostfire, cobwebs, low drifting fog. Palette: bone white, sickly ghost-green, deep teal-black. |

## Figure prompt

> Redraw the character in the reference image as a clean, finished 2D game
> illustration. Keep the exact same character design, pose, silhouette,
> proportions, costume, colour scheme and facing direction as the reference,
> so it reads as the same official character with nothing added or removed:
> {DESCRIPTION}. Style: crisp hand-inked cel-shaded game art. Confident dark
> navy ink outlines, thicker on the outer silhouette and thinner inside. Flat
> colour fills with two or three clean shading tones per material and one
> soft rim light. Smooth clean shapes: no brush texture, no noise, no
> posterization blotches, no smudges. Saturated but natural colours. Full
> body visible including feet, centered, nothing cropped. Isolated on a fully
> transparent background: no ground, no floor, no cast shadow, no smoke, no
> glow halo, no text.

| id | status | aspect | DESCRIPTION |
| --- | --- | --- | --- |
| ironclad | done | 2:3 | a bulky warrior in battered bronze-and-brown plate armour with a horned helm and a glowing red eye slit, resting in a low crouch with one knee raised and arms on the knee, exactly as posed in the reference |
| fool | done | 1:1 | a round, hunched figure in a big mustard-yellow hood with a pointed tip and two glowing green eyes in a dark face, a mossy green scarf, teal sleeves, yellow tunic, crouching low with hands on knees, exactly as posed in the reference |
| architect | done | 2:3 | a tall sage with a tall golden crested mask-helm and long white beard, gold plate armour on shoulders and legs, navy tunic, flowing brown robe with an orange sash, floating in a seated pose with legs crossed, gripping a long silver spear-staff crowned with a blue flame in one hand and holding a red book up in the other (and: "Full figure visible from flame tip to staff end") |
| silent | done | 2:3 | a slender huntress wearing a pale bird-skull mask with small antlers, a long tattered green hooded cloak, bandage-wrapped arms and legs with reddish-brown straps, standing and leaning with crossed legs exactly as posed in the reference |
| defect | done | 1:1 | a stocky bronze automaton with a round head holding a glowing blue orb eye, a teal cloth cape over its shoulders, a blue glowing core in its chest, sitting on the ground with legs spread and clawed hands forward, exactly as posed in the reference |
| regent | done | 2:3 | a small proud noble with an orange crown-like crest, blue coat, brown trousers, seated sideways on a very tall dark grey stone throne with a high pointed back. IMPORTANT CHANGE: remove the small creature crushed beneath the throne's front corner entirely; the throne stands with an intact, flat stone base resting directly on the ground |
| necrobinder | done | 2:3 | a gaunt skeleton with a large pale skull, wearing a high-collared crimson and dusty-rose robe with long flowing sleeves, holding a small book at the chest, sitting upright with bony feet showing, exactly as posed in the reference (and: "no seat") |
