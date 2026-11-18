# Brand art masters (the crest)

The SpireVault logo is the crest: a shield, the spire dark against an ember
sky, a small flame at its tip and one lit window. The owner picked it on
2026-11-16 from four directions (seal, vault door, crest, beacon tower).

| File | What it is | Used for |
| --- | --- | --- |
| `crest.webp` | the full emblem | 48px and up: the rail, the landing page, install and home-screen icons, desktop app icons |
| `crest-small.webp` | the same crest simplified: plain sky, a wider spire, a bigger flame | 16-32px: favicons, the tray, avatars |

`node scripts/build-brand-icons.mjs` turns them into every logo file:

- web: `Web/assets/brand/crest-*-v1.*`, `Web/favicon.ico`
- the landing page: `Site/assets/art/crest-*-v1.*`, `Site/favicon.ico`
- the macOS app: `VaultApp/Resources/Assets.xcassets/{AppIcon,VaultEmblem}`
- the Windows app: `WindowsApp/src-tauri/icons/*`, `WindowsApp/ui/emblem.png`

`node scripts/build-brand-og.mjs` then renders the app's link preview
(`Web/assets/og-crest-v1.png`): the crest and wordmark over the campfire scene.

Web files have versioned names because `/assets` is cached as immutable.
When a master changes, bump `VERSION` in the build script and every
reference to the old names.

## How they were made

Generated with GPT Image 2.6 on Higgsfield: `1:1`, resolution `2k`, quality
`high`, `background: transparent`. Each was re-saved here with
`cwebp -q 95 -alpha_q 100 -exact -m 6`. Two takes of each; the cleaner was
kept.

The model returns no fully opaque pixel (the shield is alpha 250-254) and a
faint haze around it. The build fixes both before resizing, the same way
`build-stage-sprites.mjs` cleans the figures.

### crest.webp

> A heraldic shield with a pointed bottom. A thick parchment-cream and gold
> border. Inside, a glowing ember-orange sunset sky fills the top of the
> shield and darkens to deep night indigo at the bottom, and a bold dark
> night-indigo spire tower silhouette rises up the centre of the shield from
> its bottom to a needle-sharp point near the top border, crowned with a
> single small gold flame at its tip. The spire silhouette is solid and
> simple, with one lit golden window. Drawn as a clean, finished 2D game
> illustration: an app icon emblem for a dark-fantasy card game companion
> app. It must stay readable when shrunk to a 16-pixel browser favicon: one
> bold central shape, strong contrast between the spire and what is behind
> it, a few large simple shapes, no fine filigree, no tiny details, no thin
> lines. Perfectly symmetrical and centered, seen straight from the front,
> filling the square canvas with only a small even margin. Style: crisp
> hand-inked cel-shaded game art. Confident dark navy ink outlines, thicker
> on the outer silhouette and thinner inside. Flat colour fills with two or
> three clean shading tones per material and one soft cool rim light from the
> left. Smooth clean shapes: no brush texture, no noise, no posterization
> blotches, no smudges. Palette: deep night indigo, dark navy ink, warm
> parchment cream, burnished gold, glowing ember orange. Isolated on a fully
> transparent background: no ground, no cast shadow, no glow halo outside the
> emblem, no text, no letters.

Higgsfield job `970a84c5-953b-4f45-98fa-574cfccffbe1`.

### crest-small.webp

The full crest's job as the reference image, then:

> Redraw the emblem in the reference image as a simplified small-size version
> for a 16-pixel browser favicon, keeping the same design, colours and inked
> style so it reads as the same emblem: make the dark night-indigo spire
> silhouette about three times wider at its base, a bold solid pointed tower
> that fills most of the shield's height; replace the clouds with a plain
> glowing ember-orange top that darkens to deep indigo at the bottom; make
> the gold-and-cream border thicker; make the gold flame at the spire's tip
> bigger and brighter; keep one lit golden window. Very few large flat
> shapes, strong contrast, no thin lines, no small details. Perfectly
> symmetrical and centered, filling the whole square canvas. Isolated on a
> fully transparent background: no glow halo, no shadow, no text.

Higgsfield job `13acde16-1bfa-421e-bb97-841f6e69b0f7`.

## The 16 and 32px favicons

A plain resize of the small cut leaves the edge soft, and its cream border
disappears on a white tab. So the build fits both sizes to the pixel grid:

- every pixel at least half opaque becomes solid;
- a 1px ink ring is added outside the shape, the app's own outline.

The 16px keeps the full 16 rows, so the window and the spire keep their
pixels; its ring only fits on the sides. The 32px is drawn 30 tall, with the
ring all round. Check any change with a pixel-doubled view on a dark
(`#3b3550`) and a white tab colour.
