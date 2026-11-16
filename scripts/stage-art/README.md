# Stage art masters

Masters for the new look's header stage. The page never loads these; the
build scripts turn them into web assets:

| Folder | Built by | Writes |
| --- | --- | --- |
| `scenes/<id>.webp` (3840x1280, 3:1) | `node scripts/build-stage-scenes.mjs` | `Web/assets/stage/scenes/*`, `Web/lib/ui/stage-scene-list.js` |
| `figures/<id>.webp` (transparent) | `node scripts/build-stage-sprites.mjs` | `Web/assets/stage/<id>-ink-v3.webp`, `Web/lib/ui/stage-actors.js` |
| `props/<id>.webp` (transparent) | `node scripts/build-stage-props.mjs` | `Web/assets/stage/props/<id>-v<N>.webp`, `Web/lib/ui/stage-props.js` |
| `life/<id>.webp` (transparent) | `node scripts/build-stage-life.mjs` | `Web/assets/stage/life/<id>-v<N>.webp`, `Web/lib/ui/stage-life-sprites.js` |

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

## Props (the tower and the torches)

Generated with the same model and settings as the figures (`2:3`, `2k`,
`background: transparent`, quality `high`), two of each, the cleaner kept,
then `cwebp -q 95 -alpha_q 100 -exact -m 6 in.png -o scripts/stage-art/props/<id>.webp`.
`build-stage-props.mjs` crops each master to its art (boxes measured on the
master) and holds the tower's door, window and brazier positions as
fractions of the crop. A new master moves them: measure again (the centre
column of the tower, scanned for the dark window slits) and bump the
prop's `version`.

Shared style part (as for the figures):

> Style: crisp hand-inked cel-shaded game art. Confident dark navy ink
> outlines, thicker on the outer silhouette and thinner inside. Flat colour
> fills with two or three clean shading tones per material and one soft cool
> rim light from the left. Smooth clean shapes: no brush texture, no noise,
> no posterization blotches, no smudges.

| id | use | prompt (before the style part) | after it |
| --- | --- | --- | --- |
| tower | the tower: door = A0, ten windows = A1–A10, brazier = the A10 beacon | A tall slender dark-fantasy stone spire tower drawn as a clean, finished 2D game illustration prop for a card game companion app. The tower stands perfectly upright and centered, seen straight from the front at eye level: a sturdy square base with a small arched wooden door at the bottom center, then three tapering tiers of weathered blue-grey stone blocks with carved stone ledges between the tiers, and a tall pointed dark slate roof crowned by a small iron brazier bowl at the very tip. Exactly ten small narrow arched window slits run up the middle of the tower in one straight vertical line, evenly spaced from just above the door to just below the roof, every window dark and unlit with a deep navy interior. Thin burnished gold trim on the ledges, a little moss at the base. | The whole tower is visible from the roof tip to the bottom of the base, nothing cropped, and the base ends in a flat straight horizontal line. Isolated on a fully transparent background: no ground, no floor, no cast shadow, no sky, no glow halo, no light inside the windows, no flame in the brazier, no text. |
| torch | one run in the last ten (cold; a won run adds the flame) | A single standing torch for a dark-fantasy card game, drawn as a clean, finished 2D game illustration prop: a short straight wooden post with two black iron bands, topped by a small black iron cup holding a charred, burnt-out torch head of blackened wrapped cloth, cold and unlit. Seen straight from the front at eye level, perfectly upright and centered, the whole torch visible from the top of the burnt head to the flat bottom of the post, nothing cropped. | Isolated on a fully transparent background: no ground, no floor, no cast shadow, no flame, no smoke, no embers, no glow, no text. |
| flame | a won run's torch, and the A10 beacon | A single torch flame for a dark-fantasy card game, drawn as a clean, finished 2D game illustration effect sprite: one tall teardrop-shaped flame licking upward, with a bright pale-yellow inner core, a warm golden-orange body and two or three red-orange tongues curling at the edges, symmetrical and centered. The flame's bottom ends in a rounded base, as if it sits on a torch head, but the torch itself is NOT drawn. (Style: crisp hand-inked cel-shaded game art with a confident dark navy ink outline around the flame and its tongues, flat colour bands for the core, body and edge, smooth clean shapes, no brush texture, no noise.) | The whole flame visible, nothing cropped. Isolated on a fully transparent background: no glow halo, no smoke, no sparks, no embers, no torch, no text. |

## Life sprites (what crosses, drifts and falls in the scenes)

Generated with the same model (`resolution 2k`, `background: transparent`,
quality `high`), one each; aspect `3:2` for the clouds, crow and bat,
`1:1` for the leaves and the islet, `2:3` for the bolt and the wisp. Re-saved
with `cwebp -q 95 -alpha_q 100 -exact -m 6 in.png -o scripts/stage-art/life/<id>.webp`.
`build-stage-life.mjs` crops each to its art (boxes measured on the master)
and sizes it; where each scene uses them, and how they move, is
`Web/lib/ui/stage-life-list.js`.

Every prompt ends with the style part: "Style: crisp hand-inked cel-shaded game art. Confident dark navy ink
outlines (clouds: a thin soft outline round the outer edge only), flat colour
fills with two or three clean shading tones, smooth clean shapes: no brush
texture, no noise. The whole thing visible, centered, nothing cropped.
Isolated on a fully transparent background", then what to leave out (no sky,
no ground, no shadow, no other copies, no glow halo, no text).

| id | used for | prompt (before the style part) |
| --- | --- | --- |
| cloud-pink | Above the clouds: three depths of drifting cloud | A single long, soft, drifting cloud bank for a dreamy sunset sky above floating sky ruins: wide and low, rounded billowing tops and a flatter underside, lit warm peach and pale pink from above with soft lilac-violet shading underneath. |
| cloud-night | the rest site and the Frozen Ledge: wisps crossing the peaks | A single long, thin, drifting night cloud wisp for a moonlit mountain sky: stretched horizontally with ragged trailing ends, deep slate blue and dusky indigo with a pale silver-blue moonlit upper edge. |
| cloud-ash | the Ember Wastes: ash rolling over | A single billowing cloud of volcanic ash smoke drifting sideways: rolling puffs in charcoal and dark maroon, underlit with hot orange-red glow on the lower curls. |
| crow | crows crossing (overgrowth, rest site, above the clouds) | A single small black crow flying, seen from the side, wings spread wide mid-flap: glossy blue-black feathers, separated wingtip feathers, small beak, tail fanned. |
| bat | bats leaving the arches (underdocks, ossuary, hall) | A single small bat flying, seen from the front, leathery wings spread wide and symmetrical: dusky charcoal-purple body and membranes with visible finger bones, pointed ears, tiny glinting eyes. |
| leaf-red | the rest site's tree | A single autumn maple leaf, flat and slightly curled, deep crimson-red fading to burnt orange at the tips, short stem, clear veins. |
| leaf-green | the Overgrowth's canopy | A single broad jungle leaf, gently curled, rich leaf-green with a lighter yellow-green midrib and veins, short stem. |
| bolt | lightning over the Ember Wastes | A single jagged lightning bolt striking downward with two short forked side branches: near-white core, hot pale-gold edge, thin orange outer rim, tall and narrow. |
| wisp | spirits rising in the Ossuary | A single small ghostly wisp spirit floating upward: a rounded head of pale mint-green spectral flame with two tiny hollow dark eyes, trailing a long curling tail fading from bright mint to deep sea-green. |
| islet | floating islets bobbing above the clouds | A single small floating sky island: pale lilac-grey rock with a flat grassy top carrying one broken ruined stone arch, a jagged underside tapering to a point with dangling roots, lit warm peach from the upper left with soft violet shadows. |
