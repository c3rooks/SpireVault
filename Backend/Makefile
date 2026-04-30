.PHONY: install dev deploy tail logs kv-create secrets

# Install once after cloning.
install:
	npm install

# Local dev server. http://localhost:8787
dev:
	npx wrangler dev

# Ship to production.
deploy:
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
