import { test } from "node:test";
import assert from "node:assert/strict";
import {
  homeParents, rootCandidates, accountUrl, historyUrl, runFileUrl, isGameRootUrl, isHomeCandidate,
  parsePastedPath, rootFromHome, describeRoot, RUN_FILE, RUN_KEY, PROFILE_DIR, STEAM_ID,
} from "../lib/paths.js";

test("looks for user folders in the right place on each system", () => {
  assert.deepEqual(homeParents("mac"), ["file:///Users/"]);
  assert.deepEqual(homeParents("win"), ["file:///C:/Users/"]);
  assert.deepEqual(homeParents("linux"), ["file:///home/"]);
  assert.deepEqual(homeParents("android"), []);
});

test("builds the game folder for each system, with the space in Application Support escaped", () => {
  assert.deepEqual(rootCandidates("mac", "file:///Users/ana/"), ["file:///Users/ana/Library/Application%20Support/SlayTheSpire2/"]);
  assert.deepEqual(rootCandidates("win", "file:///C:/Users/ana/"), ["file:///C:/Users/ana/AppData/Roaming/SlayTheSpire2/"]);
  assert.deepEqual(rootCandidates("linux", "file:///home/ana/"), [
    "file:///home/ana/.local/share/SlayTheSpire2/",
    "file:///home/ana/.var/app/com.valvesoftware.Steam/.local/share/SlayTheSpire2/",
  ]);
  assert.deepEqual(rootCandidates("other", "file:///x/"), []);
});

test("skips folders that are never a player's home", () => {
  for (const name of ["Shared", "Public", "Default", "Default User", "All Users", ".localized", "Guest"]) {
    assert.equal(isHomeCandidate(name), false, name);
  }
  assert.equal(isHomeCandidate("ana"), true);
});

test("builds account, history and run file URLs", () => {
  const root = "file:///Users/ana/Library/Application%20Support/SlayTheSpire2/";
  const account = accountUrl(root, "76561190000000001");
  assert.equal(account, `${root}steam/76561190000000001/`);
  assert.equal(historyUrl(account, "profile1"), `${account}profile1/saves/history/`);
  assert.equal(historyUrl(account, "modded/profile2"), `${account}modded/profile2/saves/history/`);
  assert.equal(runFileUrl(account, "profile1/saves/history/1777000000.run"), `${account}profile1/saves/history/1777000000.run`);
  assert.equal(runFileUrl(account, "modded/profile1/saves/history/my run.run"), `${account}modded/profile1/saves/history/my%20run.run`);
});

test("refuses a run file key that is not a run file in a history folder", () => {
  const account = "file:///x/SlayTheSpire2/steam/76561190000000001/";
  for (const key of [
    "profile1/saves/history/1.run.backup",
    "profile1/saves/current_run.save",
    "profile1/saves/history/../../../secrets.run",
    "../profile1/saves/history/1.run",
    "profile1/saves/history/sub/1.run",
    "/etc/hosts",
    "profile1\\saves\\history\\1.run",
  ]) {
    assert.equal(RUN_KEY.test(key), false, key);
    assert.equal(runFileUrl(account, key), null, key);
  }
});

test("matches run files but not their backups", () => {
  assert.equal(RUN_FILE.test("1777000000.run"), true);
  assert.equal(RUN_FILE.test("1777000000.run.backup"), false);
  assert.equal(RUN_FILE.test("progress.save"), false);
  assert.equal(PROFILE_DIR.test("profile12"), true);
  assert.equal(PROFILE_DIR.test("profile"), false);
  assert.equal(STEAM_ID.test("76561190000000001"), true);
  assert.equal(STEAM_ID.test("7656119000000000"), false);
});

test("accepts only roots that end in the game's own folder", () => {
  assert.equal(isGameRootUrl("file:///Users/ana/Library/Application%20Support/SlayTheSpire2/"), true);
  assert.equal(isGameRootUrl("file:///C:/Users/ana/AppData/Roaming/SlayTheSpire2/"), true);
  assert.equal(isGameRootUrl("file:///Users/ana/Documents/"), false);
  assert.equal(isGameRootUrl("file:///Users/ana/SlayTheSpire2"), false);
  assert.equal(isGameRootUrl("https://example.com/SlayTheSpire2/"), false);
  assert.equal(isGameRootUrl("file:///Users/ana/../bob/SlayTheSpire2/"), false);
  assert.equal(isGameRootUrl("file:///Users/ana/%2E%2E/SlayTheSpire2/"), false);
  assert.equal(isGameRootUrl("file:///C:/Users/ana/..%20/SlayTheSpire2/"), false, "Windows drops trailing dots and spaces");
  assert.equal(isGameRootUrl(undefined), false);
});

test("turns a pasted Windows path into the game folder's URL", () => {
  assert.deepEqual(parsePastedPath("C:\\Users\\Ana B\\AppData\\Roaming\\SlayTheSpire2"), {
    rootUrl: "file:///C:/Users/Ana%20B/AppData/Roaming/SlayTheSpire2/",
  });
  assert.deepEqual(parsePastedPath("d:\\Games\\SlayTheSpire2\\steam\\76561190000000001\\profile1\\saves\\history\\"), {
    rootUrl: "file:///D:/Games/SlayTheSpire2/",
  });
});

test("turns pasted macOS and Linux paths into the game folder's URL, wherever inside it they point", () => {
  assert.deepEqual(parsePastedPath("/Users/ana/Library/Application Support/SlayTheSpire2/steam/76561190000000001"), {
    rootUrl: "file:///Users/ana/Library/Application%20Support/SlayTheSpire2/",
  });
  assert.deepEqual(parsePastedPath('  "/home/ana/.local/share/SlayTheSpire2"  '), {
    rootUrl: "file:///home/ana/.local/share/SlayTheSpire2/",
  });
  assert.deepEqual(parsePastedPath("file:///Users/ana/Library/Application%20Support/SlayTheSpire2/"), {
    rootUrl: "file:///Users/ana/Library/Application%20Support/SlayTheSpire2/",
  });
  assert.deepEqual(parsePastedPath("file:///C:/Users/ana/AppData/Roaming/SlayTheSpire2/"), {
    rootUrl: "file:///C:/Users/ana/AppData/Roaming/SlayTheSpire2/",
  });
});

test("a path that starts with ~ or %APPDATA% is resolved against a user folder", () => {
  assert.deepEqual(parsePastedPath("~/Library/Application Support/SlayTheSpire2"), { needsHome: true, tail: ["Library", "Application Support"] });
  assert.deepEqual(parsePastedPath("%APPDATA%\\SlayTheSpire2\\steam"), { needsHome: true, tail: ["AppData", "Roaming"] });
  assert.equal(rootFromHome("file:///Users/ana/", ["Library", "Application Support"]), "file:///Users/ana/Library/Application%20Support/SlayTheSpire2/");
  assert.equal(rootFromHome("file:///C:/Users/ana/", ["AppData", "Roaming"]), "file:///C:/Users/ana/AppData/Roaming/SlayTheSpire2/");
});

test("refuses pasted paths that are not the game folder", () => {
  for (const input of ["", "   ", "/etc/passwd", "C:\\Windows\\System32", "/Users/ana/../bob/SlayTheSpire2", "C:\\Users\\ana\\.. \\SlayTheSpire2", "/Users/ana/.../SlayTheSpire2", "SlayTheSpire2", "relative/SlayTheSpire2", "x".repeat(2000), 42, null]) {
    assert.equal(parsePastedPath(input), null, String(input).slice(0, 40));
  }
});

test("describes a root as a path people recognize", () => {
  assert.equal(describeRoot("file:///Users/ana/Library/Application%20Support/SlayTheSpire2/"), "/Users/ana/Library/Application Support/SlayTheSpire2");
  assert.equal(describeRoot("file:///C:/Users/ana/AppData/Roaming/SlayTheSpire2/"), "C:\\Users\\ana\\AppData\\Roaming\\SlayTheSpire2");
  assert.equal(describeRoot("file:///etc/"), "");
});
