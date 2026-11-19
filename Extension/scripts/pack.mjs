#!/usr/bin/env node
/**
 * Builds the zip that goes to the Chrome Web Store and Edge Add-ons.
 *
 *   node Extension/scripts/pack.mjs            → Extension/dist/spirevault-sync-<version>.zip
 *
 * The folder in the repo is the development build: it also answers pages on
 * http://127.0.0.1 so a local copy of SpireVault can be tested. The store
 * build must only ever talk to https://app.spirevault.app, so this script
 * takes the local origin out of the manifest and leaves out everything that
 * is not part of the extension (tests, this script, docs). There is no other
 * build step: the code files are copied byte for byte.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Everything the store build contains. Anything not listed stays out. */
const SHIPPED = ["background.js", "content.js", "popup.html", "popup.css", "popup.js", "lib", "icons"];
const STORE_ORIGIN = "https://app.spirevault.app/*";
const isStoreOrigin = (pattern) => pattern === STORE_ORIGIN || pattern === "file:///*";

/** The manifest as the stores get it: no local test origin anywhere. */
export function storeManifest(manifest) {
  return {
    ...manifest,
    host_permissions: manifest.host_permissions.filter(isStoreOrigin),
    content_scripts: manifest.content_scripts.map((script) => ({ ...script, matches: script.matches.filter(isStoreOrigin) })),
  };
}

function main() {
  const manifest = storeManifest(JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")));
  const text = JSON.stringify(manifest, null, 2);
  if (/127\.0\.0\.1|localhost/.test(text)) throw new Error("the store manifest still names a local origin");
  if (manifest.content_scripts.some((script) => script.matches.length !== 1)) throw new Error("the store build must match exactly one origin");

  const stage = mkdtempSync(join(tmpdir(), "spirevault-sync-pack-"));
  try {
    for (const entry of SHIPPED) cpSync(join(EXTENSION, entry), join(stage, entry), { recursive: true });
    writeFileSync(join(stage, "manifest.json"), `${text}\n`);
    const dist = join(EXTENSION, "dist");
    mkdirSync(dist, { recursive: true });
    const zip = join(dist, `spirevault-sync-${manifest.version}.zip`);
    rmSync(zip, { force: true });
    execFileSync("zip", ["-r", "-X", "-q", zip, ".", "-x", "*.DS_Store"], { cwd: stage });
    process.stdout.write(`${zip}\n`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
