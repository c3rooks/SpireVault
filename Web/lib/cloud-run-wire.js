// cloud-run-wire.js
// =========================================================================
// The Steam copy of a player's runs: how one parsed run is written for
// POST /api/runs and read back from GET /api/runs.
//
// A signed-in player's other devices (a phone, a second browser, any browser
// that has not read the save folder) show nothing but this copy. So it has to
// carry what the tabs show, not only the totals: card picks (Cards, the run
// sheet), whether a run was abandoned, its mode and modifiers, whether it was
// a Custom Run (left out of win streaks), its party and the rooms it walked
// (the act timeline).
//
// Until 2026-11-18 the upload read `run.cardChoices`, a field the parser
// never wrote (it writes `cardPicks`), so every copy held no card picks and
// those devices showed an empty Cards tab.
//
// Card picks and rooms travel as one short string per run, not as nested
// objects. The Worker parses and re-writes a player's whole copy on every
// upload inside a 10 ms processor budget (Workers Free); measured live on
// 2026-11-18, the 726-run copy without card picks already cost 3 to 4 ms
// to read back. Objects for 8,000 reward screens would have more than
// doubled that; strings add almost nothing.
//
// The server (Backend/src/runs.ts, sanitizeRun) keeps only the fields it
// knows and applies the same limits. Pure and import-free, so
// Web/scripts/verify-cloud-run-wire.mjs loads it straight into Node.
// =========================================================================

/** Per-run limits, matched by the server. */
export const LIMITS = Object.freeze({
  relics: 64,
  deck: 256,
  /** Card reward screens kept per run. A long run has about 30. */
  choices: 60,
  /** Cards kept per reward screen besides the picked one. Real saves hold offers of 30. */
  skipped: 32,
  /** Length of one run's `picks` string. A long real run is about 1,500. */
  picksChars: 8000,
  modifiers: 16,
  acts: 12,
  roomsPerAct: 80,
  party: 8,
});

/** One letter per room, so a 50-room run costs 50 bytes. */
const ROOM_CODES = Object.freeze({
  combat: "c",
  elite: "e",
  shop: "s",
  rest: "r",
  event: "v",
  chest: "t",
  boss: "b",
  unknown: "u",
});
const ROOM_TYPES = Object.freeze(Object.fromEntries(Object.entries(ROOM_CODES).map(([type, code]) => [code, type])));
const UNKNOWN_ROOM = "unknown";

/** @param {unknown} value @returns {string | undefined} */
function textOrNothing(value) {
  return value ? String(value) : undefined;
}

/** @param {unknown} value @returns {string | undefined} */
function isoOrNothing(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** @param {unknown} list @param {number} max @returns {string[]} */
function strings(list, max) {
  return Array.isArray(list) ? list.slice(0, max).map(String) : [];
}

const SCREEN_SEPARATOR = ";";
const FLOOR_SEPARATOR = ":";
const PICKED_SEPARATOR = "|";
const CARD_SEPARATOR = ",";
const MAX_CARD_ID_CHARS = 64;
/** What encodeURIComponent leaves alone but the server's `picks` pattern does not allow. */
const ALSO_ESCAPED = /[!~*'()]/g;

/** @param {unknown} card @returns {card is string} */
function isCardId(card) {
  return typeof card === "string" && card.length > 0 && card.length <= MAX_CARD_ID_CHARS;
}

/**
 * A card id as it sits in `picks`. The game's own ids are plain
 * (`song_path`), and travel as they are; anything else (a mod's
 * `mymod:Big Card`) is percent-escaped, so no id can be mistaken for a
 * separator and none has to be left out.
 * @param {string} card @returns {string} "" when the id cannot be written
 */
function escapeCard(card) {
  try {
    return encodeURIComponent(card).replace(ALSO_ESCAPED, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return ""; // a lone surrogate: not text any save holds
  }
}

/** @param {string} text @returns {string | null} the card id, or null when the text is not one */
function unescapeCard(text) {
  if (!text) return null;
  try {
    const card = decodeURIComponent(text);
    return isCardId(card) ? card : null;
  } catch {
    return null;
  }
}

/**
 * The parser's card picks (`{ floor, offered, picked, source }`) as one
 * string: reward screens joined by ";", each `floor:picked|skipped,skipped`.
 * A skipped reward has nothing before the "|".
 * @param {any} run @returns {string | undefined}
 */
function picksToWire(run) {
  if (!Array.isArray(run.cardPicks)) return undefined;
  const screens = [];
  let length = 0;
  for (const pick of run.cardPicks.slice(0, LIMITS.choices)) {
    const picked = isCardId(pick?.picked) ? pick.picked : "";
    const offered = Array.isArray(pick?.offered) ? pick.offered.filter(isCardId) : [];
    const skipped = offered.filter((card) => card !== picked).slice(0, LIMITS.skipped).map(escapeCard).filter(Boolean);
    if (!picked && skipped.length === 0) continue;
    const floor = Math.max(0, Math.floor(Number(pick?.floor) || 0));
    const screen = `${floor}${FLOOR_SEPARATOR}${escapeCard(picked)}${PICKED_SEPARATOR}${skipped.join(CARD_SEPARATOR)}`;
    // Whole screens only: a cut-off one would read back as a different offer.
    if (length + screen.length + 1 > LIMITS.picksChars) break;
    screens.push(screen);
    length += screen.length + 1;
  }
  return screens.length ? screens.join(SCREEN_SEPARATOR) : undefined;
}

/** The rooms walked, one string per act. @param {any} run @returns {string[] | undefined} */
function pathToWire(run) {
  if (!Array.isArray(run.pathByAct) || run.pathByAct.length === 0) return undefined;
  return run.pathByAct.slice(0, LIMITS.acts).map((act) => {
    const nodes = Array.isArray(act?.nodes) ? act.nodes.slice(0, LIMITS.roomsPerAct) : [];
    return nodes.map((node) => ROOM_CODES[node?.type] ?? ROOM_CODES[UNKNOWN_ROOM]).join("");
  });
}

/**
 * One loaded run as the server stores it. Dates become ISO strings; anything
 * the server does not keep is left out.
 * @param {any} run a run from lib/sts2-run-parser.js, or one read back from the copy
 */
export function toWire(run) {
  const partySize = Number.isFinite(run.partySize) ? Math.max(1, Math.min(LIMITS.party, Math.floor(run.partySize))) : undefined;
  const modifiers = strings(run.modifiers, LIMITS.modifiers);
  return {
    id: String(run.id || ""),
    character: String(run.character || ""),
    ascension: Number(run.ascension) || 0,
    floorReached: Number(run.floorReached) || 0,
    won: run.won === true,
    playTimeSeconds: Number(run.playTimeSeconds) || 0,
    endedAt: isoOrNothing(run.endedAt) ?? new Date().toISOString(),
    startedAt: isoOrNothing(run.startedAt),
    seed: textOrNothing(run.seed),
    killedBy: textOrNothing(run.killedBy),
    relics: strings(run.relics, LIMITS.relics),
    deckAtEnd: strings(run.deckAtEnd, LIMITS.deck),
    picks: picksToWire(run),
    neowBonus: textOrNothing(run.neowBonus),
    gameMode: typeof run.gameMode === "string" && run.gameMode ? run.gameMode.toLowerCase() : undefined,
    wasAbandoned: run.wasAbandoned === true ? true : undefined,
    isCustom: run.isCustom === true ? true : undefined,
    modifiers: modifiers.length ? modifiers : undefined,
    path: pathToWire(run),
    partySize,
    // A party of one is the run's own character; only a co-op party is spelled out.
    party: partySize && partySize > 1 && Array.isArray(run.party)
      ? run.party.slice(0, LIMITS.party).map((climber) => (typeof climber === "string" ? climber : ""))
      : undefined,
    // Which of the party this record is told from (lib/run-owner.js). Only a
    // co-op run whose reader knew the local player has it; a record without
    // it may show a teammate's climber, and gives way to one that has it.
    seat: knownSeat(run, partySize),
  };
}

/**
 * @param {any} run @param {number | undefined} partySize
 * @returns {number | undefined} the local player's place in a co-op party, when known
 */
function knownSeat(run, partySize) {
  if (!partySize || partySize < 2) return undefined;
  return Number.isInteger(run?.seat) && run.seat >= 0 && run.seat < partySize ? run.seat : undefined;
}

/** Whether a record says whose side of the run it tells: always, for a solo run. @param {any} run a loaded run */
export function hasSeat(run) {
  return !(Number.isFinite(run?.partySize) && run.partySize > 1) || knownSeat(run, run.partySize) !== undefined;
}

/** Whether two records of one run tell the same player's side. A record that
 *  does not say tells the first player's: that is who every reader takes when
 *  it cannot tell. @param {any} a @param {any} b loaded runs */
function sameSide(a, b) {
  const sideOf = (run) => knownSeat(run, run?.partySize) ?? 0;
  return sideOf(a) === sideOf(b);
}

/** @param {unknown} path @returns {Array<{ act: number, nodes: Array<{ floor: number, type: string }> }>} */
function pathFromWire(path) {
  if (!Array.isArray(path)) return [];
  let floor = 0;
  return path.slice(0, LIMITS.acts).map((rooms, index) => ({
    act: index + 1,
    nodes: (typeof rooms === "string" ? [...rooms.slice(0, LIMITS.roomsPerAct)] : []).map((code) => {
      floor += 1;
      return { floor, type: ROOM_TYPES[code] ?? UNKNOWN_ROOM };
    }),
  }));
}

/** @param {number} floor @param {string | null} picked @param {string[]} skipped @param {Map<number, string>} roomByFloor */
function loadedPick(floor, picked, skipped, roomByFloor) {
  return {
    floor,
    offered: picked ? [picked, ...skipped] : skipped,
    picked,
    source: roomByFloor.get(floor) ?? UNKNOWN_ROOM,
  };
}

/**
 * @param {unknown} text the server's `picks` string
 * @param {Map<number, string>} roomByFloor
 */
function picksFromText(text, roomByFloor) {
  if (typeof text !== "string" || !text) return [];
  const picks = [];
  for (const screen of text.split(SCREEN_SEPARATOR).slice(0, LIMITS.choices)) {
    const floorEnd = screen.indexOf(FLOOR_SEPARATOR);
    const pickedEnd = screen.indexOf(PICKED_SEPARATOR, floorEnd + 1);
    if (floorEnd < 0 || pickedEnd < 0) continue;
    const picked = unescapeCard(screen.slice(floorEnd + 1, pickedEnd));
    const skipped = screen.slice(pickedEnd + 1).split(CARD_SEPARATOR).map(unescapeCard).filter(isCardId);
    if (!picked && skipped.length === 0) continue;
    picks.push(loadedPick(Math.max(0, Math.floor(Number(screen.slice(0, floorEnd)) || 0)), picked, skipped, roomByFloor));
  }
  return picks;
}

/**
 * The older object form, `cardChoices: [{ floor, picked, skipped }]`, which
 * the server still accepts from any client that sends it.
 * @param {unknown} choices
 * @param {Map<number, string>} roomByFloor
 */
function picksFromChoices(choices, roomByFloor) {
  if (!Array.isArray(choices)) return [];
  const picks = [];
  for (const choice of choices.slice(0, LIMITS.choices)) {
    if (!choice || typeof choice !== "object") continue;
    const picked = typeof choice.picked === "string" && choice.picked ? choice.picked : null;
    const skipped = Array.isArray(choice.skipped) ? choice.skipped.filter((card) => typeof card === "string" && card) : [];
    if (!picked && skipped.length === 0) continue;
    picks.push(loadedPick(Number(choice.floor) || 0, picked, skipped, roomByFloor));
  }
  return picks;
}

/**
 * `picks` when it holds anything, else the older `cardChoices`.
 * @param {unknown} picks @param {unknown} cardChoices @param {Map<number, string>} roomByFloor
 */
function cardPicksFromWire(picks, cardChoices, roomByFloor) {
  const fromText = picksFromText(picks, roomByFloor);
  return fromText.length > 0 ? fromText : picksFromChoices(cardChoices, roomByFloor);
}

/**
 * One run from the Steam copy in the shape the app loads. Dates stay ISO
 * strings (script.js revives them). A copy written before the server kept a
 * field comes back without it: no card picks, no path, party unknown.
 * @param {any} wire
 */
export function fromWire(wire) {
  const { picks, cardChoices, path, party, partySize, seat, isCustom, ...rest } = wire ?? {};
  const pathByAct = pathFromWire(path);
  const roomByFloor = new Map(pathByAct.flatMap((act) => act.nodes.map((node) => /** @type {[number, string]} */ ([node.floor, node.type]))));
  const size = Number.isFinite(partySize) ? Math.max(1, Math.min(LIMITS.party, Math.floor(partySize))) : undefined;
  const listed = Array.isArray(party)
    ? party.slice(0, LIMITS.party).map((climber) => (typeof climber === "string" && climber ? climber : null))
    : size === 1 ? [rest.character || null] : undefined;
  return {
    ...rest,
    wasAbandoned: rest.wasAbandoned === true,
    ...(isCustom === true ? { isCustom: true } : {}),
    modifiers: strings(rest.modifiers, LIMITS.modifiers),
    cardPicks: cardPicksFromWire(picks, cardChoices, roomByFloor),
    pathByAct,
    ...(size ? { partySize: size } : {}),
    ...(listed ? { party: listed } : {}),
    ...(knownSeat({ seat }, size) !== undefined ? { seat } : {}),
  };
}

/** @param {any} run a loaded run @returns {boolean} */
export function hasCardPicks(run) {
  return Array.isArray(run?.cardPicks) && run.cardPicks.length > 0;
}

/** @param {any} run a loaded run @returns {boolean} */
function hasPath(run) {
  return Array.isArray(run?.pathByAct) && run.pathByAct.some((act) => Array.isArray(act?.nodes) && act.nodes.length > 0);
}

/** @param {any} run @returns {number} */
function endTime(run) {
  return run?.endedAt?.getTime?.() || 0;
}

/**
 * Which copy of one run is the record to keep: the Steam copy's, or the
 * device's. A co-op record that knows the local player beats one that may be
 * telling a teammate's side (every record written before 2026-11-22, and the
 * desktop apps' until their reader learns it), whatever their end times:
 * readers do not all stamp a run's end alike, and a run sent with no end time
 * is stamped with the upload time. Otherwise a later end time wins, as it
 * always has (the run was finalized again), and at the same end time both
 * describe one save file, so the one holding more of it wins.
 * @param {any} local a loaded run @param {any} cloud the same run from the copy, loaded
 */
export function cloudCopyWins(local, cloud) {
  if (hasSeat(cloud) !== hasSeat(local)) return hasSeat(cloud);
  const localEnd = endTime(local);
  const cloudEnd = endTime(cloud);
  if (cloudEnd !== localEnd) return cloudEnd > localEnd;
  if (hasCardPicks(cloud) !== hasCardPicks(local)) return hasCardPicks(cloud);
  return hasPath(cloud) && !hasPath(local);
}

/** @param {unknown} value @returns {boolean} */
function isFilled(value) {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "" && value !== false;
}

/** What one copy of a run may hold that the other lacks, because the client
 *  that wrote it was older or (sourceFile) because only a device that read
 *  the save knows it. */
const DETAIL_FIELDS = Object.freeze(["cardPicks", "pathByAct", "modifiers", "party", "partySize", "gameMode", "wasAbandoned", "isCustom", "sourceFile"]);

/**
 * The run a device keeps when it and the Steam copy both hold one. The newer
 * record (cloudCopyWins) supplies everything it has; detail it lacks comes
 * from the other, so nothing is traded away: a device that read the save
 * keeps its card picks even when the copy's record is later but was written
 * by a build that sent none (a run with no end time is stamped with the
 * upload time, which always looks later).
 * Returns `local` itself when the device's run needs no change.
 * @param {any} local a loaded run @param {any} cloud the same run from the copy, loaded
 */
export function bestOf(local, cloud) {
  const winner = cloudCopyWins(local, cloud) ? cloud : local;
  const other = winner === cloud ? local : cloud;
  const filled = {};
  for (const field of DETAIL_FIELDS) {
    // Card picks are one player's: never a teammate's under the local player's climber.
    if (field === "cardPicks" && !sameSide(winner, other)) continue;
    if (!isFilled(winner?.[field]) && isFilled(other?.[field])) filled[field] = other[field];
  }
  return Object.keys(filled).length > 0 ? { ...winner, ...filled } : winner;
}

/**
 * Whether this device holds a run the Steam copy has never seen.
 * @param {any[]} localRuns loaded runs @param {any[]} cloudRuns the copy, loaded
 */
export function hasRunsCopyLacks(localRuns, cloudRuns) {
  const inCloud = new Set(cloudRuns.map((run) => run?.id));
  return localRuns.some((run) => run?.id && !inCloud.has(run.id));
}

/**
 * What a record of a run holds beyond the totals. Each is something every
 * build since 2026-11-18 sends when the save has it, so a record without it
 * was written by an older build (or the save had none).
 * `isCustom` is only ever true, so a record without it is either a
 * standard run or one written before 2026-11-22.
 * @typedef {{ hasPicks: boolean, hasPath: boolean, hasPartySize: boolean, hasSeat: boolean, isCustom: boolean }} RunDetail
 */

/** @param {any} run a loaded run @returns {RunDetail} */
function detailOf(run) {
  return { hasPicks: hasCardPicks(run), hasPath: hasPath(run), hasPartySize: Number.isFinite(run?.partySize), hasSeat: hasSeat(run), isCustom: run?.isCustom === true };
}

/**
 * Whether the device's record has detail the copy's record lacks. Not only
 * card picks: a run abandoned before its first card reward has none, and
 * its abandoned flag, mode and rooms still have to reach the copy.
 * @param {RunDetail} local @param {RunDetail} held
 */
function hasMoreDetail(local, held) {
  return (local.hasPicks && !held.hasPicks) || (local.hasPath && !held.hasPath) || (local.hasPartySize && !held.hasPartySize)
    || (local.hasSeat && !held.hasSeat) || (local.isCustom && !held.isCustom);
}

/**
 * Whether this device holds detail (card picks, rooms, the abandoned flag
 * and mode that travel with them) for a run the Steam copy has without it:
 * true of every copy written before 2026-11-18, until a device that read
 * the save folder sends its runs up again.
 * @param {any[]} localRuns loaded runs @param {any[]} cloudRuns the copy, loaded
 */
export function hasDetailCopyLacks(localRuns, cloudRuns) {
  const inCloud = new Map();
  for (const run of cloudRuns) if (run?.id) inCloud.set(run.id, run);
  return localRuns.some((run) => inCloud.has(run?.id) && hasMoreDetail(detailOf(run), detailOf(inCloud.get(run.id))));
}

// ---- sending only what the copy lacks ---------------------------------------------
//
// The server reads, merges and re-writes a player's whole copy on every
// upload, so an upload costs it the copy's size plus the upload's. Sending
// the whole library each time (as every build before 2026-11-18 did) roughly
// doubles that for nothing once the copy has it all, and an upload that adds
// nothing is still one write against the Worker's daily allowance.

/** Runs per upload request. A library larger than this goes up in several
 *  requests, one after another, so no single request has to parse it all. */
export const UPLOAD_CHUNK_RUNS = 400;

/**
 * @typedef {RunDetail & { end: number }} CopyEntry what the copy holds for one run
 * @typedef {ReadonlyMap<string, CopyEntry>} CopyIndex
 */

/**
 * What the Steam copy is known to hold, from the runs GET /api/runs returned
 * (still in wire form).
 * @param {unknown} wireRuns @returns {CopyIndex}
 */
export function indexOfCopy(wireRuns) {
  const index = new Map();
  if (!Array.isArray(wireRuns)) return index;
  for (const run of wireRuns) {
    if (!run || typeof run.id !== "string" || !run.id) continue;
    const hasPicks = (typeof run.picks === "string" && run.picks.length > 0)
      || (Array.isArray(run.cardChoices) && run.cardChoices.length > 0);
    const hasRooms = Array.isArray(run.path) && run.path.some((act) => typeof act === "string" && act.length > 0);
    index.set(run.id, { end: Date.parse(run.endedAt) || 0, hasPicks, hasPath: hasRooms, hasPartySize: Number.isFinite(run.partySize), hasSeat: hasSeat(run), isCustom: run.isCustom === true });
  }
  return index;
}

/**
 * The runs worth sending: ones the copy has never seen, ones that ended
 * later than the copy's record, and ones with detail the copy's record lacks.
 * With no index (the copy has not been read in this visit) that is all of
 * them, as before.
 * @param {any[]} runs loaded runs @param {CopyIndex | null} index
 */
export function runsToSend(runs, index) {
  if (!index) return runs;
  return runs.filter((run) => {
    if (!run?.id) return true;
    const held = index.get(run.id);
    return !held || endTime(run) > held.end || hasMoreDetail(detailOf(run), held);
  });
}

/**
 * The index once the server has accepted `sent`. A new map: the old one is
 * left as it was.
 * @param {CopyIndex | null} index @param {any[]} sent loaded runs
 * @returns {CopyIndex | null}
 */
export function indexAfterSend(index, sent) {
  if (!index) return null;
  const next = new Map(index);
  for (const run of sent) {
    if (!run?.id) continue;
    const held = next.get(run.id);
    const sentDetail = detailOf(run);
    next.set(run.id, {
      end: Math.max(held?.end ?? 0, endTime(run)),
      hasPicks: Boolean(held?.hasPicks) || sentDetail.hasPicks,
      hasPath: Boolean(held?.hasPath) || sentDetail.hasPath,
      hasPartySize: Boolean(held?.hasPartySize) || sentDetail.hasPartySize,
      // The upload stays on a tie, so the copy now says what was sent.
      hasSeat: sentDetail.hasSeat,
      isCustom: Boolean(held?.isCustom) || sentDetail.isCustom,
    });
  }
  return next;
}

/** @template T @param {T[]} list @param {number} size @returns {T[][]} */
export function inChunks(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}
