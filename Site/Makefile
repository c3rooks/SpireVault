# Site/Makefile — operational targets for the landing page (spirevault.app).
#
#   make dev                 → preview locally on http://127.0.0.1:8791 (real headers and CSP)
#   make check               → layout, links, wiring, motion, speed and contrast checks
#   make shots               → review pictures in docs/screenshots/site/
#   make list                → the files a deploy would publish
#   make stage DMG=none      → copy those files to a clean folder outside iCloud
#   make deploy DMG=none     → stage, then deploy that folder to Cloudflare Pages
#   make deploy DMG=none BRANCH=preview   → the same, to a preview address
#   make verify              → quick smoke check that the live site responds 200
#
# A deploy publishes the staged copy, never this folder: this folder also holds
# this Makefile, a README, the pictures the GitHub README embeds and a Mac
# installer. DMG says what to do with the installer and has no default,
# because the copy here is not the file that is live:
#   DMG=none   leave it out        DMG=disk   use assets/The.Vault.dmg
#   DMG=/path/to/The.Vault.dmg     use that file

PROJECT ?= vault-site
DOMAIN  ?= spirevault.app
BRANCH  ?= main
NODE    ?= /opt/homebrew/opt/node@24/bin/node
PORT    ?= 8791
STAGE   ?= $(HOME)/Library/Caches/spirevault-site/stage
DMG     ?=

.PHONY: dev check shots list stage deploy verify check-deps

check-deps:
	@command -v npx >/dev/null || (echo "npx (Node.js) is required" >&2; exit 1)

dev:
	$(NODE) ../scripts/dev-site.mjs $(PORT)

check:
	$(NODE) ../scripts/verify-site.mjs

shots:
	$(NODE) ../scripts/snap-site.mjs --full --sections

list:
	@$(NODE) ../scripts/stage-site.mjs --list

stage:
	$(NODE) ../scripts/stage-site.mjs --out "$(STAGE)" --dmg "$(DMG)"

deploy: check-deps stage
	cd "$(STAGE)" && npx --yes wrangler@latest pages deploy . \
	    --project-name=$(PROJECT) \
	    --branch=$(BRANCH) \
	    --commit-dirty=true

verify:
	@echo "→ HEAD https://$(DOMAIN)"
	@curl -fsSI "https://$(DOMAIN)" | head -n 5 || echo "site not yet reachable"
