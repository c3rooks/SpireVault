/**
 * Read-only access to Slay the Spire 2's Godot 4 resource pack (.pck).
 *
 * Shared by the scripts that pull game data straight from the installed game
 * (build-card-faces.mjs, build-relic-icons.mjs, sync-sts2-labels.mjs). It reads
 * the pack's file directory, the English localization and the image resources.
 * It never touches the game's compiled code: card costs, types and numbers live
 * there, so nothing built from this module can know them.
 *
 * Format notes (Godot 4.5, pack format v3, unencrypted directory):
 *   header   "GDPC", u32 format, u32 x3 version, u32 flags, u64 file base, u64 dir offset
 *   dir      u32 count, then per file: u32 path len, path, u64 offset, u64 size, 16-byte md5, u32 flags
 *   .ctex    "GST2" CompressedTexture2D: PNG/WebP payload, or raw VRAM blocks (BC7 / DXT)
 *   RSCC     Godot's block-compressed file (zstd blocks), used by imported fonts
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

/** Godot Image::Format values that matter here. */
export const IMAGE_FORMAT = Object.freeze({ DXT1: 17, DXT3: 18, DXT5: 19, BPTC_RGBA: 22 });

/** CompressedTexture2D data formats. */
const DATA_FORMAT = Object.freeze({ IMAGE: 0, PNG: 1, WEBP: 2 });

/**
 * Opens a pack and indexes its directory.
 * @param {string} pckPath
 */
export function openPck(pckPath) {
  if (!statSync(pckPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`pck not found: ${pckPath}`);
  }
  const fd = openSync(pckPath, "r");
  const read = (position, length) => {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, position);
    return buffer;
  };
  const head = read(0, 0x70);
  if (head.toString("ascii", 0, 4) !== "GDPC") throw new Error(`${pckPath} is not a Godot pack`);
  const flags = head.readUInt32LE(20);
  const fileBase = Number(head.readBigUInt64LE(24));
  const dirOffset = Number(head.readBigUInt64LE(32));
  if (flags & 1) throw new Error("the pack directory is encrypted");

  const files = new Map();
  let position = dirOffset;
  const count = read(position, 4).readUInt32LE(0);
  position += 4;
  for (let i = 0; i < count; i++) {
    const length = read(position, 4).readUInt32LE(0);
    position += 4;
    const path = read(position, length).toString("utf8").replace(/\0+$/, "");
    position += length;
    const meta = read(position, 36);
    position += 36;
    const offset = Number(meta.readBigUInt64LE(0)) + (flags & 2 ? fileBase : 0);
    files.set(path, { offset, size: Number(meta.readBigUInt64LE(8)) });
  }

  /** @param {string} path */
  const get = (path) => {
    const entry = files.get(path);
    if (!entry) throw new Error(`not in pack: ${path}`);
    return read(entry.offset, entry.size);
  };
  return {
    files,
    has: (path) => files.has(path),
    get,
    text: (path) => get(path).toString("utf8"),
    json: (path) => JSON.parse(get(path).toString("utf8")),
    close: () => closeSync(fd),
  };
}

/**
 * Decodes a .ctex header.
 * @returns {{ width: number, height: number, kind: "png"|"webp", bytes: Buffer }
 *         | { width: number, height: number, kind: "vram", format: number, bytes: Buffer }
 *         | null}
 */
export function decodeCtex(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "GST2") return null;
  // magic, version, width, height, flags, data flags, mip limit, 3 reserved (36 bytes)
  const dataFormat = buffer.readUInt32LE(36);
  const width = buffer.readUInt16LE(40);
  const height = buffer.readUInt16LE(42);
  const format = buffer.readUInt32LE(48);
  if (dataFormat === DATA_FORMAT.PNG || dataFormat === DATA_FORMAT.WEBP) {
    const size = buffer.readUInt32LE(52);
    return { width, height, kind: dataFormat === DATA_FORMAT.PNG ? "png" : "webp", bytes: buffer.subarray(56, 56 + size) };
  }
  if (dataFormat === DATA_FORMAT.IMAGE && Object.values(IMAGE_FORMAT).includes(format)) {
    const blockBytes = format === IMAGE_FORMAT.DXT1 ? 8 : 16;
    const size = Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes; // mip 0 only
    return { width, height, kind: "vram", format, bytes: buffer.subarray(52, 52 + size) };
  }
  return null;
}

/**
 * Loads a source image (e.g. `images/relics/anchor.png`) through its `.import`
 * remap. Prefers the plain (PNG/WebP) texture; falls back to VRAM blocks, which
 * the caller decodes with `decodeVramInPage`.
 */
export function loadImage(pck, sourcePath) {
  const remap = pck.text(`${sourcePath}.import`);
  const paths = [...remap.matchAll(/res:\/\/(\.godot\/imported\/[^"]+\.ctex)/g)].map((m) => m[1]);
  const ordered = [...paths].sort((a, b) => Number(/\.(bptc|s3tc|etc2|astc)\.ctex$/.test(a)) - Number(/\.(bptc|s3tc|etc2|astc)\.ctex$/.test(b)));
  for (const path of ordered) {
    const image = decodeCtex(pck.get(path));
    if (image) return { ...image, source: sourcePath };
  }
  return null;
}

/** An AtlasTexture `.tres`: which atlas image and which rectangle (+ trimmed margin). */
export function readAtlasTexture(pck, tresPath) {
  const text = pck.text(tresPath);
  const atlas = text.match(/path="res:\/\/([^"]+)"/)?.[1];
  const rect = (name) => text.match(new RegExp(`${name} = Rect2\\(([^)]+)\\)`))?.[1].split(",").map(Number);
  const region = rect("region");
  if (!atlas || !region) return null;
  return { atlas, region, margin: rect("margin") ?? [0, 0, 0, 0] };
}

/** Inflates an RSCC (FileAccessCompressed, zstd) blob. */
export function inflateRscc(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RSCC") return buffer;
  const mode = buffer.readUInt32LE(4);
  if (mode !== 2) throw new Error(`RSCC compression mode ${mode} is not zstd`);
  const blockSize = buffer.readUInt32LE(8);
  const total = buffer.readUInt32LE(12);
  const blocks = Math.floor(total / blockSize) + 1;
  let position = 16;
  const sizes = [];
  for (let i = 0; i < blocks; i++, position += 4) sizes.push(buffer.readUInt32LE(position));
  const parts = sizes.map((size) => {
    const part = zstdDecompressSync(buffer.subarray(position, position + size));
    position += size;
    return part;
  });
  return Buffer.concat(parts).subarray(0, total);
}

/**
 * The TrueType file a Godot FontFile was imported from (e.g. `fonts/kreon_bold.ttf`).
 * The imported .fontdata keeps the original bytes in its `data` array; this finds
 * the sfnt table directory and returns exactly the bytes it spans.
 */
export function loadFont(pck, fontPath) {
  const remap = pck.text(`${fontPath}.import`);
  const path = remap.match(/path="res:\/\/([^"]+\.fontdata)"/)?.[1];
  if (!path) throw new Error(`no fontdata for ${fontPath}`);
  const data = inflateRscc(pck.get(path));
  for (let at = data.indexOf(Buffer.from([0, 1, 0, 0])); at >= 0; at = data.indexOf(Buffer.from([0, 1, 0, 0]), at + 1)) {
    const tables = data.readUInt16BE(at + 4);
    if (tables < 4 || tables > 64 || at + 12 + tables * 16 > data.length) continue;
    let end = 0;
    let plausible = true;
    for (let i = 0; i < tables; i++) {
      const record = at + 12 + i * 16;
      if (!/^[A-Za-z0-9/ ]{4}$/.test(data.toString("latin1", record, record + 4))) { plausible = false; break; }
      end = Math.max(end, data.readUInt32BE(record + 8) + data.readUInt32BE(record + 12));
    }
    // The byte array's u32 length prefix sits right before the font: it must agree.
    if (plausible && at >= 4 && data.readUInt32LE(at - 4) === end) return data.subarray(at, at + end);
  }
  throw new Error(`could not find the TrueType data inside ${path}`);
}

/** English localization table, e.g. "cards" -> { "FOOLISH_SHOT.title": "Foolish Shot", ... }. */
export function loadLocalization(pck, table) {
  return pck.json(`localization/eng/${table}.json`);
}

/**
 * id -> English title for every entry with a `.title`. A few cards only have
 * variant titles (Dingy Dagger: `title.dingy`, `title.fine`, `title.pristine`);
 * those use the first variant, which is the card's base name.
 */
export function localizedIds(loc) {
  const plain = new Map();
  const variants = new Map();
  for (const [key, value] of Object.entries(loc)) {
    const match = key.match(/^([A-Z0-9_]+)\.title(\.[a-z]+)?$/);
    if (!match) continue;
    if (!match[2]) plain.set(match[1], value);
    else if (!variants.has(match[1])) variants.set(match[1], value);
  }
  const ids = new Map();
  for (const id of new Set([...plain.keys(), ...variants.keys()])) ids.set(id, { title: plain.get(id) ?? variants.get(id) });
  return ids;
}

/**
 * Card portrait folders -> the app's slug prefix. The app files every
 * non-character card (event, token, curse, status, quest) under `colorless_`,
 * the convention labels.json already uses (Shiv, Soul, Wound, Injury, Lantern Key).
 */
export const POOL_PREFIX = Object.freeze({
  ironclad: "ironclad",
  silent: "silent",
  defect: "defect",
  regent: "regent",
  necrobinder: "necrobinder",
  fool: "fool",
  colorless: "colorless",
  event: "colorless",
  token: "colorless",
  curse: "colorless",
  status: "colorless",
  quest: "colorless",
});

/**
 * Every card the pack has both an English title and a portrait for. A card with
 * a title but no portrait anywhere (release or beta art) is not treated as part
 * of the game: those are test cards (MOCK_*) and cut content that only appears
 * in old development patch notes.
 */
export function cardCatalog(pck) {
  const loc = loadLocalization(pck, "cards");
  const portraits = new Map();
  for (const path of pck.files.keys()) {
    const match = path.match(/^images\/packed\/card_portraits\/([a-z_]+)\/(beta\/)?([a-z0-9_]+)\.png\.import$/);
    if (!match || !(match[1] in POOL_PREFIX)) continue;
    const [, pool, beta, name] = match;
    const list = portraits.get(name) ?? [];
    list.push({ pool, beta: Boolean(beta), source: path.replace(/\.import$/, "") });
    portraits.set(name, list);
  }
  const cards = [];
  const skipped = [];
  for (const [id, { title }] of localizedIds(loc)) {
    const name = id.toLowerCase();
    // Release art first, beta (placeholder) art only when that is all there is.
    const options = (portraits.get(name) ?? []).sort((a, b) => Number(a.beta) - Number(b.beta));
    if (options.length === 0) {
      skipped.push(id);
      continue;
    }
    const { pool, beta, source } = options[0];
    const prefix = POOL_PREFIX[pool];
    // STRIKE_FOOL / DEFEND_IRONCLAD style ids carry their pool as a suffix;
    // the app's slug for those is `<pool>_strike` (see cardImageSrc's swap).
    const suffix = `_${pool}`;
    const base = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    cards.push({
      id,
      title,
      pool,
      prefix,
      slug: `${prefix}_${base.replace(/_/g, "")}`,
      portrait: source,
      portraitIsBeta: beta,
    });
  }
  return { cards, skipped };
}

/** Every relic the pack has an English title and an icon (release, beta or atlas) for. */
export function relicCatalog(pck) {
  const loc = loadLocalization(pck, "relics");
  const relics = [];
  const skipped = [];
  for (const [id, { title }] of localizedIds(loc)) {
    const name = id.toLowerCase();
    const icon = [`images/relics/${name}.png`, `images/relics/beta/${name}.png`].find((p) => pck.has(`${p}.import`));
    const atlas = `images/atlases/relic_atlas.sprites/${name}.tres`;
    if (!icon && !pck.has(atlas)) {
      skipped.push(id);
      continue;
    }
    relics.push({ id, title, slug: name.replace(/_/g, ""), icon: icon ?? null, atlas: pck.has(atlas) ? atlas : null });
  }
  return { relics, skipped };
}

/**
 * Page-side decoder for VRAM-compressed textures (BC7 / DXT). Chromium's WebGL2
 * exposes the GPU formats, so the pixels come from the same decoder the game's
 * renderer uses. Pass to `page.evaluate` with `{ base64, width, height, format }`;
 * resolves to a PNG data URL.
 */
export function decodeVramInPage({ base64, width, height, format }) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false });
  if (!gl) throw new Error("WebGL2 unavailable");
  const bptc = gl.getExtension("EXT_texture_compression_bptc");
  const s3tc = gl.getExtension("WEBGL_compressed_texture_s3tc");
  const internal = {
    22: bptc?.COMPRESSED_RGBA_BPTC_UNORM_EXT,
    19: s3tc?.COMPRESSED_RGBA_S3TC_DXT5_EXT,
    18: s3tc?.COMPRESSED_RGBA_S3TC_DXT3_EXT,
    17: s3tc?.COMPRESSED_RGBA_S3TC_DXT1_EXT,
  }[format];
  if (!internal) throw new Error(`no WebGL decoder for image format ${format}`);
  const source = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, source);
  gl.compressedTexImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, bytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  const program = gl.createProgram();
  const shaders = [
    [gl.VERTEX_SHADER, "#version 300 es\nout vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.0-1.0,0.0,1.0);}"],
    [gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D t;out vec4 o;void main(){o=texture(t,uv);}"],
  ];
  for (const [type, code] of shaders) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindTexture(gl.TEXTURE_2D, source);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Texel row 0 lands on framebuffer row 0, and readPixels starts at row 0: no flip.
  const pixels = new Uint8ClampedArray(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  return out.toDataURL("image/png");
}

/**
 * Turns a loaded image into a data URL a page can draw, decoding VRAM blocks
 * in the page when needed.
 * @param {import("playwright").Page} page
 */
export async function imageDataUrl(page, image) {
  if (image.kind === "png" || image.kind === "webp") {
    return `data:image/${image.kind};base64,${image.bytes.toString("base64")}`;
  }
  return page.evaluate(decodeVramInPage, {
    base64: image.bytes.toString("base64"),
    width: image.width,
    height: image.height,
    format: image.format,
  });
}

/** `--name value` argument, or the fallback. */
export function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** `--name` flag. */
export function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** The .pck path: the first argument ending in .pck, or the macOS Steam default. */
export function pckPathFromArgs() {
  const positional = process.argv.slice(2).find((value) => value.endsWith(".pck"));
  return positional || `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Slay the Spire 2/SlayTheSpire2.app/Contents/Resources/Slay the Spire 2.pck`;
}
