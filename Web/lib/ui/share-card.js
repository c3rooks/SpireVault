// The share card in the new look: the image a player downloads or pastes
// into Discord, Reddit or X.
//
// It is the app's own header in miniature, on one compact card: the climber
// stands in one of the game's rooms with the result stamped beside them, and
// below the ledge, on paper, lie the run's relics and a hand of its real
// cards. 1200 x 630 (the wide social-card shape), drawn at 2x.
//
// Canvas only: no DOM besides the canvas it is handed. Colours come from the
// active theme's tokens (readSharePalette), so the card matches what the
// player sees around it. script.js builds the model from the run and loads
// the images; the classic layout keeps its own card and never loads this.

import { STAGE_ACTOR_ART } from "./stage-actors.js?v=1";
import { STAGE_BACKDROPS } from "./stage-backdrops.js?v=1";

/** Logical size, and the pixel scale the canvas is drawn at. */
export const SHARE_CARD_SIZE = Object.freeze({ width: 1200, height: 630, scale: 2 });

/** How many relic tokens and card faces fit before "+N". */
export const SHARE_CARD_LIMITS = Object.freeze({ relics: 14, cards: 8 });

const W = SHARE_CARD_SIZE.width;
const H = SHARE_CARD_SIZE.height;
const RADIUS = 28;
const FRAME = 6;
const MARGIN = 44;
/** The room band's height: the ledge the climber stands on. */
const BAND_H = 240;
/** Hard shadow offset, the UI's own. */
const SHADOW = 4;

const FONT_DISPLAY = '"Grenze Gotisch", "Figtree", Georgia, serif';
/** For capitals: the display face's blackletter capitals are hard to read in a row. */
const FONT_HEADING = '"Grenze", "Grenze Gotisch", Georgia, serif';
const FONT_TEXT = '"Figtree", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** The header ledge's own profile (stage.js), as fractions: x of the width, y in px. */
const LEDGE = Object.freeze([
  [0, 6], [0.067, 2], [0.158, 7], [0.25, 0], [0.358, 6], [0.467, 1], [0.575, 7], [0.683, 0], [0.792, 6], [0.9, 1], [1, 5],
]);

/**
 * @typedef {Object} ShareCardModel
 * @property {string} characterKey   "ironclad", "silent", …
 * @property {string} characterName
 * @property {string} characterColor  hex
 * @property {"win" | "loss" | "unknown"} outcome
 * @property {ReadonlyArray<{ label: string, value: string }>} facts  chips, in order
 * @property {ReadonlyArray<{ id: string, label: string, src: string | null }>} relics  up to SHARE_CARD_LIMITS.relics
 * @property {number} relicTotal
 * @property {ReadonlyArray<{ id: string, label: string, src: string | null }>} cards  up to SHARE_CARD_LIMITS.cards
 * @property {number} deckSize   every card in the deck, duplicates included
 * @property {number} cardKinds  different cards in the deck; what "+N more" counts from
 * @property {string} roomKey  anything stable for the run (seed, date); picks the room
 *
 * @typedef {Object} ShareCardImages
 * @property {CanvasImageSource | null} [climber]
 * @property {ReadonlyArray<CanvasImageSource | null>} [planes]  the room, back to front
 * @property {ReadonlyMap<string, CanvasImageSource>} [relics]   by relic id
 * @property {ReadonlyMap<string, CanvasImageSource>} [cards]    by card id
 */

/**
 * The room for a run: always the same one for the same run, and every place
 * as likely as any other however many takes it has.
 * @param {string} key
 */
function backdropFor(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
  // Keys of neighbouring runs differ by a few characters; mix so they scatter.
  // (Every step ends in >>> 0: a signed result would index before the list.)
  hash = (hash ^ (hash >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  const rooms = [...new Set(STAGE_BACKDROPS.map((backdrop) => backdrop.room))];
  const takes = STAGE_BACKDROPS.filter((backdrop) => backdrop.room === rooms[hash % rooms.length]);
  return takes[(hash >>> 8) % takes.length];
}

/**
 * The art this card wants besides relics and cards: the climber's inked
 * sprite and the room's planes, back to front.
 * @param {ShareCardModel} model
 * @returns {{ climber: string | null, planes: string[] }}
 */
export function shareCardArt(model) {
  const art = STAGE_ACTOR_ART[model.characterKey];
  const { base, mid, front } = backdropFor(model.roomKey || model.characterKey).planes;
  return {
    climber: art && art.kind === "climber" ? art.src : null,
    planes: [base, mid, front].filter(Boolean),
  };
}

/**
 * Loads the faces the card is set in. Text measured before they arrive would
 * be measured in the fallback face.
 * @returns {Promise<void>}
 */
export async function loadShareFonts() {
  if (!document.fonts || !document.fonts.load) return;
  try {
    await Promise.all([
      document.fonts.load(`800 72px ${FONT_DISPLAY}`),
      document.fonts.load(`800 48px ${FONT_HEADING}`),
      document.fonts.load(`700 16px ${FONT_TEXT}`),
      document.fonts.load(`800 16px ${FONT_TEXT}`),
    ]);
  } catch {
    // A missing face only changes the look; the card still draws.
  }
}

/** @type {CanvasRenderingContext2D | null} */
let colourParser = null;

/**
 * A CSS colour as the canvas spells it: "#rrggbb", or "rgba(r, g, b, a)"
 * when it is translucent. A theme may write a token as rgb(), hsl() or
 * color-mix(); a gradient stop throws on a colour the canvas cannot parse,
 * so every token goes through the canvas's own parser first, and one it
 * rejects falls back.
 * @param {string} colour
 * @param {string} fallback  a #rrggbb colour
 */
function canvasColour(colour, fallback) {
  if (!colourParser) colourParser = document.createElement("canvas").getContext("2d");
  if (!colourParser || !colour) return fallback;
  // An unparseable value leaves fillStyle as it was: set a sentinel first.
  colourParser.fillStyle = "#010203";
  colourParser.fillStyle = colour;
  const parsed = String(colourParser.fillStyle);
  if (parsed === "#010203" && colour.trim().toLowerCase() !== "#010203") return fallback;
  return /^#[0-9a-f]{6}$/i.test(parsed) || /^rgba?\(/i.test(parsed) ? parsed : fallback;
}

/**
 * The active theme's colours, read from its tokens.
 * @param {Element} [root]
 */
export function readSharePalette(root = document.documentElement) {
  const style = getComputedStyle(root);
  const token = (name, fallback) => canvasColour(style.getPropertyValue(name).trim(), fallback);
  return Object.freeze({
    ink: token("--v-ink", "#0a0616"),
    paper: token("--v-paper", "#fff1cf"),
    paper2: token("--v-paper-2", "#f1dcae"),
    onPaper: token("--v-on-paper", "#0a0616"),
    onPaper2: token("--v-on-paper-2", "#4d3d6e"),
    title: token("--v-title", "#ffd24a"),
    text: token("--v-text", "#fff1cf"),
    deep: token("--v-bg-deep", "#0f0a22"),
    sky: token("--v-stage-sky-1", "#1a1340"),
    win: token("--v-win", "#57e389"),
    loss: token("--v-loss", "#ff6470"),
  });
}

/** @param {CanvasRenderingContext2D} ctx */
function roundedPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Runs `draw` with the UI's hard offset shadow under whatever it paints. */
function withShadow(ctx, colour, draw, offset = SHADOW) {
  ctx.save();
  ctx.shadowColor = colour;
  ctx.shadowBlur = 0;
  // Canvas shadow offsets ignore the transform, so they are given in pixels.
  ctx.shadowOffsetX = offset * SHARE_CARD_SIZE.scale;
  ctx.shadowOffsetY = offset * SHARE_CARD_SIZE.scale;
  draw();
  ctx.restore();
}

/** An inked box: hard shadow, fill, outline. */
function inkedBox(ctx, palette, x, y, w, h, r, fill, line = 3) {
  withShadow(ctx, palette.ink, () => {
    roundedPath(ctx, x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
  });
  roundedPath(ctx, x, y, w, h, r);
  ctx.lineWidth = line;
  ctx.strokeStyle = palette.ink;
  ctx.stroke();
}

/** Shrinks a font size until `text` fits `maxWidth`. Returns the size used. */
function fitFont(ctx, text, weight, size, family, maxWidth, minSize) {
  let px = size;
  ctx.font = `${weight} ${px}px ${family}`;
  while (px > minSize && ctx.measureText(text).width > maxWidth) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

/** `text`, cut with an ellipsis to fit `maxWidth` in the current font. */
function clipText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// ---- The room band ---------------------------------------------------------------

function drawBand(ctx, palette, model, images) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, BAND_H + 8);
  ctx.clip();

  const sky = ctx.createLinearGradient(0, 0, 0, BAND_H);
  sky.addColorStop(0, palette.deep);
  sky.addColorStop(1, palette.sky);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, BAND_H + 8);

  // The room, laid from the right-hand corner like the header's.
  const planes = (images.planes || []).filter(Boolean);
  for (const plane of planes) {
    const ratio = plane.width / plane.height;
    const height = BAND_H + 8;
    const width = height * ratio;
    ctx.drawImage(plane, W - width, 0, width, height);
  }

  // The veil: darker behind the name, a little everywhere.
  const veil = ctx.createLinearGradient(0, 0, W, 0);
  veil.addColorStop(0, withAlpha(palette.deep, 0.78));
  veil.addColorStop(0.5, withAlpha(palette.deep, 0.42));
  veil.addColorStop(1, withAlpha(palette.deep, 0.16));
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, W, BAND_H + 8);

  // The climber's colour, low in their corner.
  const glow = ctx.createRadialGradient(150, BAND_H, 10, 150, BAND_H, 330);
  glow.addColorStop(0, withAlpha(model.characterColor, 0.42));
  glow.addColorStop(1, withAlpha(model.characterColor, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, BAND_H + 8);
  ctx.restore();
}

/**
 * `colour` at `alpha`, as an rgba() the canvas always accepts. Any CSS
 * colour is fine: it is read through the canvas's parser.
 */
function withAlpha(colour, alpha) {
  const parsed = canvasColour(colour, "#0a0616");
  const hex = /^#([0-9a-f]{6})$/i.exec(parsed);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const parts = /^rgba?\(([^)]+)\)/i.exec(parsed);
  const [r, g, b, a = "1"] = parts ? parts[1].split(",").map((part) => part.trim()) : ["10", "6", "22"];
  return `rgba(${r}, ${g}, ${b}, ${Number(a) * alpha})`;
}

/** The paper below the band, with the header's own ledge as its top edge. */
function drawPaper(ctx, palette) {
  ctx.beginPath();
  ctx.moveTo(0, H);
  LEDGE.forEach(([x, y]) => ctx.lineTo(x * W, BAND_H + y));
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = palette.paper;
  ctx.fill();

  ctx.beginPath();
  LEDGE.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x * W, BAND_H + y) : ctx.lineTo(x * W, BAND_H + y)));
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.strokeStyle = palette.ink;
  ctx.stroke();
}

/** The climber, standing on the ledge. Returns the right edge of what was drawn. */
function drawClimber(ctx, palette, model, images) {
  const feet = BAND_H + 10;
  const art = images.climber && images.climber.width > 0 && images.climber.height > 0 ? images.climber : null;
  if (!art) {
    // No sprite for this character: their initial on a tile in their colour.
    const size = 150;
    const y = feet - size - 8;
    inkedBox(ctx, palette, MARGIN, y, size, size, 22, model.characterColor, 4);
    ctx.fillStyle = palette.ink;
    ctx.font = `800 96px ${FONT_DISPLAY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((model.characterName[0] || "?").toUpperCase(), MARGIN + size / 2, y + size / 2 + 6);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    return MARGIN + size;
  }
  const height = 214;
  const width = Math.min(250, (art.width / art.height) * height);
  const drawnHeight = (width * art.height) / art.width;
  const x = MARGIN + (250 - width) / 2 - 20;
  const y = feet - drawnHeight;

  ctx.fillStyle = withAlpha(palette.ink, 0.55);
  ctx.beginPath();
  ctx.ellipse(x + width / 2, feet - 2, width * 0.42, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  withShadow(ctx, palette.ink, () => ctx.drawImage(art, x, y, width, drawnHeight), 5);
  return x + width;
}

/** The result, stamped at a tilt in the band's far corner. Returns its left edge. */
function drawStamp(ctx, palette, model) {
  const text = model.outcome === "win" ? "VICTORY" : model.outcome === "loss" ? "DEFEAT" : "RUN";
  const fill = model.outcome === "win" ? palette.win : model.outcome === "loss" ? palette.loss : palette.title;
  ctx.font = `800 50px ${FONT_HEADING}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "3px";
  const width = ctx.measureText(text).width + 54;
  const height = 82;
  const centreX = W - MARGIN - width / 2 - 6;
  const centreY = 92;
  ctx.save();
  ctx.translate(centreX, centreY);
  ctx.rotate((-6 * Math.PI) / 180);
  inkedBox(ctx, palette, -width / 2, -height / 2, width, height, 16, fill, 5);
  // A second, inner rule: the stamp's own border.
  roundedPath(ctx, -width / 2 + 9, -height / 2 + 9, width - 18, height - 18, 9);
  ctx.lineWidth = 2;
  ctx.strokeStyle = withAlpha(palette.ink, 0.55);
  ctx.stroke();
  ctx.fillStyle = palette.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 1.5, 3);
  ctx.restore();
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return centreX - width / 2 - 12;
}

/** The climber's name, in the display face, inked. */
function drawName(ctx, palette, model, left, right) {
  const text = model.characterName;
  fitFont(ctx, text, 800, 82, FONT_DISPLAY, right - left, 44);
  const baseline = 112;
  ctx.lineJoin = "round";
  ctx.lineWidth = 12;
  ctx.strokeStyle = palette.ink;
  withShadow(ctx, palette.ink, () => ctx.strokeText(text, left, baseline), 5);
  ctx.fillStyle = palette.title;
  ctx.fillText(text, left, baseline);
}

/** The run's facts as chips: label in the text colour, value in the title colour. */
function drawFacts(ctx, palette, model, left, right) {
  const height = 36;
  // Below the tilted stamp's lowest corner (and its shadow), so a long row
  // of chips never runs over it.
  const top = 150;
  let x = left;
  let y = top;
  for (const fact of model.facts) {
    ctx.font = `700 15px ${FONT_TEXT}`;
    const labelWidth = fact.label ? ctx.measureText(`${fact.label} `).width : 0;
    ctx.font = `800 18px ${FONT_TEXT}`;
    const valueWidth = ctx.measureText(fact.value).width;
    const width = labelWidth + valueWidth + 30;
    if (x + width > right) {
      // One wrap at most: the band has room for two rows of chips.
      if (y !== top) break;
      x = left;
      y = top + height + 8;
    }
    inkedBox(ctx, palette, x, y, width, height, height / 2, palette.deep, 3);
    ctx.textBaseline = "middle";
    if (fact.label) {
      ctx.font = `700 15px ${FONT_TEXT}`;
      ctx.fillStyle = palette.text;
      ctx.fillText(fact.label, x + 15, y + height / 2 + 1);
    }
    ctx.font = `800 18px ${FONT_TEXT}`;
    ctx.fillStyle = palette.title;
    ctx.fillText(fact.value, x + 15 + labelWidth, y + height / 2 + 1);
    ctx.textBaseline = "alphabetic";
    x += width + 10;
  }
}

// ---- The paper: relics, the hand, the maker's mark ----------------------------

function drawLabel(ctx, palette, text, x, baseline) {
  ctx.font = `800 14px ${FONT_TEXT}`;
  ctx.fillStyle = palette.onPaper2;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "1.6px";
  ctx.fillText(text.toUpperCase(), x, baseline);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}

/** Draws `image` to cover the box, centred. */
function drawCover(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.width, h / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, x + (w - width) / 2, y + (h - height) / 2, width, height);
}

function drawRelics(ctx, palette, model, images) {
  const labelBaseline = BAND_H + 42;
  drawLabel(ctx, palette, `Relics · ${model.relicTotal}`, MARGIN, labelBaseline);
  const top = labelBaseline + 12;
  const size = 50;
  const step = 60;
  if (model.relics.length === 0) {
    ctx.font = `600 16px ${FONT_TEXT}`;
    ctx.fillStyle = palette.onPaper2;
    ctx.fillText("None picked up", MARGIN, top + 30);
    return;
  }
  let x = MARGIN;
  for (const relic of model.relics) {
    const centreX = x + size / 2;
    const centreY = top + size / 2;
    withShadow(ctx, palette.ink, () => {
      ctx.beginPath();
      ctx.arc(centreX, centreY, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = palette.paper2;
      ctx.fill();
    }, 3);
    const image = images.relics && images.relics.get(relic.id);
    ctx.save();
    ctx.beginPath();
    ctx.arc(centreX, centreY, size / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    if (image) {
      drawCover(ctx, image, x + 5, top + 5, size - 10, size - 10);
    } else {
      ctx.fillStyle = palette.onPaper;
      ctx.font = `800 22px ${FONT_TEXT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((relic.label[0] || "?").toUpperCase(), centreX, centreY + 1);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(centreX, centreY, size / 2, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.ink;
    ctx.stroke();
    x += step;
  }
  const more = model.relicTotal - model.relics.length;
  if (more > 0) {
    ctx.font = `800 18px ${FONT_TEXT}`;
    const width = ctx.measureText(`+${more}`).width + 26;
    inkedBox(ctx, palette, x, top + 6, width, size - 12, (size - 12) / 2, palette.ink, 3);
    ctx.fillStyle = palette.paper;
    ctx.textBaseline = "middle";
    ctx.fillText(`+${more}`, x + 13, top + size / 2 + 1);
    ctx.textBaseline = "alphabetic";
    return;
  }
  // Two or three relics leave the row mostly empty: name them.
  if (model.relics.length <= 3) {
    ctx.font = `700 17px ${FONT_TEXT}`;
    ctx.fillStyle = palette.onPaper;
    const names = clipText(ctx, model.relics.map((relic) => relic.label).join("  ·  "), W - MARGIN - x - 8);
    ctx.textBaseline = "middle";
    ctx.fillText(names, x + 6, top + size / 2 + 1);
    ctx.textBaseline = "alphabetic";
  }
}

function drawHand(ctx, palette, model, images) {
  const labelBaseline = BAND_H + 136;
  drawLabel(ctx, palette, `Deck · ${model.deckSize} ${model.deckSize === 1 ? "card" : "cards"}`, MARGIN, labelBaseline);
  const top = labelBaseline + 10;
  const height = 172;
  const width = Math.round((205 / 256) * height);
  if (model.cards.length === 0) {
    ctx.font = `600 16px ${FONT_TEXT}`;
    ctx.fillStyle = palette.onPaper2;
    ctx.fillText("Deck not recorded for this run", MARGIN, top + 30);
    return;
  }
  const more = model.cardKinds - model.cards.length;
  const slots = model.cards.length + (more > 0 ? 1 : 0);
  const span = W - MARGIN * 2;
  const step = slots > 1 ? Math.min(width + 6, (span - width) / (slots - 1)) : 0;
  // A hand: each card leans a little, alternating.
  model.cards.forEach((card, index) => {
    const x = MARGIN + index * step;
    const lean = ((index % 2 === 0 ? -1 : 1) * 1.6 * Math.PI) / 180;
    ctx.save();
    ctx.translate(x + width / 2, top + height / 2);
    ctx.rotate(lean);
    const image = images.cards && images.cards.get(card.id);
    if (image) {
      withShadow(ctx, palette.ink, () => ctx.drawImage(image, -width / 2, -height / 2, width, height), 3);
    } else {
      inkedBox(ctx, palette, -width / 2 + 8, -height / 2 + 8, width - 16, height - 16, 12, palette.paper2, 3);
      ctx.fillStyle = palette.onPaper;
      ctx.font = `800 15px ${FONT_TEXT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(clipText(ctx, card.label, width - 34), 0, 0);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
    ctx.restore();
  });
  if (more > 0) {
    const x = MARGIN + model.cards.length * step;
    inkedBox(ctx, palette, x + 10, top + 12, width - 20, height - 24, 12, palette.ink, 3);
    ctx.fillStyle = palette.title;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 44px ${FONT_DISPLAY}`;
    ctx.fillText(`+${more}`, x + width / 2, top + height / 2 - 8);
    ctx.fillStyle = palette.paper;
    ctx.font = `700 14px ${FONT_TEXT}`;
    ctx.fillText("more", x + width / 2, top + height / 2 + 24);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
}

/** The maker's mark: the one line that says what made this, and where. */
function drawFooter(ctx, palette) {
  const baseline = H - 26;
  ctx.font = `800 26px ${FONT_DISPLAY}`;
  const mark = "SpireVault";
  const markWidth = ctx.measureText(mark).width;
  const pillHeight = 36;
  const pillTop = baseline - 26;
  roundedPath(ctx, MARGIN, pillTop, markWidth + 28, pillHeight, 10);
  ctx.fillStyle = palette.ink;
  ctx.fill();
  ctx.fillStyle = palette.title;
  ctx.fillText(mark, MARGIN + 14, baseline);

  ctx.font = `600 15px ${FONT_TEXT}`;
  ctx.fillStyle = palette.onPaper2;
  ctx.fillText("Run tracker for Slay the Spire 2", MARGIN + markWidth + 42, baseline - 2);

  ctx.textAlign = "right";
  ctx.font = `800 17px ${FONT_TEXT}`;
  ctx.fillStyle = palette.onPaper;
  ctx.fillText("app.spirevault.app", W - MARGIN, baseline - 2);
  const urlWidth = ctx.measureText("app.spirevault.app").width;
  ctx.font = `600 14px ${FONT_TEXT}`;
  ctx.fillStyle = palette.onPaper2;
  ctx.fillText("Made by @c3rooks  ·", W - MARGIN - urlWidth - 8, baseline - 2);
  ctx.textAlign = "left";
}

/**
 * Draws the card. Safe to call twice: first without images (text and shapes
 * only), then again once they have loaded.
 * @param {HTMLCanvasElement} canvas
 * @param {ShareCardModel} model
 * @param {ShareCardImages | null} images
 * @param {ReturnType<typeof readSharePalette>} palette
 */
export function drawShareCard(canvas, model, images, palette) {
  const art = images || {};
  const { scale } = SHARE_CARD_SIZE;
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";

  // Everything inside the card's rounded shape; the corners stay clear.
  ctx.save();
  roundedPath(ctx, FRAME / 2, FRAME / 2, W - FRAME, H - FRAME, RADIUS);
  ctx.clip();

  drawBand(ctx, palette, model, art);
  drawPaper(ctx, palette);
  const stampLeft = drawStamp(ctx, palette, model);
  const climberRight = drawClimber(ctx, palette, model, art);
  const textLeft = Math.max(climberRight + 26, 280);
  drawName(ctx, palette, model, textLeft, stampLeft - 16);
  drawFacts(ctx, palette, model, textLeft, W - MARGIN);
  drawRelics(ctx, palette, model, art);
  drawHand(ctx, palette, model, art);
  drawFooter(ctx, palette);
  ctx.restore();

  roundedPath(ctx, FRAME / 2, FRAME / 2, W - FRAME, H - FRAME, RADIUS);
  ctx.lineWidth = FRAME;
  ctx.strokeStyle = palette.ink;
  ctx.stroke();
}
