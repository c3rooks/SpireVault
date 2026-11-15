/* eslint-env browser */
/**
 * Page-side half of scripts/build-card-faces.mjs.
 *
 * Loaded into a blank Chromium page and exposed as `window.CardFace`. Draws a
 * whole card the way the game's card scene (scenes/cards/card.tscn, driven by
 * NCard in sts2.dll) lays it out, from the game's own textures, colour
 * materials and fonts, then shrinks it to the 205x256 framing of the card
 * renders the app already ships.
 *
 * Coordinates below are the scene's, in its units: the card is 300x422 with
 * its origin at the centre. The shipped renders frame the region x -185..185,
 * y -231..231 (room for the cost orb that pokes out of the top-left corner),
 * scaled to 205x256.
 */
(function () {
  "use strict";

  const VIEW = Object.freeze({ left: -185, top: -231, width: 370, height: 462 });
  const OUT = Object.freeze({ width: 205, height: 256 });
  const WORK_SCALE = 2; // draw at 2x the scene units, then shrink once

  /** Node rects from card.tscn: [left, top, width, height]. */
  const LAYOUT = Object.freeze({
    shadow: [-138, -199, 300, 422],
    portrait: [-125, -168, 250, 190],
    frame: [-150, -211, 300, 422],
    description: [-122, 37, 243, 136],
    portraitBorder: [-137.5, -164, 275, 210],
    banner: [-163, -207, 327, 83],
    title: [-105, -204, 210, 54],
    plaque: [-30.5, 1, 61, 37],
    typeLabel: [-22, -14, 44, 28], // relative to the plaque's centre
    energyIcon: [-166, -227, 64, 64],
    energyLabel: [-23, -26, 46, 56], // relative to the icon's centre
    starIcon: [-186, -189, 58, 58],
    starLabel: [-14, -20, 28, 40], // relative to the icon's centre
    // Ancient cards (rarity Ancient): full-art portrait and their own border.
    ancientPortrait: [-153, -215, 299, 421], // 598x842 at scale 0.5
    ancientBorder: [-154, -223, 306, 440],
    ancientTextBg: [-133, -22, 264, 203],
    ancientFlame: [2, -212], // AncientBanner's Fire sprite: banner origin + (165, -5), centred, scale 0.6
  });

  const COLOR = Object.freeze({
    cream: "#FFF6E2", // StsColors.cream
    gold: "#EFC851", // StsColors.gold ([gold])
    green: "#7FFF00", // StsColors.green ([green], upgraded title and cost)
    purple: "#EE82EE",
    blue: "#87CEEB",
    energyGreenOutline: "#1F5923",
    titleShadow: "rgba(0,0,0,0.188)",
    textShadow: "rgba(0,0,0,0.251)",
    typeLabel: "rgba(0,0,0,0.753)",
  });

  const TITLE = Object.freeze({
    maxSize: 26,
    minSize: 12,
    // The scene says outline_size 12. A canvas stroke of 6 (3 units outside the
    // glyph) and a 3-unit upward shift reproduce the shipped renders best.
    outlineSize: 6,
    glyphSpacing: 1, // FontVariation_2eadq spacing_glyph = 1
    baselineShift: -3,
    shadowOffset: 2,
  });
  /**
   * DescriptionLabel. Line boxes come from Kreon's metrics: a wrapped line is
   * the hhea box (ascent + descent), a line that ends at a hard "\n" (Godot
   * makes each one its own paragraph) is the taller OS/2 win box. With the
   * label's line_separation of -3 this puts every line of 22 shipped renders
   * (84 lines) within 0.4 px rms of where the game put it (--calibrate).
   */
  const DESCRIPTION = Object.freeze({ maxSize: 21, minSize: 12, lineSeparation: -3, shadowOffset: 2, imageSize: 24, imageShift: 0 });
  const ENERGY = Object.freeze({ maxSize: 32, minSize: 22, outlineSize: 8, shadowOffset: 2 });
  const STAR = Object.freeze({ maxSize: 22, minSize: 16, outlineSize: 6, shadowOffset: 2, outline: "rgba(23,85,97,0.863)" });
  const TYPE_LABEL = Object.freeze({ size: 16 });
  const SHADOW_ALPHA = 0.251; // Shadow node modulate Color(0, 0, 0, 0.25098)
  const ANCIENT = Object.freeze({
    borderModulate: [1, 0.9776916, 0.9058309, 0.502],
    textBgAlpha: 0.66,
    maskRegion: [408, 574],
    maskOffset: [7, 5],
    glassRect: [0.01517, 0.01019, 0.98751, 0.98814],
    glassAdd: 0.15,
    glassCornerWeight: 0.2,
    glassBlur: 6,
  });

  const FONT = Object.freeze({ title: "CardTitle", bold: "CardBold", body: "CardBody" });

  /** Kreon's vertical metrics as fractions of the font size: { ascent, descent, winAscent, winDescent }. */
  let metrics = null;
  /** Calibration overrides for DESCRIPTION (build-card-faces --calibrate only). */
  let tuning = {};

  const loaded = new Map();
  function loadImage(url) {
    if (!loaded.has(url)) {
      loaded.set(url, new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("image failed to decode"));
        image.src = url;
      }));
    }
    return loaded.get(url);
  }

  function canvasOf(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * shaders/hsv.gdshader, ported: rotate hue and scale saturation in YIQ space,
   * scale value, back to RGB. Applied to raw sRGB values, as Godot's 2D renderer does.
   */
  function hsvShift(image, { h, s, v }) {
    const canvas = canvasOf(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    const hue = (1 - h) * Math.PI * 2;
    const cos = Math.cos(hue);
    const sin = Math.sin(hue);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const y = 0.2989 * r + 0.587 * g + 0.114 * b;
      const iq = 0.5959 * r - 0.2774 * g - 0.3216 * b;
      const q = 0.2115 * r - 0.5229 * g + 0.3114 * b;
      // `col.rgb *= hue_shift` multiplies the row vector, i.e. by the transpose.
      const i2 = (cos * iq - sin * q) * s * v;
      const q2 = (sin * iq + cos * q) * s * v;
      const y2 = y * v;
      px[i] = Math.round(255 * (y2 + 0.956 * i2 + 0.6210 * q2));
      px[i + 1] = Math.round(255 * (y2 - 0.2721 * i2 - 0.6474 * q2));
      px[i + 2] = Math.round(255 * (y2 - 1.1070 * i2 + 1.7046 * q2));
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  }

  const tinted = new Map();
  async function tint(url, material) {
    const key = `${url.length}:${url.slice(-64)}|${material.h},${material.s},${material.v}`;
    if (!tinted.has(key)) tinted.set(key, hsvShift(await loadImage(url), material));
    return tinted.get(key);
  }

  function silhouette(source, alpha) {
    const canvas = canvasOf(source.width, source.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** Godot TextureRect stretch_mode 6 (keep aspect, covered): fill the rect, crop the overflow. */
  function drawCovered(ctx, source, [x, y, w, h]) {
    const scale = Math.max(w / source.width, h / source.height);
    const sw = w / scale;
    const sh = h / scale;
    ctx.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, x, y, w, h);
  }

  /** Godot TextureRect stretch_mode 5 (keep aspect, centred). */
  function drawCentred(ctx, source, [x, y, w, h]) {
    const scale = Math.min(w / source.width, h / source.height);
    const dw = source.width * scale;
    const dh = source.height * scale;
    ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /** NinePatchRect with only horizontal margins (the type plaque). */
  function drawThreeSlice(ctx, source, [x, y, w, h], left, right) {
    const sh = source.height;
    const mid = source.width - left - right;
    ctx.drawImage(source, 0, 0, left, sh, x, y, left, h);
    ctx.drawImage(source, left, 0, mid, sh, x + left, y, w - left - right, h);
    ctx.drawImage(source, source.width - right, 0, right, sh, x + w - right, y, right, h);
  }

  /**
   * Baseline of one line vertically centred in a rect. Godot's line box is the
   * font's ascent + descent; Kreon's (OS/2 winAscent/winDescent, passed in as
   * fractions of the font size) is taller than the hhea box canvas reports.
   * Without metrics, the canvas box is used (the title is calibrated on it).
   */
  function centredBaseline(ctx, [, y, , h], size = 0) {
    if (size && metrics) return y + h / 2 + ((metrics.winAscent - metrics.winDescent) * size) / 2;
    const m = ctx.measureText("Hg");
    return y + h / 2 + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
  }

  /** Godot Label, centred in its rect, shrunk until it fits like MegaLabel. */
  function fitFont(ctx, text, family, maxSize, minSize, maxWidth) {
    let size = maxSize;
    for (; size > minSize; size -= 0.5) {
      ctx.font = `${size}px "${family}"`;
      if (ctx.measureText(text).width <= maxWidth) break;
    }
    ctx.font = `${size}px "${family}"`;
    return size;
  }

  /** A label with outline and drop shadow (title, energy cost, star cost). */
  function drawOutlinedLabel(ctx, text, rect, { family, maxSize, minSize, color, outline, outlineSize, shadowOffset, shadow, spacing = 0, shift = 0, godotBox = true }) {
    const [x, , w] = rect;
    ctx.save();
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.letterSpacing = `${spacing}px`;
    const size = fitFont(ctx, text, family, maxSize, minSize, w);
    const cx = x + w / 2;
    const baseline = centredBaseline(ctx, rect, godotBox ? size : 0) + shift;
    ctx.lineWidth = outlineSize;
    ctx.strokeStyle = shadow;
    ctx.fillStyle = shadow;
    ctx.strokeText(text, cx + shadowOffset, baseline + shadowOffset);
    ctx.fillText(text, cx + shadowOffset, baseline + shadowOffset);
    ctx.strokeStyle = outline;
    ctx.strokeText(text, cx, baseline);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, baseline);
    ctx.restore();
  }

  function drawTypePlaque(ctx, plaque, text) {
    ctx.save();
    ctx.font = `${TYPE_LABEL.size}px "${FONT.bold}"`;
    const [px, py, pw, ph] = LAYOUT.plaque;
    const [, ly, lw, lh] = LAYOUT.typeLabel;
    // NCard.UpdateTypePlaqueSizeAndPosition: width = max(label width + 17, 61), kept centred.
    const labelWidth = Math.max(lw, ctx.measureText(text).width);
    const width = Math.max(labelWidth + 17, 61);
    const centre = px + pw / 2;
    drawThreeSlice(ctx, plaque, [centre - width / 2, py, width, ph], 13, 12);
    ctx.textAlign = "center";
    ctx.fillStyle = COLOR.typeLabel;
    ctx.fillText(text, centre, centredBaseline(ctx, [0, py + ph / 2 + ly, 0, lh], TYPE_LABEL.size));
    ctx.restore();
  }

  /* --------------------------------------------------- rules text --- */

  /**
   * The description's BBCode -> lines of styled runs. Handles the tags the
   * game's card text uses: [gold] [green] [purple] [blue] [img].
   * Colour rule (RichTextGold keeps green): green beats gold beats default.
   */
  function parseBbcode(bbcode) {
    const lines = [[]];
    const stack = [];
    const colour = () => {
      if (stack.includes("green")) return COLOR.green;
      if (stack.includes("gold")) return COLOR.gold;
      if (stack.includes("purple")) return COLOR.purple;
      if (stack.includes("blue")) return COLOR.blue;
      return COLOR.cream;
    };
    const pattern = /\[img\]([^[]*)\[\/img\]|\[(\/?)([a-z]+)\]|\n|[^[\n]+|\[/g;
    for (const m of bbcode.matchAll(pattern)) {
      if (m[1] !== undefined) lines[lines.length - 1].push({ image: m[1] });
      else if (m[3]) {
        if (m[2]) stack.splice(stack.lastIndexOf(m[3]), 1);
        else stack.push(m[3]);
      } else if (m[0] === "\n") lines.push([]);
      else lines[lines.length - 1].push({ text: m[0], color: colour() });
    }
    return lines;
  }

  /** Splits a hard line's runs into words (runs between spaces); spaces separate words. */
  function wordsOf(runs) {
    const words = [];
    let current = [];
    let leadingSpace = false;
    const flush = (spaceAfter) => {
      if (current.length) words.push({ parts: current, spaceBefore: leadingSpace });
      current = [];
      leadingSpace = spaceAfter;
    };
    for (const run of runs) {
      if (run.image) {
        current.push(run);
        continue;
      }
      const pieces = run.text.split(" ");
      pieces.forEach((piece, i) => {
        if (i > 0) flush(true);
        if (piece) current.push({ text: piece, color: run.color });
      });
    }
    flush(false);
    return words;
  }

  function measureWord(ctx, word) {
    return word.parts.reduce((w, p) => w + (p.image ? DESCRIPTION.imageSize : ctx.measureText(p.text).width), 0);
  }

  /** Greedy word wrap at a font size; returns lines of words and the block height. */
  function layoutText(ctx, hardLines, size, maxWidth) {
    ctx.font = `${size}px "${FONT.body}"`;
    const space = ctx.measureText(" ").width;
    const t = {
      ...DESCRIPTION,
      lineBox: metrics.ascent + metrics.descent,
      ascentShare: metrics.ascent / (metrics.ascent + metrics.descent),
      breakExtra: metrics.winAscent + metrics.winDescent - metrics.ascent - metrics.descent,
      ...tuning,
    };
    const box = Math.max(t.lineBox * size, DESCRIPTION.imageSize);
    const ascent = box * t.ascentShare;
    const lines = [];
    let tooWide = false;
    for (const [index, runs] of hardLines.entries()) {
      const words = wordsOf(runs);
      let line = { words: [], width: 0, leading: 0, extra: 0 };
      // A leading space in the source (e.g. "\n Gain") is kept, as Godot keeps it.
      if (words[0]?.spaceBefore) line.leading = space;
      line.width = line.leading;
      for (const word of words) {
        const w = measureWord(ctx, word);
        if (w > maxWidth) tooWide = true;
        const gap = line.words.length ? space : 0;
        if (line.words.length && line.width + gap + w > maxWidth) {
          lines.push(line);
          line = { words: [], width: 0, leading: 0, extra: 0 };
        }
        line.width += (line.words.length ? space : 0) + w;
        line.words.push({ word, width: w });
      }
      // A line that ends at a hard break sits further from the next one (measured, see DESCRIPTION).
      line.extra = index < hardLines.length - 1 ? t.breakExtra * size : 0;
      lines.push(line);
    }
    const height = lines.reduce((sum, l) => sum + box + l.extra, 0) + Math.max(0, lines.length - 1) * t.lineSeparation;
    return { lines, height, box, ascent, space, tooWide, separation: t.lineSeparation };
  }

  /** MegaRichTextLabel: the largest font size from 21 down to 12 whose text fits the box. */
  function fitText(ctx, hardLines, [, , w, h]) {
    let best = null;
    for (let size = DESCRIPTION.maxSize; size >= DESCRIPTION.minSize; size--) {
      best = { size, ...layoutText(ctx, hardLines, size, w) };
      if (!best.tooWide && best.height <= h) break;
    }
    return best;
  }

  function drawDescription(ctx, bbcode, icons) {
    if (!bbcode) return;
    const rect = LAYOUT.description;
    const [x, y, w, h] = rect;
    const layout = fitText(ctx, parseBbcode(bbcode), rect);
    ctx.save();
    ctx.font = `${layout.size}px "${FONT.body}"`;
    ctx.textBaseline = "alphabetic";
    let top = y + (h - layout.height) / 2;
    for (const line of layout.lines) {
      let cursor = x + (w - line.width) / 2 + line.leading;
      const baseline = top + layout.ascent;
      const middle = top + layout.box / 2 + (tuning.imageShift ?? DESCRIPTION.imageShift) * layout.box;
      line.words.forEach(({ word }, i) => {
        if (i > 0) cursor += layout.space;
        for (const part of word.parts) {
          if (part.image) {
            const image = icons[part.image];
            if (!image) throw new Error(`no icon for ${part.image}`);
            const s = DESCRIPTION.imageSize;
            ctx.drawImage(image, cursor, middle - s / 2, s, s);
            cursor += s;
            continue;
          }
          const o = DESCRIPTION.shadowOffset;
          ctx.fillStyle = COLOR.textShadow;
          ctx.fillText(part.text, cursor + o, baseline + o);
          ctx.fillStyle = part.color;
          ctx.fillText(part.text, cursor, baseline);
          cursor += ctx.measureText(part.text).width;
        }
      });
      top += layout.box + line.extra + layout.separation;
    }
    ctx.restore();
  }

  /* --------------------------------------------------- ancient cards --- */

  /** PortraitCanvasGroup with card_canvas_group_mask_material: rounded mask plus the glass border. */
  function ancientPortrait(portrait, mask, glass) {
    const [, , w, h] = LAYOUT.ancientPortrait;
    const scale = 2;
    const W = w * scale;
    const H = h * scale;
    const art = canvasOf(W, H);
    art.getContext("2d").drawImage(portrait, 0, 0, W, H);
    const blurred = canvasOf(W, H);
    const bctx = blurred.getContext("2d");
    bctx.filter = `blur(${(ANCIENT.glassBlur * W) / 598 / 2}px)`;
    bctx.drawImage(art, 0, 0);
    const maskCanvas = canvasOf(mask.width, mask.height);
    maskCanvas.getContext("2d").drawImage(mask, 0, 0);
    const maskData = maskCanvas.getContext("2d").getImageData(0, 0, mask.width, mask.height).data;
    const glassCanvas = canvasOf(glass.width, glass.height);
    glassCanvas.getContext("2d").drawImage(glass, 0, 0);
    const glassData = glassCanvas.getContext("2d").getImageData(0, 0, glass.width, glass.height).data;
    const actx = art.getContext("2d");
    const out = actx.getImageData(0, 0, W, H);
    const blur = bctx.getImageData(0, 0, W, H).data;
    const px = out.data;
    const [mw, mh] = ANCIENT.maskRegion;
    const [mox, moy] = ANCIENT.maskOffset;
    const [gx, gy, gw, gh] = ANCIENT.glassRect;
    for (let j = 0; j < H; j++) {
      const v = (j + 0.5) / H;
      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W;
        const k = (j * W + i) * 4;
        // mask: group UV -> mask region (offset by mask_offset), the png has a 1px border
        const mx = Math.min(mw, Math.max(0, u * (mw + mox) - mox)) + 1;
        const my = Math.min(mh, Math.max(0, v * (mh + moy) - moy)) + 1;
        const ma = maskData[(Math.min(mask.height - 1, Math.floor(my)) * mask.width + Math.min(mask.width - 1, Math.floor(mx))) * 4 + 3] / 255;
        px[k + 3] = Math.round(px[k + 3] * ma);
        // glass: R/A = border band, G = corner highlight
        const tu = (u - gx) / gw;
        const tv = (v - gy) / gh;
        if (tu < 0 || tu > 1 || tv < 0 || tv > 1) continue;
        const gk = (Math.min(glass.height - 1, Math.floor(tv * glass.height)) * glass.width + Math.min(glass.width - 1, Math.floor(tu * glass.width))) * 4;
        const ga = glassData[gk + 3] / 255;
        if (ga === 0) continue;
        const corner = (glassData[gk + 1] / 255) * ANCIENT.glassCornerWeight;
        for (let c = 0; c < 3; c++) {
          const behind = blur[k + c] / 255 + ANCIENT.glassAdd;
          const glassRgb = (behind * (1 - corner) + corner) * ga;
          const glassA = ga; // mix(g.a, corner alpha 1, cornerMix) * g.a, with corner alpha 1
          px[k + c] = Math.round(255 * Math.min(1, (px[k + c] / 255) * (1 - glassA) + glassRgb * glassA));
        }
      }
    }
    actx.putImageData(out, 0, 0);
    return art;
  }

  function drawAncientBorder(ctx, border) {
    const [r, g, b, a] = ANCIENT.borderModulate;
    const tintCanvas = canvasOf(border.width, border.height);
    const tctx = tintCanvas.getContext("2d");
    tctx.drawImage(border, 0, 0);
    tctx.globalCompositeOperation = "multiply";
    tctx.fillStyle = `rgb(${255 * r},${255 * g},${255 * b})`;
    tctx.fillRect(0, 0, border.width, border.height);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(border, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = "lighter"; // CanvasItemMaterial blend_mode 1 (add)
    ctx.globalAlpha = a;
    drawCentred(ctx, tintCanvas, LAYOUT.ancientBorder);
    ctx.restore();
  }

  /* ----------------------------------------------------------- canvas --- */

  /** The 2x working canvas with the scene's origin moved to the card centre. */
  function workCanvas() {
    const canvas = canvasOf(VIEW.width * WORK_SCALE, VIEW.height * WORK_SCALE);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(WORK_SCALE, 0, 0, WORK_SCALE, -VIEW.left * WORK_SCALE, -VIEW.top * WORK_SCALE);
    return { canvas, ctx };
  }

  /**
   * The working canvas at the output size. `scale` 1 is the shipped 205x256
   * framing (in two steps, as those renders were made); a larger scale goes
   * straight from the working canvas, which is still bigger than the output
   * up to scale 3.
   */
  function shrink(canvas, scale = 1) {
    if (scale !== 1) {
      const large = canvasOf(Math.round(OUT.width * scale), Math.round(OUT.height * scale));
      const lctx = large.getContext("2d");
      lctx.imageSmoothingQuality = "high";
      lctx.drawImage(canvas, 0, 0, large.width, large.height);
      return large;
    }
    const half = canvasOf(VIEW.width, VIEW.height);
    const hctx = half.getContext("2d");
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(canvas, 0, 0, half.width, half.height);
    const out = canvasOf(OUT.width, OUT.height);
    const octx = out.getContext("2d");
    octx.imageSmoothingQuality = "high";
    octx.drawImage(half, 0, 0, OUT.width, OUT.height);
    return out;
  }

  const fontsReady = new Map();
  async function registerFont(family, base64) {
    if (!fontsReady.has(family)) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const face = new FontFace(family, bytes.buffer);
      fontsReady.set(family, face.load().then((f) => document.fonts.add(f)));
    }
    return fontsReady.get(family);
  }

  async function loadIcons(map) {
    const entries = await Promise.all(Object.entries(map ?? {}).map(async ([key, url]) => [key, await loadImage(url)]));
    return Object.fromEntries(entries);
  }

  /**
   * @param {object} spec
   *   title, titleColor, titleOutline, typeLabel (null = no plaque), ancient,
   *   portrait, frame, border, banner, plaque (data URLs), frameMaterial, bannerMaterial,
   *   ancientAssets { border, textBg, banner, flame, mask, glass } for ancient cards,
   *   cost { text, color, outline, icon } | null, star { text, color, outline, icon } | null,
   *   description (BBCode), icons { "res://...png": data URL },
   *   fonts { titleBase64, boldBase64, bodyBase64 }, metrics { ascent, descent, winAscent, winDescent } (Kreon, per unit of size), quality,
   *   scale (output size as a multiple of 205x256; default 1)
   * @returns {Promise<string>} base64 webp
   */
  async function render(spec) {
    metrics = spec.metrics;
    tuning = spec.tuning ?? {};
    await Promise.all([
      registerFont(FONT.title, spec.fonts.titleBase64),
      registerFont(FONT.bold, spec.fonts.boldBase64),
      registerFont(FONT.body, spec.fonts.bodyBase64),
    ]);
    const [portrait, frame, border, banner, plaque, icons] = await Promise.all([
      loadImage(spec.portrait),
      tint(spec.frame, spec.frameMaterial),
      tint(spec.border, spec.bannerMaterial),
      tint(spec.banner, spec.bannerMaterial),
      tint(spec.plaque, spec.bannerMaterial),
      loadIcons(spec.icons),
    ]);
    const { canvas, ctx } = workCanvas();
    const draw = (image, [x, y, w, h]) => ctx.drawImage(image, x, y, w, h);
    draw(silhouette(frame, SHADOW_ALPHA), LAYOUT.shadow);
    if (spec.ancient) {
      const a = spec.ancientAssets;
      const [mask, glass, ancientBorder, textBg, ancientBanner, flame] = await Promise.all([a.mask, a.glass, a.border, a.textBg, a.banner, a.flame].map(loadImage));
      draw(ancientPortrait(portrait, mask, glass), LAYOUT.ancientPortrait);
      drawAncientBorder(ctx, ancientBorder);
      ctx.save();
      ctx.globalAlpha = ANCIENT.textBgAlpha;
      drawCentred(ctx, silhouette(textBg, 1), LAYOUT.ancientTextBg);
      ctx.restore();
      drawDescription(ctx, spec.description, icons);
      drawCovered(ctx, ancientBanner, LAYOUT.banner);
      const [fx, fy] = LAYOUT.ancientFlame;
      ctx.drawImage(flame, fx - (flame.width * 0.6) / 2, fy - (flame.height * 0.6) / 2, flame.width * 0.6, flame.height * 0.6);
    } else {
      draw(portrait, LAYOUT.portrait);
      draw(frame, LAYOUT.frame);
      drawDescription(ctx, spec.description, icons);
      draw(border, LAYOUT.portraitBorder);
      drawCovered(ctx, banner, LAYOUT.banner);
    }
    drawOutlinedLabel(ctx, spec.title, LAYOUT.title, {
      family: FONT.title, maxSize: TITLE.maxSize, minSize: TITLE.minSize, color: spec.titleColor, outline: spec.titleOutline,
      outlineSize: TITLE.outlineSize, shadowOffset: TITLE.shadowOffset, shadow: COLOR.titleShadow, spacing: TITLE.glyphSpacing, shift: TITLE.baselineShift,
      godotBox: false,
    });
    if (spec.typeLabel) drawTypePlaque(ctx, plaque, spec.typeLabel);
    if (spec.cost) {
      const icon = await loadImage(spec.cost.icon);
      drawCentred(ctx, icon, LAYOUT.energyIcon);
      const [ix, iy, iw, ih] = LAYOUT.energyIcon;
      const [lx, ly, lw, lh] = LAYOUT.energyLabel;
      drawOutlinedLabel(ctx, spec.cost.text, [ix + iw / 2 + lx, iy + ih / 2 + ly, lw, lh], {
        family: FONT.bold, maxSize: ENERGY.maxSize, minSize: ENERGY.minSize, color: spec.cost.color, outline: spec.cost.outline,
        outlineSize: ENERGY.outlineSize, shadowOffset: ENERGY.shadowOffset, shadow: COLOR.titleShadow,
      });
    }
    if (spec.star) {
      const icon = await loadImage(spec.star.icon);
      drawCentred(ctx, icon, LAYOUT.starIcon);
      const [ix, iy, iw, ih] = LAYOUT.starIcon;
      const [lx, ly, lw, lh] = LAYOUT.starLabel;
      drawOutlinedLabel(ctx, spec.star.text, [ix + iw / 2 + lx, iy + ih / 2 + ly, lw, lh], {
        family: FONT.bold, maxSize: STAR.maxSize, minSize: STAR.minSize, color: spec.star.color, outline: spec.star.outline ?? STAR.outline,
        outlineSize: STAR.outlineSize, shadowOffset: STAR.shadowOffset, shadow: COLOR.titleShadow,
      });
    }
    return shrink(canvas, spec.scale ?? 1).toDataURL("image/webp", spec.quality).split(",")[1];
  }

  window.CardFace = { render, COLOR };
})();
