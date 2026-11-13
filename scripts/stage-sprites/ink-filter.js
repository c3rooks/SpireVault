/* eslint-env browser */
/**
 * Page-side half of scripts/build-stage-sprites.mjs.
 *
 * Loaded into a blank Chromium page (no bundler, no dependencies) and exposed
 * as `window.InkFilter`. Turns a painterly game sprite into an "inked" one
 * that matches the new UI's shape language:
 *
 *   1. matte    — the sprites ship with a soft floor shadow painted into the
 *                 image; it is translucent, so an alpha cut removes it and
 *                 leaves a clean silhouette
 *   2. flatten  — edge-preserving smoothing, then a small palette (cel shading)
 *   3. lines    — ink lines where two clearly different flat colours meet
 *   4. contour  — a bold ink outline around the whole figure
 *
 * Everything is deterministic (seeded palette search) so re-running the build
 * on unchanged sources reproduces the same pixels.
 */
(function () {
  "use strict";

  // ---- colour space: sRGB <-> OKLab -------------------------------------------
  function srgbToLinear(value) {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(value) {
    const v = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  function rgbToOklab(r8, g8, b8) {
    const r = srgbToLinear(r8);
    const g = srgbToLinear(g8);
    const b = srgbToLinear(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }
  function oklabToRgb(L, A, B) {
    const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
    return [
      linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }

  /** Small seeded PRNG so the palette search is reproducible. */
  function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- image plumbing ---------------------------------------------------------
  async function loadImage(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }

  /**
   * Draws `source` scaled (and optionally mirrored), applies `patches`, and
   * returns its pixels.
   *
   * A patch is a polygon in the SOURCE image's own pixel coordinates (before
   * scaling or mirroring, so points can be read straight off the original
   * art). With a `fill` colour it paints over what is there; without one it
   * erases. Used to take things out of the game's art that do not belong on
   * the stage.
   */
  function rasterize(source, width, height, mirror, patches) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (mirror) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, 0, 0, width, height);
    const scale = width / source.naturalWidth;
    (patches || []).forEach((patch) => {
      ctx.beginPath();
      patch.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * scale, y * scale) : ctx.lineTo(x * scale, y * scale)));
      ctx.closePath();
      ctx.globalCompositeOperation = patch.fill ? "source-over" : "destination-out";
      ctx.fillStyle = patch.fill || "#000";
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
    return ctx.getImageData(0, 0, width, height);
  }

  /** Separable Gaussian blur over a Float32Array plane. */
  function blurPlane(plane, width, height, sigma) {
    if (sigma <= 0) return plane.slice();
    const radius = Math.max(1, Math.ceil(sigma * 2.5));
    const kernel = new Float32Array(radius * 2 + 1);
    let total = 0;
    for (let i = -radius; i <= radius; i++) {
      const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + radius] = weight;
      total += weight;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= total;

    const pass = new Float32Array(plane.length);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(width - 1, Math.max(0, x + k));
          acc += plane[row + xx] * kernel[k + radius];
        }
        pass[row + x] = acc;
      }
    }
    const out = new Float32Array(plane.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(height - 1, Math.max(0, y + k));
          acc += pass[yy * width + x] * kernel[k + radius];
        }
        out[y * width + x] = acc;
      }
    }
    return out;
  }

  // ---- 1. matte ---------------------------------------------------------------
  /**
   * Labels 4-connected regions of `mask` (values 0/1) equal to `target`.
   * Returns the label plane and each region's pixel count.
   */
  function labelRegions(mask, width, height, target) {
    const labels = new Int32Array(mask.length);
    const sizes = [0];
    const queue = new Int32Array(mask.length);
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== target || labels[start] !== 0) continue;
      const label = sizes.length;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labels[start] = label;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = (index - x) / width;
        if (x > 0) tail = visit(index - 1, label, tail);
        if (x < width - 1) tail = visit(index + 1, label, tail);
        if (y > 0) tail = visit(index - width, label, tail);
        if (y < height - 1) tail = visit(index + width, label, tail);
      }
      sizes.push(tail);
    }
    return { labels, sizes };

    function visit(index, label, tail) {
      if (mask[index] !== target || labels[index] !== 0) return tail;
      labels[index] = label;
      queue[tail] = index;
      return tail + 1;
    }
  }

  /**
   * Cuts the silhouette out of the alpha channel: everything at or above
   * `alphaCut` is the figure, everything below (the painted floor shadow and
   * the soft halo) is dropped. Specks are removed and pinholes filled.
   */
  function buildMatte(pixels, options) {
    const { width, height, data } = pixels;
    const count = width * height;
    const hard = new Float32Array(count);
    for (let i = 0; i < count; i++) hard[i] = data[i * 4 + 3] >= options.alphaCut ? 1 : 0;

    // Round the cut off: blur, then re-threshold.
    const soft = blurPlane(hard, width, height, options.matteSmooth);
    const mask = new Uint8Array(count);
    for (let i = 0; i < count; i++) mask[i] = soft[i] >= 0.5 ? 1 : 0;

    const islands = labelRegions(mask, width, height, 1);
    const minIsland = count * options.minIslandRatio;
    for (let i = 0; i < count; i++) {
      if (mask[i] === 1 && islands.sizes[islands.labels[i]] < minIsland) mask[i] = 0;
    }
    const holes = labelRegions(mask, width, height, 0);
    const maxHole = count * options.maxHoleRatio;
    for (let i = 0; i < count; i++) {
      if (mask[i] === 0 && holes.sizes[holes.labels[i]] < maxHole) mask[i] = 1;
    }
    return mask;
  }

  // ---- 2. flatten -------------------------------------------------------------
  /** Splits straight-alpha RGBA into three OKLab planes. */
  function toOklabPlanes(pixels) {
    const count = pixels.width * pixels.height;
    const L = new Float32Array(count);
    const A = new Float32Array(count);
    const B = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const lab = rgbToOklab(pixels.data[i * 4], pixels.data[i * 4 + 1], pixels.data[i * 4 + 2]);
      L[i] = lab[0];
      A[i] = lab[1];
      B[i] = lab[2];
    }
    return { L, A, B };
  }

  /** One bilateral pass: smooths paint texture, keeps edges. Masked pixels only. */
  function bilateralPass(planes, mask, width, height, radius, sigmaSpace, sigmaRange) {
    const out = { L: new Float32Array(planes.L.length), A: new Float32Array(planes.A.length), B: new Float32Array(planes.B.length) };
    const spaceDenominator = 2 * sigmaSpace * sigmaSpace;
    const rangeDenominator = 2 * sigmaRange * sigmaRange;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (mask[index] === 0) continue;
        const l0 = planes.L[index];
        const a0 = planes.A[index];
        const b0 = planes.B[index];
        let sumL = 0;
        let sumA = 0;
        let sumB = 0;
        let sumW = 0;
        const yMin = Math.max(0, y - radius);
        const yMax = Math.min(height - 1, y + radius);
        const xMin = Math.max(0, x - radius);
        const xMax = Math.min(width - 1, x + radius);
        for (let yy = yMin; yy <= yMax; yy++) {
          for (let xx = xMin; xx <= xMax; xx++) {
            const other = yy * width + xx;
            if (mask[other] === 0) continue;
            const dl = planes.L[other] - l0;
            const da = planes.A[other] - a0;
            const db = planes.B[other] - b0;
            const spatial = ((xx - x) * (xx - x) + (yy - y) * (yy - y)) / spaceDenominator;
            const range = (dl * dl + da * da + db * db) / rangeDenominator;
            const weight = Math.exp(-spatial - range);
            sumL += planes.L[other] * weight;
            sumA += planes.A[other] * weight;
            sumB += planes.B[other] * weight;
            sumW += weight;
          }
        }
        out.L[index] = sumL / sumW;
        out.A[index] = sumA / sumW;
        out.B[index] = sumB / sumW;
      }
    }
    return out;
  }

  /** Squared palette distance. Chroma is weighted up so hues stay distinct. */
  function paletteDistance(l1, a1, b1, l2, a2, b2, chromaWeight) {
    const dl = l1 - l2;
    const da = (a1 - a2) * chromaWeight;
    const db = (b1 - b2) * chromaWeight;
    return dl * dl + da * da + db * db;
  }

  /** k-means++ seeding followed by Lloyd iterations over a pixel sample. */
  function findPalette(planes, mask, options) {
    const random = mulberry32(options.seed);
    const members = [];
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1) members.push(i);
    const stride = Math.max(1, Math.floor(members.length / options.paletteSamples));
    const sample = [];
    for (let i = 0; i < members.length; i += stride) sample.push(members[i]);

    const weight = options.chromaWeight;
    const centres = [];
    const first = sample[Math.floor(random() * sample.length)];
    centres.push([planes.L[first], planes.A[first], planes.B[first]]);
    const nearest = new Float32Array(sample.length).fill(Infinity);
    while (centres.length < options.colors) {
      const latest = centres[centres.length - 1];
      let total = 0;
      for (let i = 0; i < sample.length; i++) {
        const p = sample[i];
        const d = paletteDistance(planes.L[p], planes.A[p], planes.B[p], latest[0], latest[1], latest[2], weight);
        if (d < nearest[i]) nearest[i] = d;
        total += nearest[i];
      }
      let pick = random() * total;
      let chosen = sample[sample.length - 1];
      for (let i = 0; i < sample.length; i++) {
        pick -= nearest[i];
        if (pick <= 0) {
          chosen = sample[i];
          break;
        }
      }
      centres.push([planes.L[chosen], planes.A[chosen], planes.B[chosen]]);
    }

    for (let round = 0; round < options.paletteRounds; round++) {
      const sums = centres.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < sample.length; i++) {
        const p = sample[i];
        const best = nearestCentre(centres, planes.L[p], planes.A[p], planes.B[p], weight);
        sums[best][0] += planes.L[p];
        sums[best][1] += planes.A[p];
        sums[best][2] += planes.B[p];
        sums[best][3] += 1;
      }
      sums.forEach((sum, index) => {
        if (sum[3] > 0) centres[index] = [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]];
      });
    }
    return addAccents(centres, planes, sample, options);
  }

  /**
   * k-means spends its palette on big areas, so a small but important detail
   * (glowing eyes, a gem) gets averaged into its surroundings. This adds the
   * worst-represented colour as its own entry, `accentColors` times.
   */
  function addAccents(centres, planes, sample, options) {
    const weight = options.chromaWeight;
    const result = centres.slice();
    for (let extra = 0; extra < options.accentColors; extra++) {
      let worst = -1;
      let worstDistance = 0;
      for (let i = 0; i < sample.length; i++) {
        const p = sample[i];
        const best = nearestCentre(result, planes.L[p], planes.A[p], planes.B[p], weight);
        const c = result[best];
        const d = paletteDistance(planes.L[p], planes.A[p], planes.B[p], c[0], c[1], c[2], weight);
        if (d > worstDistance) {
          worstDistance = d;
          worst = p;
        }
      }
      if (worst === -1) break;
      result.push([planes.L[worst], planes.A[worst], planes.B[worst]]);
    }
    return result;
  }

  function nearestCentre(centres, l, a, b, chromaWeight) {
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < centres.length; c++) {
      const d = paletteDistance(l, a, b, centres[c][0], centres[c][1], centres[c][2], chromaWeight);
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    return best;
  }

  /** Assigns every masked pixel to its palette entry (255 = outside the figure). */
  function assignPalette(planes, mask, centres, chromaWeight) {
    const indices = new Uint8Array(mask.length).fill(255);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) indices[i] = nearestCentre(centres, planes.L[i], planes.A[i], planes.B[i], chromaWeight);
    }
    return indices;
  }

  /** Majority filter: removes single-pixel speckle left by quantisation. */
  function majorityPass(indices, mask, width, height, radius, paletteSize) {
    const out = indices.slice();
    const votes = new Uint16Array(paletteSize);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (mask[index] === 0) continue;
        votes.fill(0);
        let best = indices[index];
        let bestVotes = 0;
        for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
          for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
            const other = indices[yy * width + xx];
            if (other === 255) continue;
            votes[other] += 1;
            if (votes[other] > bestVotes) {
              bestVotes = votes[other];
              best = other;
            }
          }
        }
        out[index] = best;
      }
    }
    return out;
  }

  /** Pushes the palette toward the UI's saturated, high-contrast look. */
  function gradePalette(centres, options) {
    return centres.map(([l, a, b]) => {
      const curved = Math.pow(Math.min(1, Math.max(0, l)), options.gamma);
      const contrasted = 0.5 + (curved - 0.5) * options.contrast;
      const lifted = Math.min(1, Math.max(0, contrasted + options.lift));
      return [lifted, a * options.saturation, b * options.saturation];
    });
  }

  // ---- 3. lines ---------------------------------------------------------------
  /**
   * Marks pixels where two palette regions meet and differ by more than
   * `lineContrast`. Soft shading steps inside one material stay unlined.
   */
  function buildLines(indices, centres, width, height, options) {
    const lines = new Float32Array(indices.length);
    if (options.lineContrast <= 0) return lines;
    const limit = options.lineContrast * options.lineContrast;
    const differs = (a, b) => {
      if (a === b || a === 255 || b === 255) return false;
      const ca = centres[a];
      const cb = centres[b];
      return paletteDistance(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], 1) > limit;
    };
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const index = y * width + x;
        const here = indices[index];
        if (here === 255) continue;
        if (differs(here, indices[index + 1]) || differs(here, indices[index + width])) lines[index] = 1;
      }
    }
    const widened = blurPlane(lines, width, height, options.lineWidth);
    for (let i = 0; i < widened.length; i++) widened[i] = Math.min(1, widened[i] * options.lineGain);
    return widened;
  }

  // ---- 4. contour -------------------------------------------------------------
  /**
   * Euclidean distance (capped at `radius` + 1) from each pixel to the mask.
   * Row scan for horizontal distance, then a vertical min within the radius.
   */
  function distanceToMask(mask, width, height, radius) {
    const far = radius + 2;
    const horizontal = new Float32Array(mask.length).fill(far);
    for (let y = 0; y < height; y++) {
      let last = -Infinity;
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x] === 1) last = x;
        horizontal[y * width + x] = Math.min(far, x - last);
      }
      last = Infinity;
      for (let x = width - 1; x >= 0; x--) {
        if (mask[y * width + x] === 1) last = x;
        horizontal[y * width + x] = Math.min(horizontal[y * width + x], last - x);
      }
    }
    const distance = new Float32Array(mask.length);
    const reach = Math.ceil(far);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let best = far * far;
        for (let dy = -reach; dy <= reach; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          const dx = horizontal[yy * width + x];
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
        distance[y * width + x] = Math.sqrt(best);
      }
    }
    return distance;
  }

  // ---- compose ----------------------------------------------------------------
  /** Paints the finished figure: contour underneath, flat colour, ink lines. */
  function compose(work, options) {
    const { width, height, mask, indices, centres, lines } = work;
    const palette = centres.map(([l, a, b]) => oklabToRgb(l, a, b));
    const ink = options.ink;
    const fill = blurPlane(Float32Array.from(mask), width, height, options.edgeSoftness);
    const distance = distanceToMask(mask, width, height, options.contour);
    const out = new ImageData(width, height);
    for (let i = 0; i < mask.length; i++) {
      const contourAlpha = Math.min(1, Math.max(0, options.contour + 0.5 - distance[i]));
      const fillAlpha = Math.min(1, Math.max(0, (fill[i] - 0.35) / 0.3));
      const colour = indices[i] === 255 ? ink : palette[indices[i]];
      const line = fillAlpha > 0 ? lines[i] * options.lineOpacity : 0;
      const inkShare = (1 - fillAlpha) + fillAlpha * line;
      out.data[i * 4] = Math.round(colour[0] * (1 - inkShare) + ink[0] * inkShare);
      out.data[i * 4 + 1] = Math.round(colour[1] * (1 - inkShare) + ink[1] * inkShare);
      out.data[i * 4 + 2] = Math.round(colour[2] * (1 - inkShare) + ink[2] * inkShare);
      out.data[i * 4 + 3] = Math.round(Math.max(contourAlpha, fillAlpha) * 255);
    }
    return out;
  }

  /** Tight bounding box of every pixel with visible alpha. */
  function visibleBounds(image) {
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.data[(y * image.width + x) * 4 + 3] < 8) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /**
   * Where the figure meets the ground, as fractions of the cropped width:
   * the horizontal extent of the silhouette within the bottom `band` of its
   * height. The page uses it to centre the ground shadow under the feet.
   */
  function groundContact(mask, width, bounds, band) {
    const top = Math.floor(bounds.y + bounds.height * (1 - band));
    let left = Infinity;
    let right = -Infinity;
    for (let y = top; y < bounds.y + bounds.height; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        if (mask[y * width + x] !== 1) continue;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (!Number.isFinite(left)) return { left: 0, right: 1 };
    return { left: (left - bounds.x) / bounds.width, right: (right - bounds.x + 1) / bounds.width };
  }

  /** Crops and resizes to the output height, then encodes. */
  async function encode(image, bounds, outHeight, type, quality) {
    const full = document.createElement("canvas");
    full.width = image.width;
    full.height = image.height;
    full.getContext("2d").putImageData(image, 0, 0);
    const outWidth = Math.round((bounds.width / bounds.height) * outHeight);
    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(full, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, outWidth, outHeight);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { base64: btoa(binary), width: outWidth, height: outHeight };
  }

  /**
   * @param {string} url      data URL of the source sprite
   * @param {object} options  see DEFAULTS in build-stage-sprites.mjs
   */
  async function process(url, options) {
    const source = await loadImage(url);
    const width = Math.round(source.naturalWidth * options.workScale);
    const height = Math.round(source.naturalHeight * options.workScale);
    const pixels = rasterize(source, width, height, options.mirror, options.patches);

    const mask = buildMatte(pixels, options);
    if (!mask.includes(1)) {
      throw new Error("ink-filter: nothing is left of the figure after the alpha cut; lower alphaCut");
    }
    let planes = toOklabPlanes(pixels);
    for (let pass = 0; pass < options.smoothPasses; pass++) {
      planes = bilateralPass(planes, mask, width, height, options.smoothRadius, options.smoothSpace, options.smoothRange);
    }
    const rawCentres = findPalette(planes, mask, options);
    let indices = assignPalette(planes, mask, rawCentres, options.chromaWeight);
    for (let pass = 0; pass < options.majorityPasses; pass++) {
      indices = majorityPass(indices, mask, width, height, options.majorityRadius, rawCentres.length);
    }
    const centres = gradePalette(rawCentres, options);
    const lines = buildLines(indices, centres, width, height, options);
    const image = compose({ width, height, mask, indices, centres, lines }, options);

    const bounds = visibleBounds(image);
    const encoded = await encode(image, bounds, options.outHeight, options.type, options.quality);
    return {
      base64: encoded.base64,
      width: encoded.width,
      height: encoded.height,
      ground: groundContact(mask, width, bounds, options.groundBand),
    };
  }

  window.InkFilter = { process };
})();
