import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDisk, fakeStore, loadTree } from "./helpers/fake-disk.mjs";
import { locateSaves, listRunFiles, syncOnce, setPastedFolder, forgetFolders, STORE_ROOT, STORE_PASTED } from "../lib/sync.js";

const ME = "76561190000000001";
const OTHER = "76561190000000002";
const game = () => loadTree(new URL("./fixtures/saves/SlayTheSpire2", import.meta.url).pathname);

const macDisk = () => fakeDisk({
  Users: { ".localized": "", Shared: {}, tester: { Library: { "Application Support": { SlayTheSpire2: game() } }, Documents: { "taxes.txt": "private" } } },
  etc: { hosts: "127.0.0.1 localhost" },
});
const winDisk = () => fakeDisk({
  "C:": { Users: { Public: {}, Default: {}, tester: { AppData: { Roaming: { SlayTheSpire2: game() } } } } },
});
const linuxDisk = () => fakeDisk({
  home: { tester: { ".local": { share: { SlayTheSpire2: game() } } } },
});

const MAC_ROOT = "file:///Users/tester/Library/Application%20Support/SlayTheSpire2/";
const keys = (files) => files.map((f) => f.key).sort();

test("finds the save folder on macOS for the signed-in account and remembers it", async () => {
  const disk = macDisk();
  const store = fakeStore();
  const found = await locateSaves({ readUrl: disk.readUrl, store, os: "mac" }, ME);
  assert.deepEqual(found, { ok: true, rootUrl: MAC_ROOT, steamId: ME });
  assert.equal(store.data.get(STORE_ROOT), MAC_ROOT);
});

test("finds the save folder on Windows and Linux (paths not yet confirmed on real machines)", async () => {
  const win = await locateSaves({ readUrl: winDisk().readUrl, store: fakeStore(), os: "win" }, ME);
  assert.deepEqual(win, { ok: true, rootUrl: "file:///C:/Users/tester/AppData/Roaming/SlayTheSpire2/", steamId: ME });
  const linux = await locateSaves({ readUrl: linuxDisk().readUrl, store: fakeStore(), os: "linux" }, ME);
  assert.deepEqual(linux, { ok: true, rootUrl: "file:///home/tester/.local/share/SlayTheSpire2/", steamId: ME });
});

test("finds a Flatpak Steam install on Linux", async () => {
  const disk = fakeDisk({ home: { deck: { ".var": { app: { "com.valvesoftware.Steam": { ".local": { share: { SlayTheSpire2: game() } } } } } } } });
  const found = await locateSaves({ readUrl: disk.readUrl, store: fakeStore(), os: "linux" }, ME);
  assert.equal(found.ok && found.rootUrl, "file:///home/deck/.var/app/com.valvesoftware.Steam/.local/share/SlayTheSpire2/");
});

test("uses the remembered folder without listing user folders again", async () => {
  const disk = macDisk();
  const store = fakeStore({ [STORE_ROOT]: MAC_ROOT });
  await locateSaves({ readUrl: disk.readUrl, store, os: "mac" }, ME);
  assert.equal(disk.reads.includes("file:///Users/"), false);
});

test("signed out, it takes the account folder used most recently", async () => {
  const disk = macDisk();
  disk.setMtime(`/Users/tester/Library/Application Support/SlayTheSpire2/steam/${OTHER}`, 1_800_000_000);
  const found = await locateSaves({ readUrl: disk.readUrl, store: fakeStore(), os: "mac" }, "");
  assert.equal(found.ok && found.steamId, OTHER);
});

test("signed in, it never falls back to another account's saves", async () => {
  const found = await locateSaves({ readUrl: macDisk().readUrl, store: fakeStore(), os: "mac" }, "76561190000000009");
  assert.deepEqual(found, { ok: false, reason: "no-account-folder" });
});

test("says so when the game folder is not there at all", async () => {
  const disk = fakeDisk({ Users: { tester: { Library: {} } } });
  assert.deepEqual(await locateSaves({ readUrl: disk.readUrl, store: fakeStore(), os: "mac" }, ME), { ok: false, reason: "no-save-folder" });
  const blocked = { readUrl: async () => ({ ok: false }), store: fakeStore(), os: "mac" };
  assert.deepEqual(await locateSaves(blocked, ME), { ok: false, reason: "no-save-folder" }, "file access off looks the same");
});

test("lists every profile and the modded save set, and skips backups and other files", async () => {
  const disk = macDisk();
  const { files, profiles } = await listRunFiles(disk.readUrl, `${MAC_ROOT}steam/${ME}/`);
  assert.deepEqual(keys(files), [
    "modded/profile1/saves/history/1777020000.run",
    "profile1/saves/history/1777000000.run",
    "profile1/saves/history/1777003600.run",
    "profile2/saves/history/1777010000.run",
  ]);
  assert.deepEqual(profiles.sort(), ["modded/profile1", "profile1", "profile2"]);
});

test("a first sync hands over every run, with the text exactly as on disk", async () => {
  const disk = macDisk();
  const result = await syncOnce({ readUrl: disk.readUrl, store: fakeStore(), os: "mac" }, { steamId: ME, known: {} });
  assert.equal(result.ok, true);
  assert.equal(result.runFiles, 4);
  assert.equal(result.hasMore, false);
  assert.equal(result.folder, "/Users/tester/Library/Application Support/SlayTheSpire2");
  assert.equal(result.files.length, 4);
  const first = result.files.find((f) => f.key === "profile1/saves/history/1777000000.run");
  assert.equal(first.name, "1777000000.run");
  assert.equal(JSON.parse(first.text).start_time, 1777000000);
  assert.equal(first.size, Buffer.byteLength(first.text));
});

test("a second sync with the page's record hands over nothing, then only the new run", async () => {
  const tree = { Users: { tester: { Library: { "Application Support": { SlayTheSpire2: game() } } } } };
  const disk = fakeDisk(tree);
  const deps = { readUrl: disk.readUrl, store: fakeStore(), os: "mac" };
  const first = await syncOnce(deps, { steamId: ME, known: {} });
  const known = Object.fromEntries(first.files.map((f) => [f.key, [f.size, f.mtime]]));

  const again = await syncOnce(deps, { steamId: ME, known });
  assert.equal(again.files.length, 0);
  assert.equal(again.runFiles, 4);

  const history = tree.Users.tester.Library["Application Support"].SlayTheSpire2.steam[ME].profile1.saves.history;
  history["1777099999.run"] = history["1777000000.run"].replace("1777000000", "1777099999");
  const after = await syncOnce(deps, { steamId: ME, known });
  assert.deepEqual(after.files.map((f) => f.key), ["profile1/saves/history/1777099999.run"]);
  assert.equal(after.runFiles, 5);
});

test("a run deleted from disk is reported as gone", async () => {
  const disk = macDisk();
  const known = { "profile1/saves/history/1600000000.run": [10, 10] };
  const result = await syncOnce({ readUrl: disk.readUrl, store: fakeStore(), os: "mac" }, { steamId: ME, known });
  assert.deepEqual(result.gone, ["profile1/saves/history/1600000000.run"]);
});

test("a file that cannot be read is left out, not recorded, and asked for again next time", async () => {
  const disk = macDisk();
  let isBlocked = true;
  const readUrl = async (url) => (isBlocked && url.endsWith("1777003600.run") ? { ok: false } : disk.readUrl(url));
  const deps = { readUrl, store: fakeStore(), os: "mac" };
  const result = await syncOnce(deps, { steamId: ME, known: {} });
  assert.equal(result.files.length, 3);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.skipped, []);
  const known = Object.fromEntries(result.files.map((f) => [f.key, [f.size, f.mtime]]));
  isBlocked = false;
  const next = await syncOnce(deps, { steamId: ME, known });
  assert.deepEqual(next.files.map((f) => f.key), ["profile1/saves/history/1777003600.run"]);
});

test("unreadable files at the front do not hold up the readable ones behind them", async () => {
  const history = {};
  for (let i = 0; i < 450; i += 1) history[`${1700000000 + i}.run`] = JSON.stringify({ start_time: 1700000000 + i });
  const disk = fakeDisk({ Users: { tester: { Library: { "Application Support": { SlayTheSpire2: { steam: { [ME]: { profile1: { saves: { history } } } } } } } } } });
  // The first 400 (one whole batch) cannot be read.
  const readUrl = async (url) => {
    const match = /\/(\d+)\.run$/.exec(url);
    return match && Number(match[1]) < 1700000400 ? { ok: false } : disk.readUrl(url);
  };
  const result = await syncOnce({ readUrl, store: fakeStore(), os: "mac" }, { steamId: ME, known: {} });
  assert.equal(result.files.length, 50);
  assert.equal(result.hasMore, false);
});

test("a history folder that could not be listed forgets nothing", async () => {
  const disk = macDisk();
  const known = {
    "profile1/saves/history/1600000000.run": [10, 10],
    "profile2/saves/history/1600000001.run": [10, 10],
  };
  const readUrl = async (url) => (url.endsWith("/profile2/saves/history/") ? { ok: false } : disk.readUrl(url));
  const result = await syncOnce({ readUrl, store: fakeStore(), os: "mac" }, { steamId: ME, known });
  assert.deepEqual(result.gone, ["profile1/saves/history/1600000000.run"], "only the folder that was listed can report a file gone");
});

test("reads nothing outside the game folder except the list of user folders", async () => {
  const disk = macDisk();
  await syncOnce({ readUrl: disk.readUrl, store: fakeStore(), os: "mac" }, { steamId: ME, known: {} });
  for (const url of disk.reads) {
    assert.ok(url === "file:///Users/" || url.startsWith(MAC_ROOT), `unexpected read: ${url}`);
    assert.equal(/\.run\.backup$|\.save$|\.txt$/.test(url), false, `not a run file: ${url}`);
  }
  assert.ok(disk.reads.length > 5);
});

test("a pasted folder is used when it holds the game's saves, from anywhere inside it", async () => {
  const disk = fakeDisk({ "D:": { Games: { SlayTheSpire2: game() } }, "C:": { Users: { tester: {} } } });
  const store = fakeStore();
  const deps = { readUrl: disk.readUrl, store, os: "win" };
  assert.deepEqual(await locateSaves(deps, ME), { ok: false, reason: "no-save-folder" });
  const set = await setPastedFolder(deps, "D:\\Games\\SlayTheSpire2\\steam\\76561190000000001\\profile1");
  assert.deepEqual(set, { ok: true, folder: "D:\\Games\\SlayTheSpire2" });
  assert.equal(store.data.get(STORE_PASTED), "file:///D:/Games/SlayTheSpire2/");
  const found = await locateSaves(deps, ME);
  assert.equal(found.ok && found.rootUrl, "file:///D:/Games/SlayTheSpire2/");
});

test("a pasted %APPDATA% or ~ path is tried under each user folder", async () => {
  const win = { readUrl: winDisk().readUrl, store: fakeStore(), os: "win" };
  assert.deepEqual(await setPastedFolder(win, "%APPDATA%\\SlayTheSpire2"), { ok: true, folder: "C:\\Users\\tester\\AppData\\Roaming\\SlayTheSpire2" });
  const mac = { readUrl: macDisk().readUrl, store: fakeStore(), os: "mac" };
  assert.deepEqual(await setPastedFolder(mac, "~/Library/Application Support/SlayTheSpire2"), { ok: true, folder: "/Users/tester/Library/Application Support/SlayTheSpire2" });
});

test("a pasted folder that is not the game's is refused and nothing is remembered", async () => {
  const disk = macDisk();
  const store = fakeStore();
  const deps = { readUrl: disk.readUrl, store, os: "mac" };
  assert.deepEqual(await setPastedFolder(deps, "/Users/tester/Documents"), { ok: false, reason: "bad-path" });
  assert.deepEqual(await setPastedFolder(deps, "/etc/SlayTheSpire2"), { ok: false, reason: "no-save-folder" });
  assert.equal(store.data.size, 0);
  assert.equal(disk.reads.some((url) => url.includes("Documents")), false);
});

test("forgetting folders clears both the pasted one and the one found automatically", async () => {
  const store = fakeStore({ [STORE_ROOT]: MAC_ROOT, [STORE_PASTED]: MAC_ROOT });
  await forgetFolders({ readUrl: macDisk().readUrl, store, os: "mac" });
  assert.equal(store.data.size, 0);
});
