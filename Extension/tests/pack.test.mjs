import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { storeManifest } from "../scripts/pack.mjs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("the store build only talks to app.spirevault.app", () => {
  const store = storeManifest(manifest);
  assert.deepEqual(store.host_permissions, ["file:///*", "https://app.spirevault.app/*"]);
  assert.deepEqual(store.content_scripts[0].matches, ["https://app.spirevault.app/*"]);
  assert.equal(JSON.stringify(store).includes("127.0.0.1"), false);
  assert.deepEqual(manifest.host_permissions.length, 3, "the repo folder keeps the local origin for testing");
});

test("the manifest asks for nothing beyond what the extension uses", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "scripting"]);
  assert.equal(manifest.externally_connectable, undefined, "no other site or extension may message it");
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.content_scripts.length, 1);
  assert.equal(manifest.content_scripts[0].all_frames, undefined, "top frame only");
  assert.ok(manifest.description.length <= 132, "the store cuts descriptions at 132 characters");
});

test("the shipped code has no remote code, no eval and writes no HTML", () => {
  const files = ["background.js", "content.js", "popup.js", ...readdirSync(new URL("../lib/", import.meta.url)).map((name) => `lib/${name}`)];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(/\beval\s*\(|new Function\s*\(|importScripts\s*\(/.test(source), false, `${file}: no eval`);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), false, `${file}: no HTML writes`);
    assert.equal(/https?:\/\/(?!app\.spirevault\.app)/.test(source.replace(/\/\/.*$/gm, "")), false, `${file}: no other host`);
    assert.equal(/\bfetch\s*\(/.test(source) && file !== "background.js", false, `${file}: only the service worker reads files`);
    assert.equal(/method:\s*["'](POST|PUT|DELETE)/i.test(source), false, `${file}: never sends anything`);
  }
});
