PROJECT ?= vault-web
DOMAIN  ?= app.spirevault.app

.PHONY: dev deploy verify assets preflight

dev:
	npx --yes wrangler@latest pages dev .

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
	@for f in script.js run-coach.js lib/*.js; do \
	  node --check $$f || { echo "✘ parse error in $$f — aborting deploy"; exit 1; }; \
	done
	@node scripts/preflight-runtime.mjs || { echo "✘ runtime preflight failed — aborting deploy"; exit 1; }
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
	@echo "✓ all modules parse cleanly"

deploy: preflight
	npx --yes wrangler@latest pages deploy . \
	    --project-name=$(PROJECT) \
	    --branch=main \
	    --commit-dirty=true

verify:
	@echo "→ HEAD https://$(DOMAIN)"
	@curl -fsSI "https://$(DOMAIN)" | head -n 5 || echo "site not yet reachable"
