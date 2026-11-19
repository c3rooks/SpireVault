import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageRequest, isAllowedOrigin } from "../lib/messages.js";

const STORE = ["https://app.spirevault.app/*"];
const DEV = ["https://app.spirevault.app/*", "http://127.0.0.1/*"];

test("accepts the requests a SpireVault page makes", () => {
  assert.deepEqual(parsePageRequest({ type: "status" }), { type: "status" });
  assert.deepEqual(parsePageRequest({ type: "open-settings", extra: 1 }), { type: "open-settings" });
  assert.deepEqual(parsePageRequest({ type: "forget-folder" }), { type: "forget-folder" });
  assert.deepEqual(parsePageRequest({ type: "sync", steamId: "76561190000000001", known: {} }), { type: "sync", steamId: "76561190000000001", known: {} });
  assert.deepEqual(parsePageRequest({ type: "sync" }), { type: "sync", steamId: "", known: {} });
  assert.deepEqual(parsePageRequest({ type: "set-folder", path: "C:\\x\\SlayTheSpire2" }), { type: "set-folder", path: "C:\\x\\SlayTheSpire2" });
});

test("drops fields it does not read, so a page cannot pass a URL to fetch", () => {
  const parsed = parsePageRequest({ type: "sync", steamId: "", known: {}, url: "file:///etc/passwd", root: "file:///" });
  assert.deepEqual(Object.keys(parsed).sort(), ["known", "steamId", "type"]);
});

test("refuses anything else", () => {
  for (const message of [
    null, undefined, "sync", 7, [], {},
    { type: "read", url: "file:///etc/passwd" },
    { type: "sync", steamId: "not-an-id" },
    { type: "sync", steamId: "../../../etc" },
    { type: "sync", steamId: 76561190000000001 },
    { type: "sync", known: { "../../etc/passwd": [1, 1] } },
    { type: "sync", known: "all" },
    { type: "set-folder" },
    { type: "set-folder", path: "" },
    { type: "set-folder", path: "x".repeat(2000) },
    { type: "set-folder", path: 5 },
  ]) {
    assert.equal(parsePageRequest(message), null, JSON.stringify(message));
  }
});

test("only SpireVault origins from the manifest may ask", () => {
  assert.equal(isAllowedOrigin("https://app.spirevault.app", STORE), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8795", STORE), false, "the store build has no local origin");
  assert.equal(isAllowedOrigin("http://127.0.0.1:8795", DEV), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1", DEV), true);
  for (const origin of [
    "http://app.spirevault.app", "https://app.spirevault.app.evil.com", "https://evil.com", "https://spirevault.app",
    "https://127.0.0.1:8795", "http://localhost:8795", "file://", "null", "", "https://app.spirevault.app/path", undefined,
    "https://app.spirevault.app:8443",
  ]) {
    assert.equal(isAllowedOrigin(origin, DEV), false, String(origin));
  }
  assert.equal(isAllowedOrigin("https://app.spirevault.app", undefined), false);
  assert.equal(isAllowedOrigin("https://evil.com", ["<all_urls>", "*://*/*"]), false, "wildcard patterns allow nobody");
});
