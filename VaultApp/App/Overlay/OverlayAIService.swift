import Foundation
import AppKit
import CoreGraphics
import SwiftUI

// =========================================================================
// OverlayAIService
// -------------------------------------------------------------------------
// Handles three things, end-to-end, for the Beta overlay coach:
//
//   1. Screenshot of the active display (the player's STS2 window).
//   2. Building a strict, JSON-shaped prompt that mirrors the web app's
//      `buildVisionPrompt` so a player swapping between desktop and
//      browser gets the same kind of advice.
//   3. Sending the chat-completion request to the configured provider
//      (OpenAI or Anthropic) and parsing the response.
//
// The user's API key is read from the keychain on each call — we never
// hold it in memory longer than a single request. If no key is set we
// short-circuit with a humane "Add an API key in Beta → Run Coach" reply
// so the user knows exactly what to do.
//
// Privacy posture, copied from the web overlay engine:
//   * Engine never claims to read game memory.
//   * Only the screenshot the player explicitly invokes via Cmd+Enter
//     is sent — there's no continuous capture loop.
//   * Screenshots are downscaled before transit so we don't ship a 5K
//     monitor frame to a third-party API.
// =========================================================================

@MainActor
final class OverlayAIService: ObservableObject {

    // MARK: - Public types

    enum Provider: String, CaseIterable, Identifiable {
        case openai
        case anthropic
        var id: String { rawValue }
        var displayName: String {
            switch self {
            case .openai:    return "OpenAI"
            case .anthropic: return "Anthropic"
            }
        }
        var keychainAccount: String { rawValue }
        var defaultModel: String {
            switch self {
            case .openai:    return "gpt-4o-mini"
            case .anthropic: return "claude-3-5-sonnet-20241022"
            }
        }
        /// Models we surface in the Beta picker. The user can also type
        /// a custom model identifier — the underlying client just passes
        /// the string through to the provider's API.
        ///
        /// `gpt-4o-mini` is the default because it (a) supports vision,
        /// (b) is roughly 1/15 the cost of `gpt-4o`, and (c) handles the
        /// "look at this card reward" prompt indistinguishably from full
        /// `gpt-4o` in playtesting. Power users can swap to the bigger
        /// model from the picker if they want the extra reasoning.
        var suggestedModels: [String] {
            switch self {
            case .openai:    return ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-4.1-mini"]
            case .anthropic: return [
                "claude-3-5-sonnet-20241022",
                "claude-3-5-haiku-20241022",
                "claude-3-opus-20240229",
            ]
            }
        }
        var apiKeyHint: String {
            switch self {
            case .openai:    return "sk-…  (platform.openai.com → API keys)"
            case .anthropic: return "sk-ant-…  (console.anthropic.com → API keys)"
            }
        }
    }

    /// Single message in the visible chat history. Kept tiny on purpose —
    /// just a role + body. Optional structured payloads ride alongside
    /// the text so the chat bubble can render richer affordances when
    /// the model returns them. The plain `text` always works as a
    /// fallback when the structured parse fails.
    ///
    /// Exactly zero or one of the structured plans should be set. Each
    /// matches a different game phase (path / reward / shop / event)
    /// and renders its own card view above the bubble.
    struct Message: Identifiable, Equatable {
        let id: UUID
        enum Role: Equatable { case user, assistant, system }
        let role: Role
        let text: String
        let createdAt: Date
        let attachedScreenshot: Bool
        /// Visual route card for the "Path" action.
        let pathPlan: PathPlan?
        /// Visual reward card for "Card pick" + "Boss relic" actions —
        /// both are "rank these N options and tell me which to take".
        let rewardPlan: RewardPlan?
        /// Visual shop list for the "Shop" action — itemized buys with
        /// prices and remaining-gold math.
        let shopPlan: ShopPlan?
        /// Visual event card for the "Event" action — `?` map nodes.
        let eventPlan: EventPlan?

        init(role: Role, text: String,
             attachedScreenshot: Bool = false,
             pathPlan: PathPlan? = nil,
             rewardPlan: RewardPlan? = nil,
             shopPlan: ShopPlan? = nil,
             eventPlan: EventPlan? = nil) {
            self.id = UUID()
            self.role = role
            self.text = text
            self.createdAt = Date()
            self.attachedScreenshot = attachedScreenshot
            self.pathPlan = pathPlan
            self.rewardPlan = rewardPlan
            self.shopPlan = shopPlan
            self.eventPlan = eventPlan
        }
    }

    // MARK: - Structured plan models
    //
    // Every "phase" the player can be in maps to one of these. The model
    // is asked to emit a strict JSON object matching the schema; if the
    // parse fails we fall through to plain text so the feature degrades
    // gracefully. Each plan owns its own JSON-schema instructions
    // (defined further down) so a future schema bump is isolated.

    /// Structured route for the "Path" action. The first node is the
    /// IMMEDIATE next step.
    struct PathPlan: Equatable, Codable {
        let summary: String
        let nodes: [PathNode]
    }

    struct PathNode: Equatable, Codable, Identifiable {
        var id: String { "\(label)-\(type)-\(why ?? "")" }
        let label: String
        /// One of `combat | elite | shop | rest | event | chest | boss | unknown`.
        let type: String
        let why: String?
    }

    /// Card-reward / boss-relic plan. Same shape because the decision
    /// is the same: rank N options, mark one as "TAKE".
    struct RewardPlan: Equatable, Codable {
        let summary: String
        /// "card_reward" | "boss_relic" | "elite_relic" | "event_reward" | "other"
        let kind: String?
        let options: [RewardOption]
    }

    struct RewardOption: Equatable, Codable, Identifiable {
        var id: String { "\(label)-\(verdict)" }
        let label: String
        /// "TAKE" | "MAYBE" | "SKIP"
        let verdict: String
        /// "S" | "A" | "B" | "C" | "D" — fine-grain rank used only for
        /// sort + small badge color.
        let rank: String?
        let why: String?
        /// Optional callouts we render as small chips under the label.
        let synergies: [String]?
    }

    /// Shop plan. Itemizes everything on screen and recommends a buy
    /// order. The model is told the player's current gold so the
    /// recommendation respects budget.
    struct ShopPlan: Equatable, Codable {
        let summary: String
        let goldStart: Int?
        let goldAfter: Int?
        let items: [ShopItem]
    }

    struct ShopItem: Equatable, Codable, Identifiable {
        var id: String { "\(label)-\(price ?? -1)" }
        let label: String
        /// "card" | "relic" | "potion" | "removal" | "upgrade" | "other"
        let kind: String?
        let price: Int?
        /// "BUY" | "MAYBE" | "SKIP"
        let verdict: String
        let why: String?
    }

    /// Event plan. STS2 `?` nodes have 1-N text choices; the model picks
    /// one as the recommendation and explains the others.
    struct EventPlan: Equatable, Codable {
        let summary: String
        let eventName: String?
        let options: [EventOption]
    }

    struct EventOption: Equatable, Codable, Identifiable {
        var id: String { "\(label)-\(verdict)" }
        let label: String
        /// "TAKE" | "MAYBE" | "SKIP" | "AVOID"
        let verdict: String
        let why: String?
    }

    // MARK: - Published state

    @Published private(set) var messages: [Message] = []
    @Published private(set) var isThinking = false
    @Published private(set) var lastError: String?
    /// Brief one-liner the overlay shows under the input row. Distinct
    /// from `lastError` because we want non-error transitions ("Captured
    /// screen", "Sent to Anthropic…") to surface there too.
    @Published private(set) var statusLine: String?

    // MARK: - Plumbing

    private weak var appState: AppState?
    private let session: URLSession
    /// Live save reader. Owned by the AI service so cache invalidation
    /// is co-located with the prompt builder — when the user hits
    /// "refresh save", we wipe the cache and the next prompt is built
    /// from a fresh disk read.
    let liveReader = STS2LiveSaveReader()

    init(appState: AppState) {
        self.appState = appState
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 90
        self.session = URLSession(configuration: cfg)
    }

    /// Read the live save right now (bypasses cache). Used by the
    /// overlay's "refresh save" button + the live header's tap to pin
    /// the freshest snapshot to the panel without making a model call.
    @discardableResult
    func refreshLiveSnapshot() -> STS2LiveSaveReader.LiveRunSnapshot? {
        let snap = liveReader.snapshot(saveFolder: appState?.saveFolder, forceRefresh: true)
        liveSnapshot = snap
        return snap
    }

    /// Cached snapshot the overlay header reads from. Keeping this on
    /// the @Published surface lets SwiftUI redraw the header without
    /// each view holding its own cache or peeking into the reader.
    @Published private(set) var liveSnapshot: STS2LiveSaveReader.LiveRunSnapshot?

    // MARK: - Public actions

    /// Reset the visible chat. Doesn't touch the API key. Also zeros
    /// the session-spend counters so the footer reflects "this is the
    /// new session" instead of carrying stale numbers across a
    /// conversation reset.
    func clearConversation() {
        messages.removeAll()
        lastError = nil
        statusLine = nil
        resetSpend()
    }

    /// Send the current input to the model. If the user has the
    /// "attach screenshot" flag enabled and we can grab one, we attach
    /// it as a vision input.
    func ask(_ rawQuestion: String, includeScreenshot: Bool? = nil) async {
        let question = rawQuestion.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }
        guard let appState else { return }
        let provider = currentProvider()
        guard let key = OverlayKeychain.apiKey(for: provider.keychainAccount),
              !key.isEmpty else {
            messages.append(.init(role: .user, text: question))
            messages.append(.init(
                role: .assistant,
                text: "Add an API key under Beta → Run Coach to enable the overlay's AI advice. The Vault never sees your key — it's stored in the macOS keychain and used only to call \(provider.displayName) directly."
            ))
            return
        }

        // Always refresh the live snapshot before sending — it costs
        // microseconds and means the prompt builder has the freshest
        // possible deck/relic/HP/gold for whatever decision the player
        // is about to ask about.
        liveSnapshot = liveReader.snapshot(saveFolder: appState.saveFolder)

        let attach = includeScreenshot ?? appState.config.overlayAttachScreenshot
        var screenshotPNG: Data?
        if attach {
            statusLine = "Capturing screen…"
            screenshotPNG = captureActiveDisplayPNG(maxDimension: 1280)
            if screenshotPNG != nil {
                statusLine = "Sending to \(provider.displayName)…"
            } else {
                statusLine = "Couldn't capture the screen — sending question only."
            }
        } else {
            statusLine = "Sending to \(provider.displayName)…"
        }

        messages.append(.init(role: .user,
                              text: question,
                              attachedScreenshot: screenshotPNG != nil))
        isThinking = true
        defer { isThinking = false }

        do {
            let answer = try await callProvider(
                provider: provider,
                model: appState.config.overlayAIModel.isEmpty
                    ? provider.defaultModel
                    : appState.config.overlayAIModel,
                apiKey: key,
                userQuestion: question,
                screenshotPNG: screenshotPNG,
                customSystemAddendum: appState.config.overlayCustomSystemPrompt,
                runContext: buildRunContext()
            )
            messages.append(.init(role: .assistant, text: answer))
            lastError = nil
            statusLine = nil
        } catch let err as OverlayAIError {
            lastError = err.message
            statusLine = nil
            messages.append(.init(role: .assistant, text: "⚠︎ \(err.message)"))
        } catch {
            let msg = (error as NSError).localizedDescription
            lastError = msg
            statusLine = nil
            messages.append(.init(role: .assistant, text: "⚠︎ \(msg)"))
        }
    }

    // MARK: - Structured specialist actions
    //
    // Every game-phase chip routes through `runStructured(kind:)` instead
    // of the generic `ask`. We send the model a strict JSON contract for
    // the phase, parse the response into the matching plan struct, and
    // post a single assistant message that carries both the human
    // summary AND the structured payload. The chat bubble decides which
    // visual card to render based on which payload is present.
    //
    // STS2 lets the player draw on its own map — our job is to *show*
    // them what to draw. The same principle applies to card rewards
    // (rank the cards visually), shops (show the buy order), and events
    // (rank each option). Make the decision visible so the player only
    // has to glance at the panel and act.

    /// Which structured phase we're asking about. Drives both the
    /// schema we send and which Message payload we attach.
    enum StructuredKind {
        case path, cardReward, bossRelic, shop, event
    }

    /// Execute a structured request end-to-end: refresh save, capture
    /// screen, send the prompt with the JSON schema, parse, post the
    /// assistant message with the right structured payload.
    ///
    /// Centralized here so the per-phase methods stay one-liners and
    /// improvements (cost tracking, error formatting, history pruning)
    /// land in one place.
    private func runStructured(
        kind: StructuredKind,
        userQuestion: String,
        schema: String,
        statusVerb: String
    ) async {
        guard let appState else { return }
        let provider = currentProvider()
        guard let key = OverlayKeychain.apiKey(for: provider.keychainAccount),
              !key.isEmpty else {
            messages.append(.init(role: .user, text: userQuestion))
            messages.append(.init(
                role: .assistant,
                text: "Add an API key under Coach → Settings to enable AI advice."
            ))
            return
        }

        liveSnapshot = liveReader.snapshot(saveFolder: appState.saveFolder)

        statusLine = "Capturing screen…"
        let png = captureActiveDisplayPNG(maxDimension: 1280)
        statusLine = png == nil
            ? "Couldn't capture screen — using deck context only."
            : "\(statusVerb) with \(provider.displayName)…"

        messages.append(.init(role: .user,
                              text: userQuestion,
                              attachedScreenshot: png != nil))
        isThinking = true
        defer { isThinking = false }

        let model = appState.config.overlayAIModel.isEmpty
            ? provider.defaultModel
            : appState.config.overlayAIModel

        do {
            let raw = try await callProvider(
                provider: provider,
                model: model,
                apiKey: key,
                userQuestion: userQuestion + "\n\n" + schema,
                screenshotPNG: png,
                customSystemAddendum: appState.config.overlayCustomSystemPrompt,
                runContext: buildRunContext()
            )
            recordTokenSpend(prompt: userQuestion + schema + buildRunContext(),
                             response: raw,
                             hadImage: png != nil)
            let assistantMessage = buildAssistantMessage(kind: kind, raw: raw)
            messages.append(assistantMessage)
            lastError = nil
            statusLine = nil
        } catch let err as OverlayAIError {
            lastError = err.message
            statusLine = nil
            messages.append(.init(role: .assistant, text: "⚠︎ \(err.message)"))
        } catch {
            let msg = (error as NSError).localizedDescription
            lastError = msg
            statusLine = nil
            messages.append(.init(role: .assistant, text: "⚠︎ \(msg)"))
        }
    }

    /// Build the assistant message for a structured response, attempting
    /// to parse the right payload type for the kind. Falls back to a
    /// plain-text bubble when the parse fails.
    private func buildAssistantMessage(kind: StructuredKind, raw: String) -> Message {
        switch kind {
        case .path:
            if let plan: PathPlan = decodeJSON(raw), !plan.nodes.isEmpty {
                return .init(role: .assistant, text: plan.summary, pathPlan: plan)
            }
        case .cardReward, .bossRelic:
            if let plan: RewardPlan = decodeJSON(raw), !plan.options.isEmpty {
                return .init(role: .assistant, text: plan.summary, rewardPlan: plan)
            }
        case .shop:
            if let plan: ShopPlan = decodeJSON(raw), !plan.items.isEmpty {
                return .init(role: .assistant, text: plan.summary, shopPlan: plan)
            }
        case .event:
            if let plan: EventPlan = decodeJSON(raw), !plan.options.isEmpty {
                return .init(role: .assistant, text: plan.summary, eventPlan: plan)
            }
        }
        return .init(role: .assistant, text: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Generic JSON decoder used by every structured action. Tolerates
    /// markdown fences and prose preambles around the JSON object so
    /// imperfect model outputs still parse.
    private func decodeJSON<T: Decodable>(_ raw: String) -> T? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = stripCodeFences(trimmed)
        if let data = candidate.data(using: .utf8),
           let v = try? JSONDecoder().decode(T.self, from: data) {
            return v
        }
        if let extracted = extractFirstJSONObject(from: trimmed),
           let data = extracted.data(using: .utf8),
           let v = try? JSONDecoder().decode(T.self, from: data) {
            return v
        }
        return nil
    }

    private func stripCodeFences(_ s: String) -> String {
        var out = s
        if out.hasPrefix("```") {
            if let firstNewline = out.firstIndex(of: "\n") {
                out = String(out[out.index(after: firstNewline)...])
            }
            if let endRange = out.range(of: "```", options: .backwards) {
                out = String(out[..<endRange.lowerBound])
            }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func extractFirstJSONObject(from s: String) -> String? {
        guard let start = s.firstIndex(of: "{") else { return nil }
        var depth = 0
        var i = start
        while i < s.endIndex {
            let c = s[i]
            if c == "{" { depth += 1 }
            if c == "}" {
                depth -= 1
                if depth == 0 {
                    return String(s[start...i])
                }
            }
            i = s.index(after: i)
        }
        return nil
    }

    // MARK: - JSON schemas
    //
    // Each schema is its own static string so a future tweak (add a
    // field, narrow a constraint) lives in exactly one place. They're
    // kept verbose because LLMs follow explicit examples better than
    // they follow terse English specifications.

    /// Schema for path planning. Returns 3-5 ordered nodes.
    private static let pathJSONInstructions: String = """
    Respond with exactly one JSON object — no prose before or after — \
    matching this schema:

    {
      "summary": "Two-sentence rationale for the whole route.",
      "nodes": [
        { "label": "Shop", "type": "shop", "why": "Eight-word reason." }
      ]
    }

    Constraints:
    - 3 ≤ nodes.length ≤ 5
    - "type" ∈ "combat" | "elite" | "shop" | "rest" | "event" | "chest" | "boss" | "unknown"
    - The first node is the IMMEDIATE next step
    - "why" ≤ 14 words
    - Only include nodes reachable from the player's current map position
    """

    /// Schema for card rewards AND boss/elite relic picks. Returns N
    /// ranked options with one TAKE recommendation.
    private static func rewardJSONInstructions(kind: String) -> String {
        """
        Respond with exactly one JSON object — no prose before or after — \
        matching this schema:

        {
          "summary": "One sentence stating which option to take and why.",
          "kind": "\(kind)",
          "options": [
            {
              "label": "Streamline+",
              "verdict": "TAKE",
              "rank": "A",
              "why": "Cheap channel + scaling damage with your Cold Snap.",
              "synergies": ["channel", "frost"]
            }
          ]
        }

        Constraints:
        - Include EVERY option visible on screen (typically 3 cards or 3 relics, plus "Skip" for card rewards).
        - "verdict" ∈ "TAKE" | "MAYBE" | "SKIP"  (exactly one option must be "TAKE")
        - "rank" ∈ "S" | "A" | "B" | "C" | "D"
        - "label" is the on-screen card / relic name as shown
        - "why" ≤ 18 words; "synergies" 0-3 short tags (cards or mechanics)
        - For card rewards include a "Skip" option as the last entry; mark it TAKE only if skipping is correct
        - List options in DESCENDING preference (best first)
        """
    }

    /// Schema for shop visits.
    private static let shopJSONInstructions: String = """
    Respond with exactly one JSON object — no prose before or after — \
    matching this schema:

    {
      "summary": "Two-sentence buy order.",
      "goldStart": 145,
      "goldAfter": 20,
      "items": [
        {
          "label": "Pen Nib",
          "kind": "relic",
          "price": 150,
          "verdict": "BUY",
          "why": "Fifth-attack scaling for Strike-heavy deck."
        }
      ]
    }

    Constraints:
    - Include EVERY card / relic / potion / removal visible in the shop.
    - "kind" ∈ "card" | "relic" | "potion" | "removal" | "upgrade" | "other"
    - "verdict" ∈ "BUY" | "MAYBE" | "SKIP"
    - "price" is the gold cost shown on screen (omit if unreadable)
    - "goldStart" = current gold; "goldAfter" = gold remaining after BUY items
    - List BUY items first, then MAYBE, then SKIP
    - "why" ≤ 18 words per item
    """

    /// Schema for event (`?`) screens.
    private static let eventJSONInstructions: String = """
    Respond with exactly one JSON object — no prose before or after — \
    matching this schema:

    {
      "summary": "One sentence stating which choice to take.",
      "eventName": "Big Fish",
      "options": [
        {
          "label": "Eat the berries (heal 25%)",
          "verdict": "TAKE",
          "why": "Below 50% HP and act-1 elites incoming."
        }
      ]
    }

    Constraints:
    - Include EVERY choice visible on screen
    - "verdict" ∈ "TAKE" | "MAYBE" | "SKIP" | "AVOID"  (exactly one "TAKE")
    - "label" is the on-screen choice text, shortened to ≤ 60 chars
    - "why" ≤ 20 words
    - "eventName" is the event title at the top of the screen
    """

    // MARK: - Auto-Assist (phase detection)
    //
    // Cmd+Enter / "Assist" routes here. We do a single model call that
    // (a) classifies the phase from the screenshot, then (b) returns the
    // structured response appropriate to that phase. Combining both into
    // one call cuts latency in half versus a two-step "classify, then
    // dispatch" approach. The downside is a slightly more permissive
    // schema; the upside is the player sees the right card in one beat.

    private func runAutoAssist() async {
        guard let appState else { return }
        let provider = currentProvider()
        guard let key = OverlayKeychain.apiKey(for: provider.keychainAccount),
              !key.isEmpty else {
            messages.append(.init(role: .user, text: "Assist: what should I do right now?"))
            messages.append(.init(
                role: .assistant,
                text: "Add an API key under Coach → Settings to enable Assist."
            ))
            return
        }
        liveSnapshot = liveReader.snapshot(saveFolder: appState.saveFolder)
        statusLine = "Capturing screen…"
        let png = captureActiveDisplayPNG(maxDimension: 1280)
        statusLine = png == nil
            ? "Couldn't capture screen — using deck context only."
            : "Reading the screen with \(provider.displayName)…"

        let userQuestion = """
        Look at the screen and tell me what to do RIGHT NOW. First \
        identify the phase (card_reward / boss_relic / shop / event / \
        map / combat / rest / other), then give me a structured \
        recommendation in the matching format below.
        """
        messages.append(.init(role: .user,
                              text: "Assist: what should I do right now?",
                              attachedScreenshot: png != nil))
        isThinking = true
        defer { isThinking = false }

        let model = appState.config.overlayAIModel.isEmpty
            ? provider.defaultModel
            : appState.config.overlayAIModel

        do {
            let raw = try await callProvider(
                provider: provider,
                model: model,
                apiKey: key,
                userQuestion: userQuestion + "\n\n" + Self.assistJSONInstructions,
                screenshotPNG: png,
                customSystemAddendum: appState.config.overlayCustomSystemPrompt,
                runContext: buildRunContext()
            )
            recordTokenSpend(prompt: userQuestion + Self.assistJSONInstructions + buildRunContext(),
                             response: raw,
                             hadImage: png != nil)
            messages.append(buildAssistMessage(raw: raw))
            lastError = nil
            statusLine = nil
        } catch let err as OverlayAIError {
            lastError = err.message
            statusLine = nil
            messages.append(.init(role: .assistant, text: "⚠︎ \(err.message)"))
        } catch {
            let msg = (error as NSError).localizedDescription
            lastError = msg
            statusLine = nil
            messages.append(.init(role: .assistant, text: "⚠︎ \(msg)"))
        }
    }

    /// Decode the auto-assist response. The model returns a wrapper
    /// `{"phase": "...", "payload": { ... }}` and we route the payload
    /// to the matching plan type.
    private func buildAssistMessage(raw: String) -> Message {
        struct Wrapper: Decodable {
            let phase: String
            let summary: String?
            let path: PathPlan?
            let reward: RewardPlan?
            let shop: ShopPlan?
            let event: EventPlan?
        }
        guard let wrapper: Wrapper = decodeJSON(raw) else {
            return .init(role: .assistant, text: raw.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let summary = (wrapper.summary?.isEmpty == false ? wrapper.summary! :
                        (wrapper.path?.summary
                         ?? wrapper.reward?.summary
                         ?? wrapper.shop?.summary
                         ?? wrapper.event?.summary
                         ?? raw))
        return .init(
            role: .assistant,
            text: summary,
            pathPlan: wrapper.path,
            rewardPlan: wrapper.reward,
            shopPlan: wrapper.shop,
            eventPlan: wrapper.event
        )
    }

    /// Schema for the auto-assist wrapper. Every field beyond `phase`
    /// + `summary` is optional — the model only fills in the payload
    /// matching the detected phase.
    private static let assistJSONInstructions: String = """
    Respond with exactly one JSON object — no prose before or after — \
    matching this wrapper schema. Fill in ONLY the payload field that \
    matches the detected phase:

    {
      "phase": "card_reward" | "boss_relic" | "shop" | "event" | "map" | "combat" | "rest" | "other",
      "summary": "One sentence stating the recommended action.",
      "path":   { ...PathPlan when phase=map... },
      "reward": { ...RewardPlan when phase=card_reward or boss_relic... },
      "shop":   { ...ShopPlan when phase=shop... },
      "event":  { ...EventPlan when phase=event... }
    }

    Sub-schemas:
    PathPlan   = { "summary": "...", "nodes":   [{ "label": "Combat", "type": "combat", "why": "..." }] }    // 3-5 nodes
    RewardPlan = { "summary": "...", "kind": "card_reward" | "boss_relic", "options": [{ "label": "Bash", "verdict": "TAKE" | "MAYBE" | "SKIP", "rank": "S" | "A" | "B" | "C" | "D", "why": "...", "synergies": ["..."] }] }
    ShopPlan   = { "summary": "...", "goldStart": 145, "goldAfter": 20, "items":   [{ "label": "Pen Nib", "kind": "relic" | "card" | "potion" | "removal", "price": 150, "verdict": "BUY" | "MAYBE" | "SKIP", "why": "..." }] }
    EventPlan  = { "summary": "...", "eventName": "Big Fish", "options": [{ "label": "...", "verdict": "TAKE" | "MAYBE" | "SKIP" | "AVOID", "why": "..." }] }

    Rules:
    - Pick exactly ONE phase based on what's on screen.
    - For combat / rest / other, just set "phase" + "summary" — no payload needed.
    - All "why" / "summary" strings are short: ≤ 20 words.
    - Exactly one "TAKE" or "BUY" verdict where the schema says "exactly one".
    """

    // MARK: - Token + spend tracking
    //
    // Rough estimate, NOT a billed metric. We use it to give the player
    // visibility into what they're spending so they trust the Coach
    // doesn't quietly burn through their OpenAI credits. Approximate
    // because (a) we don't have access to the provider's real token
    // counts without a follow-up usage call, (b) image tokens vary by
    // detail/resolution.
    //
    // Heuristic: ~4 chars per token for text, ~765 tokens flat-rate for
    // an image (matches OpenAI gpt-4o vision low-detail pricing). Cost
    // calc uses gpt-4o-mini's listed rate; over- or under-estimates by
    // 1.5x are fine for this purpose.

    /// Estimated total tokens spent in this overlay session.
    @Published private(set) var sessionTokensSpent: Int = 0
    /// Estimated total USD spent in this overlay session.
    @Published private(set) var sessionCostUSD: Double = 0

    private func recordTokenSpend(prompt: String, response: String, hadImage: Bool) {
        let inTokens = max(1, prompt.count / 4) + (hadImage ? 765 : 0)
        let outTokens = max(1, response.count / 4)
        sessionTokensSpent += inTokens + outTokens
        // Per-million-token rates. Defaulting to gpt-4o-mini because
        // that's our default model. If the user picked a different
        // model, this is in the right ballpark for the user-facing
        // "$X spent" footer — not a billing system.
        let inputRate: Double = 0.15 / 1_000_000
        let outputRate: Double = 0.60 / 1_000_000
        sessionCostUSD += Double(inTokens) * inputRate
                        + Double(outTokens) * outputRate
    }

    /// Reset the session counters (e.g. when the player clears chat).
    func resetSpend() {
        sessionTokensSpent = 0
        sessionCostUSD = 0
    }

    /// Quick "Recap" — summarize what we've discussed so far. Useful
    /// at the end of a fight or after a card reward to capture the
    /// thread without re-typing.
    func recap() async {
        guard !messages.isEmpty else {
            messages.append(.init(
                role: .assistant,
                text: "Nothing to recap yet — ask a question or hit \"What should I do?\" first."
            ))
            return
        }
        await ask("Recap the run-coach advice we've discussed in this conversation as 3-5 short bullets a player can act on next. Keep it concrete; don't restate generic STS2 tips.",
                  includeScreenshot: false)
    }

    /// Cluely-style "What should I do?" — but instead of a generic
    /// "look at the screen" prompt, this now does a TWO-pass call:
    ///
    ///   1. Phase detection (cheap text classification of the screen).
    ///   2. Dispatch to the appropriate structured specialist
    ///      (card / relic / shop / event / path / combat).
    ///
    /// The result is the player gets the right visual card without
    /// having to know which chip to press. Cmd+Enter from anywhere
    /// in the overlay routes here.
    func whatShouldIDo() async {
        await runAutoAssist()
    }

    // MARK: - Game-phase actions
    //
    // Each of these is a specialized variant of `ask` with a tightly
    // scoped prompt. The model gets the same live-save context block
    // either way, but the question framing is what produces the
    // difference between "general advice" and "best Defect card to take
    // for a deck that already runs Cold Snap and Streamline." The chips
    // in the overlay call straight into these.

    /// Card-reward pick. Returns a structured `RewardPlan` so each of
    /// the cards on screen renders as a ranked tile (TAKE / MAYBE /
    /// SKIP) with the why-bullets and synergy callouts. The "TAKE"
    /// option floats to the top so the player's eye lands there first.
    func askCardPick() async {
        await runStructured(
            kind: .cardReward,
            userQuestion: """
            I'm at a card reward screen. Look at every card on screen \
            (typically 3, sometimes 4 with relic effects). Rank them \
            for MY current deck and call out which one to take. If \
            skipping is correct (deck-size threshold, key card already \
            present, relic incompatibility), say "Skip" and rank skip \
            as TAKE.
            """,
            schema: Self.rewardJSONInstructions(kind: "card_reward"),
            statusVerb: "Ranking cards"
        )
    }

    /// Boss / elite / event relic pick. Same shape as `askCardPick`
    /// because the decision is the same — N options, mark one TAKE.
    func askRelicPick() async {
        await runStructured(
            kind: .bossRelic,
            userQuestion: """
            I'm picking a relic right now (boss reward, elite reward, \
            or shop). Rank every relic on screen for MY current build. \
            If a relic has a real downside (HP loss, deck shuffle, \
            curse, energy cap) for this deck, weigh it explicitly.
            """,
            schema: Self.rewardJSONInstructions(kind: "boss_relic"),
            statusVerb: "Ranking relics"
        )
    }

    /// Shop visit. Returns a `ShopPlan` — itemized list of everything
    /// for sale with prices, BUY/MAYBE/SKIP verdicts, and the gold
    /// the player will have left after the recommended purchases.
    func askShop() async {
        await runStructured(
            kind: .shop,
            userQuestion: """
            I'm in a shop. Itemize EVERY card / relic / potion / removal \
            on screen with its price, then give me a buy order using \
            the gold I have. Prefer card removal when my deck wants it. \
            Always include the items I should skip — don't just list the \
            buys.
            """,
            schema: Self.shopJSONInstructions,
            statusVerb: "Reading shop"
        )
    }

    /// Event (`?` map node). STS2 events have 1-N text choices; this
    /// returns a ranked option list so the player can see at a glance
    /// which to pick.
    func askEvent() async {
        await runStructured(
            kind: .event,
            userQuestion: """
            I'm at an event (`?`) screen. Read the event name and the \
            choices on screen, then rank each choice for MY current \
            build. Mark the one I should take. Be direct about choices \
            that would brick my run (e.g. lose 25% HP at 12/75).
            """,
            schema: Self.eventJSONInstructions,
            statusVerb: "Reading event"
        )
    }

    /// Map / path planning. Special path: instead of free-form text we
    /// ask the model to return JSON describing the next 3-5 map nodes,
    /// then render that as a visual route card alongside the text
    /// summary. STS2 itself lets the player draw on the map — our job
    /// is to *show* them the route to draw, in our panel.
    ///
    /// Falls back to plain text if the JSON parse fails so an unhappy
    /// model response still lands as something readable.
    func askPath() async {
        await runStructured(
            kind: .path,
            userQuestion: """
            I'm on the map view. Pick the best 3-5 nodes I should walk \
            through next. Use my live deck, relics, HP, and gold. Prefer \
            elites/shops when my build wants them, rests when low. End \
            the sequence at the next checkpoint (boss, treasure, or \
            end-of-act).
            """,
            schema: Self.pathJSONInstructions,
            statusVerb: "Planning route"
        )
    }

    /// In-fight tactical advice. Frames the model around the actual cards
    /// the player can play this turn.
    func askCombat() async {
        await ask(
            """
            I'm mid-combat. Look at my hand, energy, block, HP, and the \
            enemy's intent on screen and tell me the exact play order this \
            turn. Reference my hand by card name. End with the priority for \
            next turn (e.g., "Save Bash for the second-to-last attack").
            """,
            includeScreenshot: true
        )
    }

    /// Free-form "explain my run" recap, useful between fights. Doesn't
    /// need a screenshot — pure deck/relic synthesis.
    func askDeckPlan() async {
        await ask(
            """
            Without looking at the screen, just from my live deck + relics, \
            tell me what archetype this run is shaping up to be and what 1-2 \
            cards I should be hunting for next. End with one card I should \
            consider removing if I see a removal.
            """,
            includeScreenshot: false
        )
    }

    // MARK: - Provider dispatch

    /// Convenience accessor that maps the persisted raw provider string to
    /// our enum, falling back to OpenAI when the user-supplied value is
    /// from a future build we don't recognize.
    func currentProvider() -> Provider {
        let raw = appState?.config.overlayAIProviderRaw ?? "openai"
        return Provider(rawValue: raw) ?? .openai
    }

    private func callProvider(
        provider: Provider,
        model: String,
        apiKey: String,
        userQuestion: String,
        screenshotPNG: Data?,
        customSystemAddendum: String,
        runContext: String
    ) async throws -> String {
        let system = baseSystemPrompt(addendum: customSystemAddendum, runContext: runContext)
        switch provider {
        case .openai:
            return try await callOpenAI(model: model, apiKey: apiKey,
                                        system: system,
                                        userQuestion: userQuestion,
                                        screenshotPNG: screenshotPNG,
                                        history: chatHistoryForPrompt())
        case .anthropic:
            return try await callAnthropic(model: model, apiKey: apiKey,
                                           system: system,
                                           userQuestion: userQuestion,
                                           screenshotPNG: screenshotPNG,
                                           history: chatHistoryForPrompt())
        }
    }

    /// Shape the conversation history into a chronological list of
    /// `(role, text)` pairs the providers can both consume. We trim to
    /// the last ~12 messages so a long session doesn't blow the context
    /// window — the recap action is the right tool for "remember
    /// everything".
    private func chatHistoryForPrompt() -> [(Message.Role, String)] {
        let kept = messages.suffix(12).filter { $0.role != .system }
        return kept.map { ($0.role, $0.text) }
    }

    private func baseSystemPrompt(addendum: String, runContext: String) -> String {
        var lines: [String] = [
            "You are an in-game Slay the Spire 2 run coach embedded in The Vault, a macOS companion app.",
            "Speak like an experienced friend coaching the player live: short, concrete, decision-first.",
            "When a [live-run-snapshot] block is provided below, TRUST IT as the source of truth for the player's deck, relics, HP, gold, character, ascension, and game mode. The screenshot is just the current decision UI — combine the snapshot with the screenshot to give specific advice.",
            "When recommending a card from a reward, NAME IT (e.g. \"Take Streamline+ — your deck has Cold Snap and 3 channel triggers.\"). Don't say \"the rare card on the right\".",
            "If the snapshot says deck has Strike ×4 and Defend ×4, you can confidently call this an early-floor decision and weight removal/upgrade picks accordingly.",
            "If you can't read the screen confidently, say so and ask the player for the specific decision (\"What three cards are offered?\").",
            "Slay the Spire 2 is in Early Access — only 3 acts and Ascension caps at A9. Do not invent acts, relics, or characters.",
            "Never claim to read game memory. The snapshot comes from the player's own save file on disk that they explicitly let The Vault read.",
            "Format: lead with one bold action sentence, then up to 3 short why-bullets (≤ 14 words each). No fluff, no \"It depends!\".",
        ]
        if !runContext.isEmpty {
            lines.append("\n--- PLAYER CONTEXT ---")
            lines.append(runContext)
            lines.append("--- END CONTEXT ---")
        }
        let trimmedAddendum = addendum.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedAddendum.isEmpty {
            lines.append("\nAdditional player-supplied instructions:")
            lines.append(String(trimmedAddendum.prefix(800)))
        }
        return lines.joined(separator: "\n")
    }

    /// Pull a few useful lines about the player from local state so the
    /// model isn't completely cold. We deliberately keep this short —
    /// the LLM should react to what's on screen, not lecture about
    /// last week's runs.
    ///
    /// Sections, in priority order:
    ///   1. Live run snapshot (deck / relics / HP / gold / floor)
    ///      — by far the most useful context. Without this the model
    ///      is just guessing from a screenshot.
    ///   2. Steam profile + lifetime stats — frames "advice for a
    ///      brand-new player" vs "advice for someone with 30 wins".
    ///   3. Last 3 completed runs — gives the model a sense of what the
    ///      player has been losing to (encounter slugs).
    private func buildRunContext() -> String {
        guard let appState else { return "" }
        var bits: [String] = []
        if let snap = liveSnapshot ?? liveReader.snapshot(saveFolder: appState.saveFolder),
           snap.inProgress {
            bits.append(snap.promptBlock())
        }
        if let p = appState.steamAuth.profile {
            bits.append("Steam: \(p.personaName) (\(p.steamID))")
            if let s = p.stats {
                bits.append("Lifetime: \(s.totalRuns) runs · \(s.wins) wins · best A\(s.maxAscension)\(s.preferredCharacter.map { " · main \($0)" } ?? "")")
            }
        }
        let runs = appState.runs
        if !runs.isEmpty {
            let recent = runs.sorted {
                ($0.endedAt ?? $0.parsedAt) > ($1.endedAt ?? $1.parsedAt)
            }.prefix(3)
            for (i, r) in recent.enumerated() {
                let outcome = r.won == true ? "WIN" : "loss"
                let ch = r.character.map { String(describing: $0) } ?? "?"
                let asc = r.ascension.map { "A\($0)" } ?? "A?"
                let floor = r.floorReached.map { " · floor \($0)" } ?? ""
                bits.append("Last run #\(i+1): \(ch) \(asc) — \(outcome)\(floor)")
            }
        }
        return bits.joined(separator: "\n\n")
    }

    // MARK: - OpenAI

    private func callOpenAI(
        model: String,
        apiKey: String,
        system: String,
        userQuestion: String,
        screenshotPNG: Data?,
        history: [(Message.Role, String)]
    ) async throws -> String {
        let url = URL(string: "https://api.openai.com/v1/chat/completions")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        var msgs: [[String: Any]] = []
        msgs.append(["role": "system", "content": system])
        for (role, text) in history.dropLast() {
            // Drop the just-added user question; we'll re-add it with the
            // optional vision attachment below.
            msgs.append([
                "role": role == .assistant ? "assistant" : "user",
                "content": text,
            ])
        }
        var lastUser: [Any] = [["type": "text", "text": userQuestion]]
        if let png = screenshotPNG {
            let b64 = png.base64EncodedString()
            lastUser.append([
                "type": "image_url",
                "image_url": [
                    "url": "data:image/png;base64,\(b64)",
                    "detail": "auto",
                ],
            ])
        }
        msgs.append([
            "role": "user",
            "content": lastUser,
        ])

        let body: [String: Any] = [
            "model": model,
            "messages": msgs,
            "max_tokens": 700,
            "temperature": 0.4,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw OverlayAIError.network("OpenAI returned a malformed response")
        }
        if http.statusCode != 200 {
            throw OverlayAIError.network(parseProviderError(data: data, status: http.statusCode, provider: "OpenAI"))
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = obj["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw OverlayAIError.malformed("OpenAI returned an empty completion")
        }
        return content.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Anthropic

    private func callAnthropic(
        model: String,
        apiKey: String,
        system: String,
        userQuestion: String,
        screenshotPNG: Data?,
        history: [(Message.Role, String)]
    ) async throws -> String {
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

        var msgs: [[String: Any]] = []
        for (role, text) in history.dropLast() {
            msgs.append([
                "role": role == .assistant ? "assistant" : "user",
                "content": [["type": "text", "text": text]],
            ])
        }
        var lastUser: [[String: Any]] = []
        if let png = screenshotPNG {
            let b64 = png.base64EncodedString()
            lastUser.append([
                "type": "image",
                "source": [
                    "type": "base64",
                    "media_type": "image/png",
                    "data": b64,
                ],
            ])
        }
        lastUser.append(["type": "text", "text": userQuestion])
        msgs.append(["role": "user", "content": lastUser])

        let body: [String: Any] = [
            "model": model,
            "system": system,
            "messages": msgs,
            "max_tokens": 700,
            "temperature": 0.4,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw OverlayAIError.network("Anthropic returned a malformed response")
        }
        if http.statusCode != 200 {
            throw OverlayAIError.network(parseProviderError(data: data, status: http.statusCode, provider: "Anthropic"))
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = obj["content"] as? [[String: Any]] else {
            throw OverlayAIError.malformed("Anthropic returned an empty completion")
        }
        var combined = ""
        for part in content {
            if let type = part["type"] as? String, type == "text",
               let text = part["text"] as? String {
                combined.append(text)
            }
        }
        let trimmed = combined.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            throw OverlayAIError.malformed("Anthropic returned no text content")
        }
        return trimmed
    }

    private func parseProviderError(data: Data, status: Int, provider: String) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let err = obj["error"] as? [String: Any],
               let msg = err["message"] as? String {
                return "\(provider) \(status): \(msg)"
            }
            if let msg = obj["message"] as? String {
                return "\(provider) \(status): \(msg)"
            }
        }
        return "\(provider) returned HTTP \(status)"
    }

    // MARK: - Screenshot capture

    /// Synchronous full-display capture using CoreGraphics. We use the
    /// legacy `CGDisplayCreateImage` API because:
    ///   * It works on macOS 13 (our deployment target). ScreenCaptureKit
    ///     requires an authorization prompt + async setup that doesn't
    ///     fit a single Cmd+Enter beat.
    ///   * The user-installed STS2 window is fullscreen; capturing the
    ///     active display is exactly what we want.
    ///
    /// The first time the user invokes capture, macOS itself shows a
    /// privacy prompt for Screen Recording. We don't need to wire any
    /// extra UI — letting the system handle it is the right pattern.
    nonisolated func captureActiveDisplayPNG(maxDimension: CGFloat = 1280) -> Data? {
        let displayID = CGMainDisplayID()
        guard let cgImage = CGDisplayCreateImage(displayID) else { return nil }
        // Downscale to a reasonable max dimension. A 5K capture is ~30 MB
        // base64-encoded — way more than we need for a vision prompt and
        // it tanks latency on slow uplinks.
        let w = CGFloat(cgImage.width)
        let h = CGFloat(cgImage.height)
        let scale = min(1, maxDimension / max(w, h))
        let targetW = Int((w * scale).rounded())
        let targetH = Int((h * scale).rounded())

        let nsImage = NSImage(cgImage: cgImage,
                              size: NSSize(width: targetW, height: targetH))
        // Re-render into a properly-sized bitmap context so PNG export
        // honors the downscale.
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: targetW,
            pixelsHigh: targetH,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        rep.size = NSSize(width: targetW, height: targetH)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        nsImage.draw(in: NSRect(x: 0, y: 0, width: targetW, height: targetH))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}

// =========================================================================
// Errors
// =========================================================================

enum OverlayAIError: Error {
    case network(String)
    case malformed(String)
    case noKey
    var message: String {
        switch self {
        case .network(let s):   return s
        case .malformed(let s): return s
        case .noKey:            return "No API key configured."
        }
    }
}
