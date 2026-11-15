/**
 * Starts scripts/dev-site.mjs for the landing-page checks and captures, on a
 * port that is actually free. Other tools on this machine come and go on the
 * same port numbers (a local Worker took the checks' usual one mid-run), so
 * the preferred port is only a preference.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 30_000;

/**
 * The preferred port if nothing is listening on it, else one the system picks.
 * @param {number} preferred
 * @returns {Promise<number>}
 */
function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => {
      const any = createServer();
      any.once("error", reject);
      any.listen(0, HOST, () => {
        const { port } = /** @type {import("node:net").AddressInfo} */ (any.address());
        any.close(() => resolve(port));
      });
    });
    probe.listen(preferred, HOST, () => probe.close(() => resolve(preferred)));
  });
}

/**
 * @param {number} preferredPort
 * @returns {Promise<{ baseUrl: string, stop: () => void }>}
 */
export async function startSiteServer(preferredPort) {
  const port = await freePort(preferredPort);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "scripts", "dev-site.mjs"), String(port)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("the server did not start within 30s"), START_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (settled || !String(chunk).includes("serving")) return;
      settled = true;
      clearTimeout(timer);
      resolve({ baseUrl: `http://${HOST}:${port}`, stop: () => child.kill() });
    });
    child.stderr.on("data", (chunk) => fail(`dev-site did not start: ${String(chunk).trim()}`));
    child.on("exit", (code) => fail(`dev-site exited early (code ${code})`));
  });
}
