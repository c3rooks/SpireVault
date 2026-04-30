PROJECT ?= vault-web
DOMAIN  ?= app.spirevault.app

.PHONY: dev deploy verify

dev:
	npx --yes wrangler@latest pages dev .

deploy:
	npx --yes wrangler@latest pages deploy . \
	    --project-name=$(PROJECT) \
	    --branch=main \
	    --commit-dirty=true

verify:
	@echo "→ HEAD https://$(DOMAIN)"
	@curl -fsSI "https://$(DOMAIN)" | head -n 5 || echo "site not yet reachable"
