PROJECT ?= vault-web
DOMAIN  ?= app.spirevault.app

.PHONY: dev dev-static css deploy verify assets preflight

dev:
	npx --yes wrangler@latest pages dev .

# Dependency-free static server (no Pages Functions). Applies _headers, so
# the production CSP is enforced locally. Enough for UI work and screenshots.
dev-static:
	node scripts/dev-static.mjs 8788

# Rebuild styles.next.css (the new UI's stylesheet) from styles/src/.
# The output is committed; `preflight` fails if it is stale.
css:
	node scripts/build-css.mjs

# Regenerate the optimized STS2 art library + label database from the
# iOS Ascension Companion's xcassets and GameDatabase.swift. Should be
# idempotent — only re-run when the iOS source changes.
assets:
	python3 ../scripts/build_sts2_assets.py
	python3 ../scripts/extract_sts2_labels.py

# Parse-check every JS module before deploy. A single SyntaxError in a
# module-loaded script kills the entire page (no partial execution),
# and production revealed exactly that failure mode: a duplicate
# identifier shipped, boot() never ran, visitors landed on the
# signed-out hero instead of the app. `node --check` catches 100 %
# of parse errors in under a second.
#
# Second check (`node scripts/preflight-runtime.mjs`) catches the
# class of bugs that DO parse but crash at runtime — specifically a
# stray backtick INSIDE a JS template literal, which terminates the
# template early and leaves bare identifiers like `steam://` floating
# in the JS body. node --check is happy with the rest of the file
# but the browser explodes the moment that template renders. Once
# bitten, twice shy.
preflight:
	@for f in script.js run-coach.js lib/*.js lib/ui/*.js lib/ui/overview/*.js scripts/*.mjs; do \
	  node --check $$f || { echo "✘ parse error in $$f — aborting deploy"; exit 1; }; \
	done
	@node scripts/preflight-runtime.mjs || { echo "✘ runtime preflight failed — aborting deploy"; exit 1; }
	@# No top-level await in script.js. It is a PARSE error in engines that
	@# predate it (Safari < 15, Chrome < 89), and a parse error in the entry
	@# module is a blank app for every visitor on such an engine, whichever
	@# code path they would have taken. `node --check` accepts it, so it
	@# needs its own guard. Top-level statements in script.js start in
	@# column 0; anything awaited there is the thing we are looking for.
	@if grep -nE '^[^ \t/*].*\bawait\b' script.js; then \
	  echo "✘ top-level await in script.js — wrap it in an async function"; exit 1; \
	fi
	@# styles.next.css is generated from styles/src/ and committed. A stale
	@# copy means the deployed CSS does not match the source that was reviewed.
	@node scripts/build-css.mjs --check || { echo "✘ styles.next.css is stale — run 'make css'"; exit 1; }
	@# Version-pin sanity. The leading vN in script.js's VAULT_BUILD
	@# constant must match the script.js?v=N pin in index.html. If
	@# they drift (e.g. someone bumps the HTML pin during a deploy
	@# but forgets the constant), every visitor running the new
	@# script gets stuck in an infinite "newer version available"
	@# banner loop because checkForUpdate() compares the two and
	@# always sees liveVersion > myVersion. Caught one of those on
	@# prod for v0.9.1–v0.9.3 — never again.
	@HTML_PIN=$$(grep -oE 'script\.js\?v=[0-9]+' index.html | head -1 | sed 's/.*v=//'); \
	JS_PIN=$$(grep -oE 'VAULT_BUILD = "v[0-9]+' script.js | head -1 | sed 's/.*"v//'); \
	if [ -z "$$HTML_PIN" ] || [ -z "$$JS_PIN" ]; then \
	  echo "✘ could not extract version pins (HTML='$$HTML_PIN', JS='$$JS_PIN') — aborting deploy"; exit 1; \
	fi; \
	if [ "$$HTML_PIN" != "$$JS_PIN" ]; then \
	  echo "✘ version drift: index.html script.js?v=$$HTML_PIN but script.js VAULT_BUILD = v$$JS_PIN."; \
	  echo "  These must match or the update banner loops forever."; \
	  echo "  Fix: bump VAULT_BUILD to v$$HTML_PIN-... in script.js (or revert the HTML pin)."; \
	  exit 1; \
	fi; \
	echo "✓ version pins match (v$$HTML_PIN)"
	@# Immutable-cache safety net. script.js, styles.css and /lib/* are
	@# served `max-age=1y, immutable`, which is only correct because every
	@# reference to them carries a ?v= token. An unversioned reference is
	@# a year-long stale cache for anyone who loads it once — a far worse
	@# version of the 4-hour staleness incident documented in _headers.
	@# The same script also catches one file being imported at two
	@# different tokens, which for ES modules silently creates two module
	@# instances with two copies of module state.
	@node scripts/check-asset-versions.mjs || { echo "✘ asset version check failed — aborting deploy"; exit 1; }
	@# The same contract for tokens already in a commit: a file changed under
	@# a committed token stays old for a year in any browser that ran that
	@# commit, local testing included (the torches kept their old layout for
	@# the owner on 2026-11-16 after three fixes under one token).
	@node scripts/check-served-tokens.mjs || { echo "✘ served-token check failed — bump the listed tokens"; exit 1; }
	@# Co-op "Share to Discord": the post text, name safety, and the link
	@# preview tags the /coop function serves (offline, no browser).
	@node scripts/verify-coop-share.mjs || { echo "✘ co-op share check failed"; exit 1; }
	@# "Your co-op climbs": the run parser keeps every player in a save, and
	@# the co-op numbers count only runs with a party.
	@node scripts/verify-coop-climbs.mjs || { echo "✘ co-op climbs check failed"; exit 1; }
	@# The Steam copy of a player's runs is all a phone or second browser
	@# shows: it must carry card picks, abandoned runs, modes, the party and
	@# the act timeline. It held no card picks at all until 2026-11-18.
	@node scripts/verify-cloud-run-wire.mjs || { echo "✘ Steam copy check failed"; exit 1; }
	@# Section filters (By character mode + ascension, the Ascensions climber
	@# and ladder) and the per-character win streak: offline, no browser.
	@node scripts/verify-stat-filters.mjs || { echo "✘ stat filters check failed"; exit 1; }
	@# Recent Runs "go by date": day keys, quick picks, the calendar's month
	@# grid and its labels (offline, no browser).
	@node scripts/verify-run-dates.mjs || { echo "✘ run-dates check failed"; exit 1; }
	@# SpireVault Sync: new runs from the extension join the loaded ones and
	@# never replace them; only desktop Chromium is offered the extension.
	@node scripts/verify-sync-bridge.mjs || { echo "✘ SpireVault Sync check failed"; exit 1; }
	@# Game-data drift guard. Cross-references labels.json, relic-info.js,
	@# ascension-info.js, demo-runs.js, script.js's boss/roster enums and
	@# the Swift AI glossary so a tooltip can never describe a card the
	@# game doesn't have. Found six STS1-only cards in the demo decks on
	@# its very first run — this is not a hypothetical failure mode.
	@node scripts/check-game-data.mjs || { echo "✘ game-data check failed — aborting deploy"; exit 1; }
	@echo "✓ all modules parse cleanly"

deploy: preflight
	npx --yes wrangler@latest pages deploy . \
	    --project-name=$(PROJECT) \
	    --branch=main \
	    --commit-dirty=true
	@# Record what is now live, so the next preflight can tell "changed since
	@# deploy without a token bump" from "never deployed". Commit the lock.
	@node scripts/check-asset-versions.mjs --record

verify:
	@echo "→ HEAD https://$(DOMAIN)"
	@curl -fsSI "https://$(DOMAIN)" | head -n 5 || echo "site not yet reachable"
