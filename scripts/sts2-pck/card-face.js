/* eslint-env browser */
/**
 * Page-side half of scripts/build-card-faces.mjs.
 *
 * Loaded into a blank Chromium page and exposed as `window.CardFace`. Draws a
 * card face the way the game's own card scene (scenes/cards/card.tscn) lays it
 * out, from the game's own textures, colour materials and fonts, then shrinks
 * it to the 205x256 framing of the card renders the app already ships.
 *
 * Coordinates below are the scene's, in its units: the card is 300x422 with
 * its origin at the centre. The shipped renders frame the region x -185..185,
 * y -231..231 (room for the cost orb that pokes out of the top-left corner),
 * scaled to 205x256 — measured from the renders, whose frame spans x 20..184
 * and y 11..244 with the scene's drop shadow 12 units down-right.
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
    portraitBorder: [-137.5, -164, 275, 210],
    banner: [-163, -207, 327, 83],
    title: [-105, -204, 210, 54],
    plaque: [-30.5, 1, 61, 37],
    typeLabel: [-22, -14, 44, 28], // relative to the plaque's centre
  });

  const TITLE = Object.freeze({
    maxSize: 26,
    minSize: 12,
    color: "rgb(255,246,226)", // Color(1, 0.964706, 0.886275)
    outline: "rgb(77,75,64)", // Color(0.301961, 0.294118, 0.25098)
    // Upgraded titles turn green in-game (set by code, not the scene); sampled
    // from the shipped "+" renders (Strike+, Afterlife+).
    upgradedColor: "rgb(140,236,88)",
    upgradedOutline: "rgb(12,96,0)",
    // The scene says outline_size 12 for outline and shadow. A canvas stroke of
    // 6 (3 units outside the glyph) and a 3-unit upward shift reproduce the
    // shipped renders best (title-band error 14.4/255 vs 22.4 for 12 and no shift,
    // fitted over Strike, Strike (Silent), Afterlife, Defragment and Comet).
    outlineSize: 6,
    glyphSpacing: 1, // FontVariation_2eadq spacing_glyph = 1
    baselineShift: -3,
    shadow: "rgba(0,0,0,0.188)",
    shadowOffset: 2,
  });
  const TYPE_LABEL = Object.freeze({ size: 16, color: "rgba(0,0,0,0.753)" });
  const SHADOW_ALPHA = 0.251; // Shadow node modulate Color(0, 0, 0, 0.25098)

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

  /**
   * shaders/hsv.gdshader, ported: rotate hue and scale saturation in YIQ space,
   * scale value, back to RGB. Applied to raw sRGB values, as Godot's 2D renderer does.
   */
  function hsvShift(image, { h, s, v }) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
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
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
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

  /** Godot Label, horizontally and vertically centred in its rect, shrunk to fit like MegaLabel. */
  function fitFont(ctx, text, family, maxSize, minSize, maxWidth) {
    let size = maxSize;
    for (; size > minSize; size -= 0.5) {
      ctx.font = `${size}px "${family}"`;
      if (ctx.measureText(text).width <= maxWidth) break;
    }
    ctx.font = `${size}px "${family}"`;
    return size;
  }

  function centredBaseline(ctx, [, y, , h]) {
    const m = ctx.measureText("Hg");
    return y + h / 2 + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
  }

  function drawTitle(ctx, text, upgraded, fonts) {
    const rect = LAYOUT.title;
    const [x, , w] = rect;
    ctx.save();
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.letterSpacing = `${TITLE.glyphSpacing}px`;
    fitFont(ctx, text, fonts.title, TITLE.maxSize, TITLE.minSize, w);
    const cx = x + w / 2;
    const baseline = centredBaseline(ctx, rect) + TITLE.baselineShift;
    const o = TITLE.shadowOffset;
    ctx.lineWidth = TITLE.outlineSize;
    ctx.strokeStyle = TITLE.shadow;
    ctx.fillStyle = TITLE.shadow;
    ctx.strokeText(text, cx + o, baseline + o);
    ctx.fillText(text, cx + o, baseline + o);
    ctx.strokeStyle = upgraded ? TITLE.upgradedOutline : TITLE.outline;
    ctx.strokeText(text, cx, baseline);
    ctx.fillStyle = upgraded ? TITLE.upgradedColor : TITLE.color;
    ctx.fillText(text, cx, baseline);
    ctx.restore();
  }

  function drawTypeLabel(ctx, text, fonts) {
    const [px, py, pw, ph] = LAYOUT.plaque;
    const [lx, ly, lw, lh] = LAYOUT.typeLabel;
    const rect = [px + pw / 2 + lx, py + ph / 2 + ly, lw, lh];
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = TYPE_LABEL.color;
    ctx.font = `${TYPE_LABEL.size}px "${fonts.type}"`;
    ctx.fillText(text, rect[0] + rect[2] / 2, centredBaseline(ctx, rect));
    ctx.restore();
  }

  /** The 2x working canvas with the scene's origin moved to the card centre. */
  function workCanvas() {
    const canvas = document.createElement("canvas");
    canvas.width = VIEW.width * WORK_SCALE;
    canvas.height = VIEW.height * WORK_SCALE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(WORK_SCALE, 0, 0, WORK_SCALE, -VIEW.left * WORK_SCALE, -VIEW.top * WORK_SCALE);
    return { canvas, ctx };
  }

  function shrink(canvas) {
    const half = document.createElement("canvas");
    half.width = VIEW.width;
    half.height = VIEW.height;
    const hctx = half.getContext("2d");
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(canvas, 0, 0, half.width, half.height);
    const out = document.createElement("canvas");
    out.width = OUT.width;
    out.height = OUT.height;
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

  /**
   * @param {object} spec
   *   title, upgraded, typeLabel (null = no plaque), portrait (data URL),
   *   frame / border (texture data URLs for the card's type), banner, plaque,
   *   frameMaterial / rarityMaterial ({h, s, v} from the game's .tres materials),
   *   fonts ({ titleBase64, typeBase64 }), quality
   * @returns {Promise<string>} base64 webp
   */
  async function render(spec) {
    const fonts = { title: "CardTitle", type: "CardType" };
    await Promise.all([registerFont(fonts.title, spec.fonts.titleBase64), registerFont(fonts.type, spec.fonts.typeBase64)]);
    const [portrait, frame, border, banner, plaque] = await Promise.all([
      loadImage(spec.portrait),
      tint(spec.frame, spec.frameMaterial),
      tint(spec.border, spec.rarityMaterial),
      tint(spec.banner, spec.rarityMaterial),
      tint(spec.plaque, spec.rarityMaterial),
    ]);
    const { canvas, ctx } = workCanvas();
    const draw = (image, [x, y, w, h]) => ctx.drawImage(image, x, y, w, h);
    draw(silhouette(frame, SHADOW_ALPHA), LAYOUT.shadow);
    draw(portrait, LAYOUT.portrait);
    draw(frame, LAYOUT.frame);
    draw(border, LAYOUT.portraitBorder);
    drawCovered(ctx, banner, LAYOUT.banner);
    drawTitle(ctx, spec.title, spec.upgraded, fonts);
    if (spec.typeLabel) {
      draw(plaque, LAYOUT.plaque);
      drawTypeLabel(ctx, spec.typeLabel, fonts);
    }
    return shrink(canvas).toDataURL("image/webp", spec.quality).split(",")[1];
  }

  window.CardFace = { render };
})();
