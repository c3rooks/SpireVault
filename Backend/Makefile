.PHONY: install dev deploy tail logs kv-create secrets funnel verify preflight

# Install once after cloning.
install:
	npm install

# Local dev server. http://localhost:8787
dev:
	npx wrangler dev

# Type-check plus the offline logic suite. No network, no deployed Worker.
#
# The retention cohort math and the intent matcher are the two places where a
# mistake yields a believable wrong answer instead of an error — a cohort table
# that quietly reports 0% retention because the denominator includes users who
# signed up yesterday looks exactly like a product failure. These run before
# every deploy so that never ships.
preflight:
	npx tsc --noEmit -p tsconfig.json
	node scripts/verify-offline.mjs

# Ship to production.
deploy: preflight
	npx wrangler deploy

# Live-tail production logs.
tail:
	npx wrangler tail

logs: tail

# Create the KV namespaces. Paste the IDs into wrangler.toml.
kv-create:
	npx wrangler kv:namespace create LOBBIES
	npx wrangler kv:namespace create LOBBIES --preview

# Set the Steam Web API key as a Cloudflare secret.
secrets:
	@echo "Get a Steam Web API key at https://steamcommunity.com/dev/apikey"
	npx wrangler secret put STEAM_WEB_API_KEY

# Print the live sign-in funnel (start → cb-attempt → cb-ok → roster).
# Reads KV directly so no admin token needed. Pass YYYYMMDD for a past day.
funnel:
	@./scripts/funnel.sh $(filter-out $@,$(MAKECMDGOALS))

# End-to-end roster persistence + visibility check against production.
verify:
	@node scripts/verify-roster.mjs
