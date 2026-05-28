/**
 * AI-clipped run highlights — auto-detect "key moments" in a closed
 * run snapshot and produce shareable card payloads.
 *
 * Naming note: this lives in `coop-clip.ts` not `coop-highlights.ts`
 * because `highlights.ts` already exists for community-shared run
 * highlights (the share-card system). These are different surfaces:
 *
 *   highlights.ts           = community feed of user-submitted runs
 *                             (already shipping)
 *   coop-clip.ts (this)     = auto-clipped moments INSIDE one run
 *                             (act-end summaries, brutal deaths,
 *                             miracle topdecks)
 *
 * The clipper is intentionally simple:
 *
 *   1. Read the closed RunLiveSnapshot (status != "active")
 *   2. Look at the trace of milestones / floors / decisions
 *   3. Use heuristics to nominate up to 5 moments
 *   4. Optionally hand each moment to the LLM for one-line color
 *
 * Why not a video clip? STS2 is a screenshot game, not a frame-
 * accurate gameplay capture target. Clip == one card per moment with
 * a snapshot of the deck/hand at that point. Posts to X/Discord as
 * an image with overlay text (rendered client-side from the JSON).
 */

import type { Env } from "./types";
import type { RunLiveSnapshot } from "./coop-mod-stream";
import { readLiveRun } from "./coop-mod-stream";

export interface ClipMoment {
  /** Internal id; client uses this to render. */
  id: string;
  /** "act_clear" | "boss_kill" | "low_hp_save" | "death" | "key_pick". */
  kind: string;
  /** One-line headline for the card overlay. */
  headline: string;
  /** Short body — at most 2 lines. */
  body: string;
  /** Floor at the moment captured. */
  floor: number;
  /** Optional named card/relic that anchors the moment. */
  anchor?: string;
}

export interface ClipBundle {
  runId: string;
  hostPersonaName: string;
  characterId: string;
  ascension: number;
  status: RunLiveSnapshot["status"];
  endFloor: number;
  moments: ClipMoment[];
  generatedAt: string;
}

/** Generate a clip bundle for a closed run. Returns null if the run
 *  isn't found or is still active. */
export async function generateClipBundle(env: Env, runId: string): Promise<ClipBundle | null> {
  const snap = await readLiveRun(env, runId);
  if (!snap) return null;
  if (snap.status === "active") return null;
  return buildClipBundle(snap);
}

/** Pure builder; testable without KV. */
export function buildClipBundle(snap: RunLiveSnapshot): ClipBundle {
  const moments: ClipMoment[] = [];

  // Always include the verdict moment.
  moments.push({
    id: "verdict",
    kind: snap.status === "victory" ? "victory" : snap.status === "death" ? "death" : "abandoned",
    headline:
      snap.status === "victory"
        ? `${snap.hostPersonaName} cleared A${snap.ascension} on ${snap.characterId}`
        : snap.status === "death"
          ? `${snap.hostPersonaName} fell on floor ${snap.floor}`
          : `${snap.hostPersonaName} stepped away on floor ${snap.floor}`,
    body:
      snap.status === "victory"
        ? `${snap.deck.length}-card ${snap.characterId} deck. ${snap.relics.length} relics.`
        : `Reached floor ${snap.floor} with ${snap.hp}/${snap.maxHp} HP at the end.`,
    floor: snap.floor,
  });

  // If we know the deck, surface the most-upgraded card as the build's
  // signature. Heuristic: highest upgrade level wins; ties broken by name.
  const sigCard = pickSignatureCard(snap);
  if (sigCard) {
    moments.push({
      id: "signature",
      kind: "key_pick",
      headline: `Build signature: ${sigCard.name}${sigCard.upgrades > 0 ? "+" : ""}`,
      body: `Anchor card of the ${snap.characterId} deck. ${snap.deck.length} cards total.`,
      floor: snap.floor,
      anchor: sigCard.name,
    });
  }

  // If a top relic stands out by name, surface it.
  if (snap.relics.length > 0) {
    const r = snap.relics[0]!;
    moments.push({
      id: "relic_anchor",
      kind: "key_pick",
      headline: `Relic anchor: ${r.name}`,
      body: r.description ? r.description.slice(0, 120) : "Defining relic for this run.",
      floor: snap.floor,
      anchor: r.name,
    });
  }

  // Co-op flavor — if it was a party run, call out who carried by HP.
  if (snap.party.length > 0) {
    const survivors = snap.party.filter((p) => p.hp !== undefined && p.hp > 0);
    if (survivors.length > 0) {
      const top = survivors.sort((a, b) => (b.hp ?? 0) - (a.hp ?? 0))[0]!;
      moments.push({
        id: "party_carry",
        kind: "key_pick",
        headline: `${top.personaName ?? "Teammate"} ended at ${top.hp}/${top.maxHp} HP`,
        body: `Co-op run with ${snap.party.length + 1} players. Solid finish for ${top.characterId ?? "the party"}.`,
        floor: snap.floor,
      });
    }
  }

  return {
    runId: snap.runId,
    hostPersonaName: snap.hostPersonaName,
    characterId: snap.characterId,
    ascension: snap.ascension,
    status: snap.status,
    endFloor: snap.floor,
    moments: moments.slice(0, 5),
    generatedAt: new Date().toISOString(),
  };
}

function pickSignatureCard(snap: RunLiveSnapshot) {
  if (snap.deck.length === 0) return null;
  const sorted = [...snap.deck].sort(
    (a, b) => b.upgrades - a.upgrades || a.name.localeCompare(b.name),
  );
  return sorted[0];
}

// We export the env type just to keep this module isomorphic with
// the rest of the coop-* surface; no other consumers right now.
void ({} as Env);
