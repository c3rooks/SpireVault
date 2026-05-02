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
preflight:
	@for f in script.js lib/*.js; do \
	  node --check $$f || { echo "✘ parse error in $$f — aborting deploy"; exit 1; }; \
	done
	@echo "✓ all modules parse cleanly"

deploy: preflight
	npx --yes wrangler@latest pages deploy . \
	    --project-name=$(PROJECT) \
	    --branch=main \
	    --commit-dirty=true

verify:
	@echo "→ HEAD https://$(DOMAIN)"
	@curl -fsSI "https://$(DOMAIN)" | head -n 5 || echo "site not yet reachable"
