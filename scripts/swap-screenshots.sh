#!/usr/bin/env bash
# Swaps the placeholder SVG screenshots for the real PNGs the user dropped
# into Site/assets/screenshots/, updates references in Site/index.html,
# README.md, and the Web companion, then redeploys the Cloudflare Pages
# site so the new images are live.
#
# Idempotent — running it twice does nothing the second time.
#
# Usage:  ./scripts/swap-screenshots.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SHOTS_DIR="Site/assets/screenshots"
REQUIRED=(overview.png coop.png)
OPTIONAL=(share.png og.png)

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }

bold "→ Verifying screenshots in $SHOTS_DIR"
missing=()
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$SHOTS_DIR/$f" ]]; then
    missing+=("$f")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  red "✗ Missing required screenshots:"
  printf "    - %s\n" "${missing[@]}"
  echo
  echo "Drop them into $SHOTS_DIR/ and re-run this script."
  echo "See SCREENSHOTS.md for the capture guide."
  exit 1
fi

# Optional shots: warn but don't fail.
for f in "${OPTIONAL[@]}"; do
  if [[ ! -f "$SHOTS_DIR/$f" ]]; then
    yellow "  (optional) $f not present — skipping"
  fi
done

green "✓ Required screenshots found."
echo

# ── Promote the new images to the canonical paths ─────────────────
bold "→ Copying screenshots into the canonical filenames"
cp "$SHOTS_DIR/overview.png" "Site/assets/screenshot-overview.png"
cp "$SHOTS_DIR/coop.png"     "Site/assets/screenshot-coop.png"
if [[ -f "$SHOTS_DIR/share.png" ]]; then
  cp "$SHOTS_DIR/share.png"  "Site/assets/screenshot-share.png"
fi
if [[ -f "$SHOTS_DIR/og.png" ]]; then
  cp "$SHOTS_DIR/og.png"     "Site/assets/og.png"
fi

# Mirror to Web/ so the web companion can use them too if it ever wants.
mkdir -p Web/assets
cp "Site/assets/screenshot-coop.png" "Web/assets/screenshot-coop.png" 2>/dev/null || true

# ── Update the source files to reference .png instead of .svg ────
bold "→ Rewriting <img> tags in Site/index.html, README.md, BUILT.md"

# macOS sed needs LC_ALL=C for files with em-dashes etc.
LC_ALL=C sed -i '' \
  -e 's|/assets/screenshot-overview\.svg|/assets/screenshot-overview.png|g' \
  -e 's|/assets/screenshot-coop\.svg|/assets/screenshot-coop.png|g' \
  -e 's|/assets/screenshot-share\.svg|/assets/screenshot-share.png|g' \
  Site/index.html

# Update OG image meta only if og.png was provided.
if [[ -f "$SHOTS_DIR/og.png" ]]; then
  LC_ALL=C sed -i '' \
    -e 's|/assets/og\.svg|/assets/og.png|g' \
    -e 's|name="twitter:card" content="summary"|name="twitter:card" content="summary_large_image"|g' \
    Site/index.html
fi

# README.md image references
LC_ALL=C sed -i '' \
  -e 's|Site/assets/screenshot-overview\.svg|Site/assets/screenshot-overview.png|g' \
  -e 's|Site/assets/screenshot-coop\.svg|Site/assets/screenshot-coop.png|g' \
  -e 's|Site/assets/screenshot-share\.svg|Site/assets/screenshot-share.png|g' \
  README.md

# Drop the "representative screens / real captures replace these" caption.
LC_ALL=C sed -i '' \
  -e '/Above: representative screens. Real captures replace these/,/in the GitHub Release notes\.<\/sub>/d' \
  README.md 2>/dev/null || true

green "✓ Source files updated."
echo

# ── Sanity check: every image path now exists ──────────────────────
bold "→ Sanity-checking image paths in Site/index.html"
for path in $(grep -oE '/assets/screenshot-[a-z]+\.png|/assets/og\.png' Site/index.html | sort -u); do
  if [[ -f "Site$path" ]]; then
    green "  ✓ Site$path"
  else
    red "  ✗ Site$path (referenced but not on disk)"
  fi
done
echo

# ── Redeploy the marketing site ────────────────────────────────────
bold "→ Redeploying the marketing site to Cloudflare Pages"
( cd Site && npx wrangler pages deploy . --project-name=vault-site --branch=main ) | tail -5
echo

# ── Commit + push ─────────────────────────────────────────────────
bold "→ Committing the new assets"
git add \
  Site/assets/screenshot-*.png \
  Site/assets/og.png 2>/dev/null \
  Site/index.html \
  README.md \
  Web/assets/*.png 2>/dev/null \
  || true

# Remove the now-unused SVG mockups from git so the repo is clean.
git rm -f \
  Site/assets/screenshot-overview.svg \
  Site/assets/screenshot-coop.svg \
  Site/assets/screenshot-share.svg \
  2>/dev/null || true

if git diff --cached --quiet; then
  yellow "  Nothing to commit (already in sync)."
else
  git -c user.name="c3rooks" -c user.email="c3rooks@users.noreply.github.com" \
    commit -m "$(cat <<'EOF'
docs: replace SVG screenshot mockups with real captures

The marketing site, README, and BUILT.md previously used illustrative
SVG mockups as placeholders. These are the real captures from the
running v0.1 macOS app and web companion — Overview tab, Co-op feed,
Share-Run card.
EOF
)"
  bold "→ Pushing to GitHub"
  git push origin main
fi

echo
green "✓ Done. Real screenshots are live."
echo "   Marketing site preview will reflect within ~30s once Pages caches refresh."
