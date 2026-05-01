#!/usr/bin/env python3
"""Convert the iOS Ascension Companion's PNG asset catalog into a flat,
optimized webp tree the SpireVault web companion can ship to Cloudflare
Pages without the 336 MB original weight.

Source layout (xcassets):
    SlayTheSpire2Companion/.../Assets.xcassets/
        Cards/<slug>.imageset/<slug>.png       (~1137 files, ~328 MB)
        Relics/<slug>.imageset/<slug>.png      (~288 files, ~8 MB)
        Characters/character_<slug>.imageset/character_<slug>.png  (5 files)

Output:
    Web/assets/sts2/
        cards/<slug>.webp
        relics/<slug>.webp
        characters/<slug>.webp
        manifest.json   { cards: [...], relics: [...], characters: [...] }

Each output is resized so the display dimensions are crisp at retina
without wasting bytes on detail no one will see at 96px on a phone.

Run:
    python3 scripts/build_sts2_assets.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "SlayTheSpire2Companion" / "SlayTheSpire2Companion" / "Assets.xcassets"
OUT_ROOT = REPO_ROOT / "Web" / "assets" / "sts2"

# Per-category settings. We intentionally cap dimensions: cards display
# at ~80-120px in lists and ~64px in run-row icons, so 256 covers any
# reasonable retina case. Relics are pure thumbnails. Characters are
# the only assets large enough to warrant 384.
CONFIG = {
    "Cards":      {"out": "cards",      "max_dim": 256, "quality": 82, "method": 4},
    "Relics":     {"out": "relics",     "max_dim": 128, "quality": 85, "method": 5},
    "Characters": {"out": "characters", "max_dim": 384, "quality": 86, "method": 6, "strip_prefix": "character_"},
    "Potions":    {"out": "potions",    "max_dim": 128, "quality": 85, "method": 5},
}

def find_source_png(imageset_dir: Path) -> Path | None:
    """An .imageset directory contains the PNG plus Contents.json. Pick
    the first .png we find (1x is the only scale present in the catalog)."""
    for child in imageset_dir.iterdir():
        if child.suffix.lower() == ".png":
            return child
    return None

def slug_from_imageset(imageset_dir: Path, strip_prefix: str | None = None) -> str:
    """`ironclad_strike.imageset` → `ironclad_strike`. Optionally strip
    a prefix (e.g. `character_ironclad` → `ironclad`)."""
    stem = imageset_dir.name.removesuffix(".imageset")
    if strip_prefix and stem.startswith(strip_prefix):
        stem = stem[len(strip_prefix):]
    return stem

def convert_image(src: Path, dst: Path, max_dim: int, quality: int, method: int) -> int:
    """Resize → webp. Returns the output file size in bytes.

    `method` is the WebP compression effort (0=fastest, 6=smallest).
    For cards we use 4 — the difference between 4 and 6 is ~5% file size
    but ~3-4× compression time, and we have over a thousand of them."""
    with Image.open(src) as im:
        im = im.convert("RGBA")
        w, h = im.size
        if max(w, h) > max_dim:
            ratio = max_dim / max(w, h)
            nw = max(1, int(round(w * ratio)))
            nh = max(1, int(round(h * ratio)))
            im = im.resize((nw, nh), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, "WEBP", quality=quality, method=method)
        return dst.stat().st_size

def _worker(args):
    """Pickle-friendly worker for ProcessPoolExecutor: must be a top-level
    function. Returns (slug, in_bytes, out_bytes, error_or_none)."""
    src, dst, max_dim, quality, method, slug = args
    try:
        in_bytes = src.stat().st_size
        out_bytes = convert_image(src, dst, max_dim, quality, method)
        return slug, in_bytes, out_bytes, None
    except Exception as exc:
        return slug, 0, 0, repr(exc)

def process_category(category: str, settings: dict, executor: ProcessPoolExecutor) -> tuple[list[str], int, int]:
    """Returns (slugs_emitted, total_input_bytes, total_output_bytes)."""
    src_dir = SRC_ROOT / category
    if not src_dir.exists():
        print(f"  ⚠ skipping {category}: missing source dir {src_dir}")
        return [], 0, 0
    out_dir = OUT_ROOT / settings["out"]
    out_dir.mkdir(parents=True, exist_ok=True)

    jobs = []
    for entry in sorted(src_dir.iterdir()):
        if entry.suffix != ".imageset" or not entry.is_dir():
            continue
        png = find_source_png(entry)
        if not png:
            continue
        slug = slug_from_imageset(entry, settings.get("strip_prefix"))
        dst = out_dir / f"{slug}.webp"
        jobs.append((png, dst, settings["max_dim"], settings["quality"], settings["method"], slug))

    if not jobs:
        return [], 0, 0

    slugs: list[str] = []
    total_in = 0
    total_out = 0
    failures = 0
    start = time.time()

    futures = [executor.submit(_worker, j) for j in jobs]
    for fut in as_completed(futures):
        slug, in_bytes, out_bytes, err = fut.result()
        if err:
            failures += 1
            print(f"  ✗ {slug}: {err}", file=sys.stderr)
            continue
        slugs.append(slug)
        total_in += in_bytes
        total_out += out_bytes

    slugs.sort()
    elapsed = time.time() - start
    print(
        f"  {category:11s} → {len(slugs):4d} slugs · "
        f"{total_in / 1024 / 1024:6.1f} MB → {total_out / 1024 / 1024:5.1f} MB · "
        f"{elapsed:.1f}s"
        + (f"  ({failures} failures)" if failures else "")
    )
    return slugs, total_in, total_out

def main() -> None:
    print(f"SpireVault asset pipeline")
    print(f"  src: {SRC_ROOT}")
    print(f"  dst: {OUT_ROOT}")
    if not SRC_ROOT.exists():
        print(f"FATAL: source root not found ({SRC_ROOT})", file=sys.stderr)
        sys.exit(1)

    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, list[str]] = {}
    grand_in = 0
    grand_out = 0

    workers = max(1, (os.cpu_count() or 4))
    print(f"  workers: {workers}")
    with ProcessPoolExecutor(max_workers=workers) as executor:
        for category, settings in CONFIG.items():
            slugs, tin, tout = process_category(category, settings, executor)
            manifest[settings["out"]] = slugs
            grand_in += tin
            grand_out += tout

    manifest_path = OUT_ROOT / "manifest.json"
    with manifest_path.open("w") as f:
        json.dump({
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "version": 1,
            "counts": {k: len(v) for k, v in manifest.items()},
            **manifest,
        }, f, indent=2)
    print(f"\n  manifest → {manifest_path}")
    print(
        f"  TOTAL: {grand_in / 1024 / 1024:6.1f} MB → "
        f"{grand_out / 1024 / 1024:5.1f} MB "
        f"({grand_out * 100 / max(grand_in, 1):.1f}% of original)"
    )

if __name__ == "__main__":
    main()
