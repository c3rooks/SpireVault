# Local development

The app on your machine is not a always-on server. When you close the terminal tab, put the Mac to sleep, or another tool grabs ports 8787/8788, the background `wrangler` processes stop and `localhost` looks “dead.” That is normal for local dev — production at app.spirevault.app is unaffected.

Start both services (API worker on 8787, web UI on 8788) with one command from the repo root: `./scripts/dev-local.sh`. It checks that `Web/.dev.vars` points `WORKER_ORIGIN_OVERRIDE` at `http://127.0.0.1:8787`, writes logs under `/tmp/spirevault-*.log`, and prints the URL to open. When you are done for the day, run `./scripts/dev-local-stop.sh`.

If the page loads but you are signed out or co-op looks empty, use the dev sign-in shortcut: `http://127.0.0.1:8788/api/_dev-login?as=c3rooks` (only works against this local stack, not production). If start fails, read the log files printed by the script or run the stop script and start again.
