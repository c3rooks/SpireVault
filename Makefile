# Spire Vault — top-level convenience targets that delegate to each
# sub-project's own Makefile. Quick reference:
#
#   make app                  Build + run the macOS app locally
#   make dmg                  Build the release .dmg
#   make site                 Deploy the marketing site to Cloudflare Pages
#   make web                  Deploy the web companion to Cloudflare Pages
#   make worker               Deploy the Cloudflare Worker backend
#   make screenshots-live     After dropping screenshots into
#                             Site/assets/screenshots/, swap them in,
#                             redeploy the site, commit, and push.
#   make smoke                Hit the live worker's public endpoints.

.PHONY: app dmg site web worker screenshots-live smoke

app:
	$(MAKE) -C VaultApp run

dmg:
	$(MAKE) -C VaultApp dmg

site:
	$(MAKE) -C Site deploy

web:
	$(MAKE) -C Web deploy

worker:
	$(MAKE) -C Backend deploy

screenshots-live:
	./scripts/swap-screenshots.sh

smoke:
	@echo "→ /          (health)"
	@curl -fsS https://vault-coop.coreycrooks.workers.dev/ && echo
	@echo
	@echo "→ /presence  (live feed)"
	@curl -fsS https://vault-coop.coreycrooks.workers.dev/presence | head -c 600
	@echo
