# Site/Makefile — operational targets for the landing page.
#
#   make dev       → preview locally on http://127.0.0.1:8788
#   make deploy    → deploy to Cloudflare Pages (project: vault-site)
#   make verify    → quick smoke check that the live site responds 200

PROJECT ?= vault-site
DOMAIN  ?= spirevault.app

.PHONY: dev deploy verify check-deps

check-deps:
	@command -v npx >/dev/null || (echo "npx (Node.js) is required" >&2; exit 1)

dev: check-deps
	npx --yes wrangler@latest pages dev .

deploy: check-deps
	npx --yes wrangler@latest pages deploy . \
	    --project-name=$(PROJECT) \
	    --branch=main \
	    --commit-dirty=true

verify:
	@echo "→ HEAD https://$(DOMAIN)"
	@curl -fsSI "https://$(DOMAIN)" | head -n 5 || echo "site not yet reachable"
