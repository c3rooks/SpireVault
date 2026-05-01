PROJECT ?= vault-web
DOMAIN  ?= app.spirevault.app

.PHONY: dev deploy verify assets

dev:
	npx --yes wrangler@latest pages dev .

# Regenerate the optimized STS2 art library + label database from the
# iOS Ascension Companion's xcassets and GameDatabase.swift. Should be
# idempotent — only re-run when the iOS source changes.
assets:
	python3 ../scripts/build_sts2_assets.py
	python3 ../scripts/extract_sts2_labels.py

deploy:
	npx --yes wrangler@latest pages deploy . \
	    --project-name=$(PROJECT) \
	    --branch=main \
	    --commit-dirty=true

verify:
	@echo "→ HEAD https://$(DOMAIN)"
	@curl -fsSI "https://$(DOMAIN)" | head -n 5 || echo "site not yet reachable"
