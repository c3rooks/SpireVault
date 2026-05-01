#!/usr/bin/env python3
"""Extract card and relic display names from the iOS Companion's Swift
GameDatabase, converted into asset-slug-keyed JSON.

The companion's source declares each card and relic like:
    Card(id: "ic_blood_wall", name: "Blood Wall", character: .ironclad, ...)
    Relic(id: "r_burning_blood", name: "Burning Blood", ...)

We need to translate that to the slug form used by our optimized webp
asset library (built from the xcassets):
    Card  ic_blood_wall    + .ironclad   → ironclad_bloodwall  → "Blood Wall"
    Relic r_burning_blood                → burningblood        → "Burning Blood"

Output: Web/assets/sts2/labels.json
    {
      "cards":  { "ironclad_bloodwall": "Blood Wall", ... },
      "relics": { "burningblood":       "Burning Blood", ... }
    }
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR  = REPO_ROOT / "SlayTheSpire2Companion" / "SlayTheSpire2Companion" / "Data"
OUT_PATH  = REPO_ROOT / "Web" / "assets" / "sts2" / "labels.json"

# Two-letter prefix → asset-slug character prefix. Verified against
# GameDatabase.swift (the iOS Companion's actual prefixes).
CHAR_PREFIX_MAP = {
    "ic_":  "ironclad",
    "si_":  "silent",
    "de_":  "defect",
    "re_":  "regent",
    "nb_":  "necrobinder",
    "cl_":  "colorless",
    "wt_":  "watcher",    # only if STS2 ever ships the watcher
}

CARD_RE  = re.compile(r'Card\(id:\s*"([^"]+)",\s*name:\s*"([^"]+)"')
RELIC_RE = re.compile(r'Relic\(id:\s*"([^"]+)",\s*name:\s*"([^"]+)"')

def card_to_slug(db_id: str) -> str | None:
    """`ic_blood_wall` → `ironclad_bloodwall`. Returns None on unknown
    prefix (would emit a slug we don't ship art for)."""
    for short, long in CHAR_PREFIX_MAP.items():
        if db_id.startswith(short):
            tail = db_id[len(short):].replace("_", "")
            return f"{long}_{tail}"
    return None

def relic_to_slug(db_id: str) -> str | None:
    """`r_burning_blood` → `burningblood`."""
    if not db_id.startswith("r_"):
        return None
    return db_id[2:].replace("_", "")

def main() -> None:
    if not DATA_DIR.exists():
        print(f"FATAL: data dir missing ({DATA_DIR})", file=sys.stderr)
        sys.exit(1)
    cards: dict[str, str] = {}
    relics: dict[str, str] = {}

    swift_files = list(DATA_DIR.glob("*.swift"))
    for swift in swift_files:
        text = swift.read_text(encoding="utf-8", errors="ignore")
        for m in CARD_RE.finditer(text):
            db_id, name = m.group(1), m.group(2)
            slug = card_to_slug(db_id)
            if slug:
                # Don't overwrite if duplicate appears (first wins).
                cards.setdefault(slug, name)
                # Also populate the upgraded form so we have a label
                # for `ironclad_bash_plus` → "Bash+1" etc.
                cards.setdefault(slug + "_plus", f"{name}+1")
        for m in RELIC_RE.finditer(text):
            db_id, name = m.group(1), m.group(2)
            slug = relic_to_slug(db_id)
            if slug:
                relics.setdefault(slug, name)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps({
        "version": 1,
        "counts": {"cards": len(cards), "relics": len(relics)},
        "cards":  cards,
        "relics": relics,
    }, indent=2))
    print(f"  cards:  {len(cards)} entries")
    print(f"  relics: {len(relics)} entries")
    print(f"  → {OUT_PATH}")

if __name__ == "__main__":
    main()
