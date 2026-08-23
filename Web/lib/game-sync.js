// game-sync.js
// =========================================================================
// The single source of truth for "which game version does this app's data
// describe". Everything that displays a sync claim reads from here, and
// scripts/check-game-data.mjs asserts these strings appear in
// docs/game-data-sync.md — so the badge in the UI, the ledger, and the
// hand-curated data files can't silently drift apart.
//
// Update BOTH values when a data pass lands, and only then.
// =========================================================================

/** The game branch the app's default copy describes. */
export const GAME_SYNC = {
  /** Current MAIN-branch game version the data is verified against. */
  main: "v0.107.1",
  /** Latest BETA patch whose notes are folded into the watchlists. */
  betaWatch: "v0.111.0",
  /** Date of the last full data-verification pass (YYYY-MM-DD). */
  verified: "2026-08-23",
};

/** One-line badge copy, shared by every surface that shows the claim. */
export function gameSyncLabel() {
  return `Game data verified against STS2 ${GAME_SYNC.main} (main) · beta notes through ${GAME_SYNC.betaWatch}`;
}
