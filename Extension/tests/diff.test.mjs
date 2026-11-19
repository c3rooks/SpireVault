import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRunFiles, takeBatch, sanitizeKnown, MAX_FILE_BYTES, MAX_KNOWN_ENTRIES } from "../lib/diff.js";

const key = (n, profile = "profile1") => `${profile}/saves/history/${n}.run`;
const file = (n, size = 100, mtime = n) => ({ key: key(n), size, mtime });

test("everything is new when the page holds nothing", () => {
  const { changed, tooBig, gone } = diffRunFiles([file(3), file(1), file(2)], {});
  assert.deepEqual(changed.map((f) => f.key), [key(1), key(2), key(3)], "oldest first");
  assert.deepEqual(tooBig, []);
  assert.deepEqual(gone, []);
});

test("only files the page lacks, or that changed size or time, come back", () => {
  const known = { [key(1)]: [100, 1], [key(2)]: [100, 2], [key(3)]: [100, 3] };
  const listed = [file(1), file(2, 150), file(3, 100, 99), file(4)];
  assert.deepEqual(diffRunFiles(listed, known).changed.map((f) => f.key), [key(2), key(4), key(3)]);
});

test("nothing comes back when nothing changed", () => {
  const known = { [key(1)]: [100, 1], [key(2)]: [100, 2] };
  assert.deepEqual(diffRunFiles([file(1), file(2)], known), { changed: [], tooBig: [], gone: [] });
});

test("files removed from disk are reported so the page can forget them", () => {
  const known = { [key(1)]: [100, 1], [key(9)]: [100, 9] };
  assert.deepEqual(diffRunFiles([file(1)], known).gone, [key(9)]);
});

test("a file over the size cap is set aside, not read", () => {
  const big = file(5, MAX_FILE_BYTES + 1);
  const { changed, tooBig } = diffRunFiles([file(1), big], {});
  assert.deepEqual(changed.map((f) => f.key), [key(1)]);
  assert.deepEqual(tooBig, [big]);
});

test("entries that are not run files in a history folder are ignored", () => {
  const listed = [file(1), { key: "profile1/saves/history/1.run.backup", size: 1, mtime: 1 }, { key: "../x.run", size: 1, mtime: 1 }, null];
  assert.deepEqual(diffRunFiles(listed, {}).changed.map((f) => f.key), [key(1)]);
});

test("a known record with odd keys cannot shadow a real file", () => {
  const known = Object.create({ [key(1)]: [100, 1] });
  assert.deepEqual(diffRunFiles([file(1)], known).changed.map((f) => f.key), [key(1)]);
});

test("a batch stops at the file limit and at the byte limit", () => {
  const files = [file(1, 400), file(2, 400), file(3, 400)];
  assert.deepEqual(takeBatch(files, { maxBytes: 900, maxFiles: 10 }), { batch: files.slice(0, 2), hasMore: true });
  assert.deepEqual(takeBatch(files, { maxBytes: 10_000, maxFiles: 1 }), { batch: files.slice(0, 1), hasMore: true });
  assert.deepEqual(takeBatch(files, { maxBytes: 10_000, maxFiles: 10 }), { batch: files, hasMore: false });
  assert.deepEqual(takeBatch([file(1, 5000)], { maxBytes: 900, maxFiles: 10 }).batch.length, 1, "one oversized file still goes alone");
  assert.deepEqual(takeBatch([]), { batch: [], hasMore: false });
});

test("a known record from the page is checked entry by entry", () => {
  assert.deepEqual(sanitizeKnown(undefined), {});
  assert.deepEqual(sanitizeKnown({ [key(1)]: [100, 1] }), { [key(1)]: [100, 1] });
  assert.equal(sanitizeKnown([]), null);
  assert.equal(sanitizeKnown("x"), null);
  assert.equal(sanitizeKnown({ "../../etc/passwd": [1, 1] }), null);
  assert.equal(sanitizeKnown({ [key(1)]: [100] }), null);
  assert.equal(sanitizeKnown({ [key(1)]: ["100", 1] }), null);
  assert.equal(sanitizeKnown({ [key(1)]: [-1, 1] }), null);
  assert.equal(sanitizeKnown({ [key(1)]: [1.5, 1] }), null);
  const tooMany = Object.fromEntries(Array.from({ length: MAX_KNOWN_ENTRIES + 1 }, (_, i) => [key(i), [1, 1]]));
  assert.equal(sanitizeKnown(tooMany), null);
});
