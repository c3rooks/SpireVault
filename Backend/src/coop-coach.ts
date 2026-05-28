/**
 * SpireVault Coach — team-aware AI strategist.
 *
 * Three operating modes, ranked from least to most data:
 *
 *   1. Screenshot mode (Coach v1)
 *      - Pure frontend upload: user pastes/drops a card-reward / map /
 *        deck screenshot. We forward to a vision-capable model and
 *        return short, opinionated commentary.
 *      - Works without the Companion mod. Ships independently.
 *
 *   2. Snapshot mode (Coach v2)
 *      - The mod has streamed a RunLiveSnapshot. We pull the snapshot
 *        from KV (`runlive:<runId>`), build a deck-archetype + party-
 *        comp prompt, and return:
 *          - "Best Pick" recommendation when at a card reward
 *          - Party-comp warnings ("no healer in this comp")
 *          - Mid-run pivot suggestions
 *      - Team-aware because the snapshot includes party[].deck etc.
 *
 *   3. Narrative mode (post-run)
 *      - Reads the FINAL snapshot of a closed run + party history
 *      - Writes a short story-style recap suitable for Discord/X
 *      - Auto-formats as a Share-Run card payload
 *
 * Cost discipline:
 *
 *   Vision tokens are expensive. We rate-limit per-user (10/hour) and
 *   cap upload size (1MB image, 25KB snapshot). The narrative path is
 *   free-tier-friendly because it runs on text we already have.
 *
 * Error model:
 *
 *   Every coach call has a graceful degraded fallback so the UI never
 *   shows a hard error: when the LLM is unreachable we return a static
 *   "Coach is taking a breath, try again in a minute" payload with
 *   ok: true so the panel stays mounted.
 */

import type { Env } from "./types";
import type { RunLiveSnapshot } from "./coop-mod-stream";
import { readLiveRun } from "./coop-mod-stream";

// ────────────────────────────────────────────────────────────────────
// Public types — wire format the frontend consumes
// ────────────────────────────────────────────────────────────────────

export interface CoachAnalysis {
  /** Top-line headline; one sentence, ≤80 chars. */
  headline: string;
  /** 2-4 bullet points of advice. */
  bullets: string[];
  /** Card / relic / option grades when applicable. */
  picks?: Array<{
    label: string;
    grade: "S" | "A" | "B" | "C" | "D" | "F";
    reason: string;
  }>;
  /** Optional warning copy (party-comp risks etc). */
  warnings?: string[];
  /** Free-form narrative paragraph (used by post-run recap mode). */
  narrative?: string;
  /** Echo of the model used and tokens, for transparency. */
  meta: {
    mode: "screenshot" | "snapshot" | "narrative";
    model: string;
    fallback: boolean;
  };
}

interface CoachInput {
  mode: "screenshot" | "snapshot" | "narrative";
  /** Steam ID of the requesting user (for personalization + rate limit). */
  steamId: string;
  /** Snapshot mode: runId to read from KV. */
  runId?: string;
  /** Screenshot mode: data URL OR public https URL. */
  imageRef?: string;
  /** Free-form question/context the user typed. */
  question?: string;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Run a coach analysis for the requesting user. Returns a friendly
 * payload even on LLM failure.
 */
export async function runCoach(env: Env, input: CoachInput): Promise<CoachAnalysis> {
  try {
    if (input.mode === "snapshot" && input.runId) {
      const snap = await readLiveRun(env, input.runId);
      if (!snap) return fallback("snapshot", "I don't see a live run for that id yet — open the game with the Companion mod and try again.");
      return await analyzeSnapshot(env, snap, input);
    }
    if (input.mode === "narrative" && input.runId) {
      const snap = await readLiveRun(env, input.runId);
      if (!snap) return fallback("narrative", "Couldn't find that run for a recap. Make sure the run finished within the last 30 minutes.");
      return await composeNarrative(env, snap, input);
    }
    if (input.mode === "screenshot" && input.imageRef) {
      return await analyzeScreenshot(env, input);
    }
    return fallback(input.mode, "I need either a runId (with the Companion mod running) or a screenshot to look at.");
  } catch (err) {
    return fallback(input.mode, "Coach is taking a breath. Try again in a minute.");
  }
}

// ────────────────────────────────────────────────────────────────────
// Snapshot analysis (Coach v2 — team-aware)
// ────────────────────────────────────────────────────────────────────

/** Quick deck archetype detection — no LLM, deterministic, fast. */
function detectArchetype(deck: RunLiveSnapshot["deck"]): {
  primary: string;
  signals: string[];
} {
  const signals: string[] = [];
  const text = deck.map((c) => c.id + " " + c.name.toLowerCase()).join(" ");
  // Very rough keyword heuristics — kept here so the LLM prompt has a
  // concrete archetype seed instead of having to derive one from
  // 30+ card names.
  const hits: Record<string, number> = {};
  const buckets: Record<string, RegExp[]> = {
    strength: [/strength/, /flex/, /inflame/, /demon_form/, /spot_weakness/, /limit_break/],
    block: [/iron_wave/, /shrug/, /entrench/, /barricade/, /metallicize/, /body_slam/],
    poison: [/poison/, /catalyst/, /noxious/, /deadly/, /bouncing_flask/],
    shiv: [/shiv/, /accuracy/, /infinite_blades/, /blade_dance/],
    frost: [/frost/, /chill/, /cold_snap/, /glacier/, /core_surge/],
    discard: [/discard/, /tactician/, /reflex/, /calculated_gamble/],
    exhaust: [/exhaust/, /fiend_fire/, /corruption/, /dark_embrace/],
  };
  for (const [k, regs] of Object.entries(buckets)) {
    let n = 0;
    for (const r of regs) if (r.test(text)) n++;
    hits[k] = n;
  }
  const sorted = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const primary = sorted[0]?.[1] ? sorted[0]![0] : "balanced";
  for (const [k, n] of sorted) {
    if (n > 0) signals.push(`${k}=${n}`);
    if (signals.length >= 3) break;
  }
  return { primary, signals };
}

async function analyzeSnapshot(
  env: Env,
  snap: RunLiveSnapshot,
  input: CoachInput,
): Promise<CoachAnalysis> {
  const arch = detectArchetype(snap.deck);
  const partyArchetypes = snap.party.map((m) => ({
    persona: m.personaName ?? m.steamId.slice(-5),
    char: m.characterId ?? "?",
    hp: m.hp ?? 0,
    maxHp: m.maxHp ?? 1,
  }));

  // Without an API key bound, fall back to a deterministic heuristic
  // analysis. Better than nothing for the v2 ship and lets the panel
  // mount cleanly while we wire the real LLM call.
  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    return {
      headline: `${snap.characterId} on A${snap.ascension} · floor ${snap.floor} · ${snap.hp}/${snap.maxHp} HP`,
      bullets: [
        `Deck reads as **${arch.primary}** (${arch.signals.join(", ") || "no clear signal yet"}).`,
        snap.party.length > 0
          ? `Co-op with ${snap.party.length} other${snap.party.length === 1 ? "" : "s"} — ${partyArchetypes.map((p) => `${p.persona} (${p.char})`).join(", ")}.`
          : "Solo run — no co-op coordination needed.",
        snap.hp / snap.maxHp < 0.4
          ? "HP is low — prioritize defensive picks and skip risky elites until you stabilize."
          : "HP looks healthy enough to take a chance on a strong but risky pick.",
        snap.combat?.scene === "in_combat"
          ? `In combat at turn ${snap.combat.turn ?? 0} with ${snap.combat.energy ?? 0}/${snap.combat.energyMax ?? 0} energy.`
          : "Map/event/shop screen — drafting decisions matter most here.",
      ],
      warnings: buildPartyWarnings(snap),
      meta: { mode: "snapshot", model: "heuristic-v1", fallback: true },
    };
  }

  // Real LLM call. Keep prompts tight — vision is expensive and the
  // snapshot is rich enough that text-only wins on cost.
  const prompt = buildSnapshotPrompt(snap, arch, input.question);
  const llm = await callTextLLM(env, prompt, { maxTokens: 600 });
  if (!llm) {
    return fallback("snapshot", "Coach couldn't reach the model. Try again shortly.");
  }
  return {
    headline: llm.headline,
    bullets: llm.bullets,
    picks: llm.picks,
    warnings: [...(llm.warnings ?? []), ...buildPartyWarnings(snap)],
    meta: { mode: "snapshot", model: llm.model, fallback: false },
  };
}

function buildPartyWarnings(snap: RunLiveSnapshot): string[] {
  const out: string[] = [];
  if (snap.party.length === 0) return out;
  const lowHpPartner = snap.party.find((p) => p.hp !== undefined && p.maxHp && p.hp / p.maxHp < 0.3);
  if (lowHpPartner) {
    out.push(`${lowHpPartner.personaName ?? "A teammate"} is below 30% HP — be ready to back them up.`);
  }
  const sameChar = snap.party.find((p) => p.characterId === snap.characterId);
  if (sameChar) {
    out.push(`Both you and ${sameChar.personaName ?? "a teammate"} are running ${snap.characterId} — diversify if you have a choice.`);
  }
  return out;
}

function buildSnapshotPrompt(
  snap: RunLiveSnapshot,
  arch: { primary: string; signals: string[] },
  question?: string,
): string {
  const deckList = snap.deck
    .slice(0, 35)
    .map((c) => (c.upgrades > 0 ? `${c.name}+` : c.name))
    .join(", ");
  const relicList = snap.relics.map((r) => r.name).join(", ");
  const partyDesc = snap.party
    .map((p) => `- ${p.personaName ?? p.steamId.slice(-5)} (${p.characterId ?? "?"}) ${p.hp ?? "?"}/${p.maxHp ?? "?"} HP, ${p.deckSize ?? "?"} cards`)
    .join("\n");

  return [
    "You are SpireVault Coach, an opinionated co-op-aware Slay the Spire 2 strategist.",
    "Be specific. No fluff. 2-4 bullets max. Answer in JSON only with keys: headline, bullets, picks (optional), warnings (optional).",
    "",
    `Character: ${snap.characterId} (Ascension ${snap.ascension})`,
    `Run progress: floor ${snap.floor}, act ${snap.act}, ${snap.hp}/${snap.maxHp} HP, ${snap.gold} gold`,
    `Deck (${snap.deck.length} cards, archetype=${arch.primary}, signals=${arch.signals.join(",")}):`,
    deckList,
    `Relics: ${relicList || "(none)"}`,
    partyDesc ? `Party (${snap.party.length} other players):\n${partyDesc}` : "Solo run.",
    snap.combat?.scene === "in_combat"
      ? `Combat: turn ${snap.combat.turn}, energy ${snap.combat.energy}/${snap.combat.energyMax}, hand=${(snap.combat.hand ?? []).map((c) => c.name).join(", ")}`
      : `Scene: ${snap.combat?.scene ?? "unknown"}`,
    question ? `User asked: ${question}` : "User wants the next-action recommendation.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Screenshot analysis (Coach v1)
// ────────────────────────────────────────────────────────────────────

async function analyzeScreenshot(env: Env, input: CoachInput): Promise<CoachAnalysis> {
  if (!env.ANTHROPIC_API_KEY) {
    return fallback(
      "screenshot",
      "Vision coach needs an Anthropic key bound on the worker. Coach v1 falls back to a generic prompt template.",
    );
  }
  const llm = await callVisionLLM(env, input.imageRef!, input.question);
  if (!llm) return fallback("screenshot", "Coach couldn't read that screenshot. Try a clearer angle of the card / map / deck.");
  return {
    headline: llm.headline,
    bullets: llm.bullets,
    picks: llm.picks,
    warnings: llm.warnings,
    meta: { mode: "screenshot", model: llm.model, fallback: false },
  };
}

// ────────────────────────────────────────────────────────────────────
// Narrative recap (post-run)
// ────────────────────────────────────────────────────────────────────

async function composeNarrative(
  env: Env,
  snap: RunLiveSnapshot,
  _input: CoachInput,
): Promise<CoachAnalysis> {
  const arch = detectArchetype(snap.deck);
  const partyDesc = snap.party
    .map((p) => `${p.personaName ?? p.steamId.slice(-5)} (${p.characterId ?? "?"})`)
    .join(", ");

  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    // Decent deterministic fallback that still reads like a recap.
    const verdict =
      snap.status === "victory"
        ? "Cleared the run."
        : snap.status === "death"
          ? `Died on floor ${snap.floor}.`
          : `Ended on floor ${snap.floor}.`;
    return {
      headline: `${snap.hostPersonaName} · ${snap.characterId} A${snap.ascension} · ${verdict}`,
      bullets: [],
      narrative: [
        `${snap.hostPersonaName} ran ${snap.characterId} on Ascension ${snap.ascension}${
          partyDesc ? ` with ${partyDesc}` : ""
        }.`,
        `Built into a ${arch.primary} deck across ${snap.deck.length} cards and ${snap.relics.length} relics.`,
        verdict,
      ].join(" "),
      meta: { mode: "narrative", model: "heuristic-v1", fallback: true },
    };
  }

  const prompt = [
    "Write a 3-4 sentence post-run story for a Slay the Spire 2 co-op run.",
    "Style: warm, specific, no purple prose, no emojis. Mention 1-2 actual cards/relics by name.",
    "Output JSON: {narrative, headline}.",
    "",
    `Host: ${snap.hostPersonaName} as ${snap.characterId} on Ascension ${snap.ascension}`,
    `Outcome: ${snap.status}, ended on floor ${snap.floor}`,
    `Party: ${partyDesc || "solo"}`,
    `Deck archetype: ${arch.primary}`,
    `Notable cards: ${snap.deck.slice(0, 8).map((c) => c.name).join(", ")}`,
    `Notable relics: ${snap.relics.slice(0, 5).map((r) => r.name).join(", ")}`,
  ].join("\n");

  const llm = await callTextLLM(env, prompt, { maxTokens: 400 });
  if (!llm) return fallback("narrative", "Couldn't compose a recap. Try again later.");
  return {
    headline: llm.headline,
    narrative: llm.narrative ?? llm.bullets.join(" "),
    bullets: [],
    meta: { mode: "narrative", model: llm.model, fallback: false },
  };
}

// ────────────────────────────────────────────────────────────────────
// LLM clients — small, defensive, swappable
// ────────────────────────────────────────────────────────────────────

interface LLMOut {
  headline: string;
  bullets: string[];
  picks?: CoachAnalysis["picks"];
  warnings?: string[];
  narrative?: string;
  model: string;
}

async function callTextLLM(
  env: Env,
  prompt: string,
  opts: { maxTokens: number },
): Promise<LLMOut | null> {
  // Prefer Anthropic if available; otherwise OpenAI.
  if (env.ANTHROPIC_API_KEY) {
    return await callAnthropic(env.ANTHROPIC_API_KEY, prompt, opts);
  }
  if (env.OPENAI_API_KEY) {
    return await callOpenAI(env.OPENAI_API_KEY, prompt, opts);
  }
  return null;
}

async function callAnthropic(
  key: string,
  prompt: string,
  opts: { maxTokens: number },
): Promise<LLMOut | null> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        max_tokens: opts.maxTokens,
        system:
          "You are SpireVault Coach. Always respond with VALID JSON only — no prose, no code fences. " +
          "Schema: { headline: string, bullets: string[], picks?: [{label, grade, reason}], warnings?: string[], narrative?: string }.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as any;
    const text = data?.content?.[0]?.text ?? "";
    const parsed = parseLLMJson(text);
    if (!parsed) return null;
    return { ...parsed, model: "claude-3-5-sonnet" };
  } catch {
    return null;
  }
}

async function callOpenAI(
  key: string,
  prompt: string,
  opts: { maxTokens: number },
): Promise<LLMOut | null> {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: opts.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are SpireVault Coach. Respond with strict JSON: { headline, bullets[], picks?[], warnings?[], narrative? }.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as any;
    const text = data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseLLMJson(text);
    if (!parsed) return null;
    return { ...parsed, model: "gpt-4o-mini" };
  } catch {
    return null;
  }
}

async function callVisionLLM(
  env: Env,
  imageRef: string,
  question?: string,
): Promise<LLMOut | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    // Accept either a https URL or a data: URL.
    const imageBlock = imageRef.startsWith("data:")
      ? {
          type: "image",
          source: {
            type: "base64",
            media_type: imageRef.slice(5, imageRef.indexOf(";")) || "image/png",
            data: imageRef.slice(imageRef.indexOf(",") + 1),
          },
        }
      : { type: "image", source: { type: "url", url: imageRef } };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 600,
        system:
          "You are SpireVault Coach. Look at the screenshot and respond with strict JSON " +
          "(no prose, no code fences) using the schema: { headline, bullets[], picks?[], warnings?[] }. " +
          "If the image shows a card reward, grade each card S/A/B/C/D/F. If it shows a map, recommend a path. " +
          "If it shows a deck, identify the archetype and suggest the next pick to lean into.",
        messages: [
          {
            role: "user",
            content: [
              imageBlock as any,
              {
                type: "text",
                text: question ? question : "What should I do here?",
              },
            ],
          },
        ],
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as any;
    const text = data?.content?.[0]?.text ?? "";
    const parsed = parseLLMJson(text);
    if (!parsed) return null;
    return { ...parsed, model: "claude-3-5-sonnet-vision" };
  } catch {
    return null;
  }
}

/** Strip code fences and parse JSON. Defensive against models that
 *  occasionally wrap output despite system instructions. */
function parseLLMJson(text: string): Omit<LLMOut, "model"> | null {
  let body = text.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      headline: typeof parsed.headline === "string" ? parsed.headline.slice(0, 200) : "Coach analysis",
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 6).map((b: unknown) => String(b).slice(0, 280)) : [],
      picks: Array.isArray(parsed.picks)
        ? parsed.picks
            .slice(0, 6)
            .map((p: any) =>
              p && typeof p === "object"
                ? {
                    label: String(p.label ?? "").slice(0, 120),
                    grade: ["S", "A", "B", "C", "D", "F"].includes(p.grade) ? p.grade : "B",
                    reason: String(p.reason ?? "").slice(0, 200),
                  }
                : null,
            )
            .filter((p: any) => p && p.label)
        : undefined,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 4).map((w: unknown) => String(w).slice(0, 200)) : undefined,
      narrative: typeof parsed.narrative === "string" ? parsed.narrative.slice(0, 800) : undefined,
    };
  } catch {
    return null;
  }
}

function fallback(mode: CoachAnalysis["meta"]["mode"], message: string): CoachAnalysis {
  return {
    headline: "Coach v1",
    bullets: [message],
    meta: { mode, model: "fallback", fallback: true },
  };
}
