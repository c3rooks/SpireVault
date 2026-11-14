// Options and constants shared by the new-look end-to-end checks.
// Entry point: scripts/verify-ui-next-e2e.mjs

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";


/** @param {string} name @param {string} fallback */
export function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE = arg("base-url", "http://127.0.0.1:8788");
/** A second static server on a non-dev port, reached through a non-local hostname, runs the production boot path. */
export const PROD_PORT = Number(arg("prod-port", "8797"));
export const PROD_HOST = "spirevault-e2e.test";
export const OUR_ORIGINS = new Set([new URL(BASE).origin, `http://${PROD_HOST}:${PROD_PORT}`]);
export const OUT = arg("out", join(os.tmpdir(), "spirevault-e2e"));
export const ONLY = arg("only", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const SUBSET_SIZE = Number(arg("subset", "150"));
export const BOOT_TIMEOUT_MS = 25000;
export const IMPORT_TIMEOUT_MS = 60000;
export const SETTLE_MS = 350;
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 375, height: 812 };
export const TABS = ["overview", "characters", "ascensions", "relics", "cards", "runs", "coop", "highlights", "news", "beta", "settings"];
export const STATS_TABS = ["overview", "characters", "ascensions", "relics", "cards", "runs"];
export const THEMES = ["inked", "vault", "auto", "ironclad", "silent", "defect", "regent", "necrobinder"];
export const ROSTER = ["ironclad", "silent", "defect", "regent", "necrobinder"];
export const CLIMBERS = ["ironclad", "silent", "defect", "regent", "necrobinder", "fool"];
export const PHONE_BAR_TABS = ["overview", "characters", "runs", "coop"];
export const PHONE_SHEET_TABS = ["ascensions", "relics", "cards", "highlights", "news", "beta", "settings"];
export const RELIC_MIN_RUNS = 3;
export const RELIC_TOP_N = 15;
export const RUNS_PAGE = 20;
export const KEYBOARD_TAB_STOPS = 70;
