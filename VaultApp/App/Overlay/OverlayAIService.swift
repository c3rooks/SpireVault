import Foundation
import AppKit
import CoreGraphics
import SwiftUI
import ScreenCaptureKit

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
// The user's API key is read from the local-disk key store on each call
// (`OverlayKeychain` — file-backed since v0.9.5; see that file for the
// migration off the macOS keychain) — we never hold it in memory longer
// than a single request. If no key is set we short-circuit with a humane
// "Add an API key in Beta → Run Coach" reply so the user knows exactly
// what to do.
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
            case .anthropic: return "claude-sonnet-4-6"
            }
        }
        var suggestedModels: [String] {
            switch self {
            case .openai:    return ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"]
            case .anthropic: return [
                "claude-sonnet-4-6",
                "claude-haiku-4-5-20251001",
                "claude-opus-4-7",
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
    /// matches a different game phase (path / reward / shop / event /
    /// combat). The `tracker` payload is special — it's posted by the
    /// snapshot diff watcher (no model call, no cost) and renders as a
    /// thin inline chip rather than a chat bubble.
    struct Message: Identifiable, Equatable, Codable {
        let id: UUID
        enum Role: String, Equatable, Codable { case user, assistant, system, tracker }
        let role: Role
        /// Mutable so the streaming path can append tokens in place
        /// without invalidating the message ID (which would defeat
        /// SwiftUI's diffing and cause the bubble to flash on every
        /// chunk). Value-type semantics — mutating still re-publishes
        /// the parent `messages` array.
        var text: String
        let createdAt: Date
        let attachedScreenshot: Bool
        /// `true` while the assistant is still streaming tokens into
        /// `text`. ChatBubble renders a subtle caret + dimmed style
        /// while this is on so the player knows tokens are still
        /// arriving. Cleared the moment the stream completes.
        var isStreaming: Bool
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
        /// Visual play-order card for the "Fight" action — energy
        /// budget + ordered card plays for THIS turn.
        let combatPlan: CombatPlan?
        /// Inline observation chip ("→ Took Streamline+ · matches my pick")
        /// posted by the snapshot watcher when the live save changes.
        let tracker: TrackerNote?

        init(id: UUID = UUID(),
             role: Role, text: String,
             attachedScreenshot: Bool = false,
             isStreaming: Bool = false,
             pathPlan: PathPlan? = nil,
             rewardPlan: RewardPlan? = nil,
             shopPlan: ShopPlan? = nil,
             eventPlan: EventPlan? = nil,
             combatPlan: CombatPlan? = nil,
             tracker: TrackerNote? = nil) {
            self.id = id
            self.role = role
            self.text = text
            self.createdAt = Date()
            self.attachedScreenshot = attachedScreenshot
            self.isStreaming = isStreaming
            self.pathPlan = pathPlan
            self.rewardPlan = rewardPlan
            self.shopPlan = shopPlan
            self.eventPlan = eventPlan
            self.combatPlan = combatPlan
            self.tracker = tracker
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
        /// Navigation direction at the fork for this step, e.g. "LEFT", "RIGHT", "CENTER".
        /// Only meaningful when there is a visible choice on the map.
        let direction: String?
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

    /// Combat play-order plan for the "Fight" action. The model is told
    /// the player's hand, energy, block, HP, and the enemy intent and
    /// asked to return an ORDERED play sequence. The card view renders
    /// it like a turn checklist: "1. Defend  2. Bash → Cultist  3. Strike".
    struct CombatPlan: Equatable, Codable {
        let summary: String
        /// Energy available this turn (from the live save). Optional
        /// because the model may not always know e.g. mid-Time Eater.
        let energy: Int?
        /// Estimated incoming damage so the player sees the math.
        let incomingDamage: Int?
        /// Plays in the order they should be performed.
        let plays: [CombatPlay]
        /// Cards to keep in hand / save for next turn (e.g. "Save Bash for
        /// the second-to-last attack"). Optional.
        let reserve: [String]?
        /// One-line guidance for the next turn.
        let nextTurn: String?
    }

    struct CombatPlay: Equatable, Codable, Identifiable {
        var id: String { "\(order)-\(card)" }
        /// 1-based ordinal so the UI doesn't have to renumber.
        let order: Int
        /// Card name as it appears on the card.
        let card: String
        /// Optional target enemy name.
        let target: String?
        /// Optional why bullet (≤ 14 words).
        let why: String?
    }

    /// Snapshot-watcher observation rendered as a thin inline chip in the
    /// chat. Carries an optional verdict against the most recent advice
    /// so we can show "matches my pick" / "different from my pick" /
    /// "you skipped" without needing a model call.
    struct TrackerNote: Equatable, Codable {
        enum Kind: String, Equatable, Codable {
            case cardAdded, cardRemoved, cardUpgraded
            case relicAdded, relicLost
            case potionAdded, potionUsed
            case goldGained, goldSpent
            case hpHealed, hpLost
            case floorAdvanced
        }
        enum MatchVerdict: String, Equatable, Codable {
            case matched   // player took what we recommended
            case different // player took something we ranked but not TAKE
            case skipped   // player took nothing / skipped a reward
            case unrelated // we never gave advice for this beat
        }
        let kind: Kind
        let label: String
        let detail: String?
        let floor: Int
        let matchVerdict: MatchVerdict
        /// Optional comparison line — "I picked Streamline+", "I had it as MAYBE", etc.
        let matchComment: String?
    }

    // MARK: - Published state

    @Published private(set) var messages: [Message] = [] {
        didSet { scheduleSaveCurrentChat() }
    }
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
    /// Set by `OverlayController` so the service can notify the
    /// controller when a tracker chip or follow-up message lands —
    /// the controller needs this to bump the "unseen observations"
    /// dot on the collapsed pill. Weak to avoid a retain cycle (the
    /// controller owns AppState, which owns this service).
    weak var observerDelegate: OverlayObserverDelegate?

    /// Display to capture for screenshot context. Updated by
    /// `OverlayController` to match whichever monitor the overlay
    /// panel is currently sitting on, so the capture always grabs
    /// the game screen rather than the main display.
    var gameDisplayID: CGDirectDisplayID = CGMainDisplayID()

    init(appState: AppState) {
        self.appState = appState
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 90
        self.session = URLSession(configuration: cfg)
    }

    /// Read the live save right now (bypasses cache) AND emit any
    /// tracker chips that result from the diff against the previous
    /// snapshot. Called by the 4-second poll loop and by the manual
    /// "refresh save" button.
    ///
    /// Why both paths share this method: outcome detection needs to see
    /// every change, including the ones the user triggers by manually
    /// refreshing. Splitting "passive" vs "active" refresh would just
    /// drop tracker beats whenever the user got impatient.
    @discardableResult
    func refreshLiveSnapshot() -> STS2LiveSaveReader.LiveRunSnapshot? {
        let snap = liveReader.snapshot(saveFolder: appState?.saveFolder, forceRefresh: true)
        // Emit tracker chips for any diff. We hold the snapshot used
        // for the LAST diff separately from `liveSnapshot` so settings
        // changes that re-read the save don't double-emit deltas.
        if let snap, snap.inProgress {
            let deltas = SnapshotDelta.diff(previous: lastDiffedSnapshot, current: snap)
            for delta in deltas {
                postTracker(for: delta)
            }
            lastDiffedSnapshot = snap
        }
        
        if let newSeed = snap?.seed, newSeed != currentSeed {
            if let oldSeed = currentSeed, !messages.isEmpty {
                OverlayChatStore.save(messages: messages, for: oldSeed)
            }
            currentSeed = newSeed
            let loaded = OverlayChatStore.load(for: newSeed)
            if !loaded.isEmpty {
                messages = loaded
            } else {
                // Keep existing behavior (e.g. if we clear conversation, we might
                // end up here, but if clearConversation wiped messages and kept seed,
                // this won't trigger).
                if !messages.isEmpty {
                    messages.removeAll()
                }
            }
        }
        
        liveSnapshot = snap
        return snap
    }

    /// Cached snapshot the overlay header reads from. Keeping this on
    /// the @Published surface lets SwiftUI redraw the header without
    /// each view holding its own cache or peeking into the reader.
    @Published private(set) var liveSnapshot: STS2LiveSaveReader.LiveRunSnapshot?

    /// The snapshot we last computed a diff against. Distinct from
    /// `liveSnapshot` because the latter can refresh purely for header
    /// rendering whereas this one only advances when we've actually
    /// processed (and posted tracker chips for) the deltas.
    private var lastDiffedSnapshot: STS2LiveSaveReader.LiveRunSnapshot?
    
    private var currentSeed: String?
    private var saveChatDebounceWork: DispatchWorkItem?
    
    /// Save the current chat to disk for the active seed, debounced to avoid thrashing during streaming.
    private func scheduleSaveCurrentChat() {
        saveChatDebounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if let seed = self.currentSeed, !self.messages.isEmpty {
                OverlayChatStore.save(messages: self.messages, for: seed)
            }
        }
        saveChatDebounceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }
    
    /// Save immediately (used for forced overwrite/clear).
    private func saveCurrentChatImmediate() {
        saveChatDebounceWork?.cancel()
        if let seed = currentSeed, !messages.isEmpty {
            OverlayChatStore.save(messages: messages, for: seed)
        }
    }

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
        // Snapshot diff baseline stays — we still want tracker chips
        // for whatever happens next without first re-baselining off a
        // stale read. Setting to current snap ensures the very next
        // diff is empty (no spurious "removed everything" beat).
        lastDiffedSnapshot = liveSnapshot
        
        if let seed = currentSeed {
            OverlayChatStore.save(messages: [], for: seed) // Overwrite with empty
        }
    }

    /// Convert a snapshot delta into a tracker chip and post it into
    /// the chat. Cheap (no model call) — runs on every poll tick when
    /// something changed. Also matches the delta against the most
    /// recent structured advice so the chip can show "matches my pick"
    /// or "different from my pick".
    private func postTracker(for delta: SnapshotDelta) {
        let (verdict, comment) = matchAgainstRecentAdvice(delta: delta)
        let note = TrackerNote(
            kind: TrackerNote.Kind(rawValue: delta.kind.rawValue) ?? .floorAdvanced,
            label: delta.label,
            detail: delta.detail,
            floor: delta.floor,
            matchVerdict: verdict,
            matchComment: comment
        )
        messages.append(.init(role: .tracker, text: delta.label, tracker: note))
        observerDelegate?.notePotentiallyUnseenMessage()
        // Optional auto-follow-up: if the player took something
        // different from our TAKE pick (or skipped), the Coach posts
        // a one-line "OK noted, here's the pivot" assistant message.
        // Off uses zero tokens; on adds one ~100-token call per
        // disagreed-pick — the value of "OK Bash works if you upgrade
        // it" outweighs the cost.
        if (verdict == .different || verdict == .skipped),
           appState?.config.overlayCoachAutoFollowup == true {
            scheduleCoachFollowup(for: note)
        }
    }

    /// Fire a small streaming call asking the model to acknowledge the
    /// player's deviation and offer one-line pivot advice. We deliberately
    /// don't include the screenshot — this is a fast text-only beat
    /// meant to feel conversational, not analytical.
    ///
    /// Coalescing: only one in-flight follow-up at a time. If a second
    /// tracker fires while one is still streaming, we skip — we'd rather
    /// drop the second nudge than emit two stacked Coach replies.
    private var followupTask: Task<Void, Never>?

    private func scheduleCoachFollowup(for note: TrackerNote) {
        if followupTask != nil { return }
        guard let appState else { return }
        let provider = currentProvider()
        guard let key = OverlayKeychain.apiKey(for: provider.keychainAccount),
              !key.isEmpty else { return }
        let model = appState.config.overlayAIModel.isEmpty
            ? provider.defaultModel
            : appState.config.overlayAIModel
        let runContext = buildRunContext()
        let comment = note.matchComment ?? ""
        let userQuestion = """
        The player just \(verbForFollowup(note.kind)) "\(note.label)" on floor \(note.floor). \
        That's different from what I recommended last (\(comment)). In ONE short \
        sentence (≤ 22 words), acknowledge the pick and give one concrete pivot \
        — what to look for at the NEXT decision. Lead with "OK" or "Got it". \
        Don't restate the pick. Don't lecture. Don't apologize. No bullet \
        points; one sentence only.
        """
        let placeholder = Message(role: .assistant, text: "", isStreaming: true)
        messages.append(placeholder)
        observerDelegate?.notePotentiallyUnseenMessage()
        let placeholderID = placeholder.id

        followupTask = Task { [weak self] in
            guard let self else { return }
            defer { Task { @MainActor [weak self] in self?.followupTask = nil } }
            var accumulated = ""
            do {
                let stream = self.streamProvider(
                    provider: provider,
                    model: model,
                    apiKey: key,
                    userQuestion: userQuestion,
                    screenshotPNG: nil,
                    customSystemAddendum: appState.config.overlayCustomSystemPrompt,
                    runContext: runContext
                )
                for try await chunk in stream {
                    if Task.isCancelled { break }
                    accumulated += chunk
                    await MainActor.run {
                        if let idx = self.messages.firstIndex(where: { $0.id == placeholderID }) {
                            self.messages[idx].text = accumulated
                        }
                    }
                }
                await MainActor.run {
                    if let idx = self.messages.firstIndex(where: { $0.id == placeholderID }) {
                        self.messages[idx].isStreaming = false
                        if accumulated.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            // Drop the empty placeholder rather than leave
                            // a blank bubble — the tracker chip already
                            // told the player what we knew.
                            self.messages.remove(at: idx)
                        }
                    }
                    self.recordTokenSpend(prompt: userQuestion + runContext,
                                          response: accumulated,
                                          hadImage: false)
                }
            } catch {
                // Silent on follow-up errors — the tracker chip already
                // landed and that's the load-bearing UI. We just drop
                // the empty placeholder so it doesn't dangle.
                await MainActor.run {
                    if let idx = self.messages.firstIndex(where: { $0.id == placeholderID }) {
                        self.messages.remove(at: idx)
                    }
                }
            }
        }
    }

    private func verbForFollowup(_ kind: TrackerNote.Kind) -> String {
        switch kind {
        case .cardAdded:    return "took"
        case .cardRemoved:  return "removed"
        case .cardUpgraded: return "upgraded"
        case .relicAdded:   return "picked up the relic"
        case .relicLost:    return "lost the relic"
        case .potionAdded:  return "picked up the potion"
        case .potionUsed:   return "used the potion"
        case .goldSpent:    return "spent"
        case .goldGained:   return "gained"
        case .hpHealed:     return "healed"
        case .hpLost:       return "lost HP from"
        case .floorAdvanced: return "advanced to"
        }
    }

    /// Walk back through the recent assistant messages looking for a
    /// structured plan whose options match the player's actual pick.
    /// Returns a verdict + optional comparison line.
    ///
    /// We only look back ~6 assistant messages — older advice isn't
    /// relevant to "did you take that card?" beats. We deliberately
    /// don't fetch the model again to interpret; the matching here is
    /// pure string compare against the labels we already have.
    private func matchAgainstRecentAdvice(delta: SnapshotDelta)
        -> (TrackerNote.MatchVerdict, String?) {
        let recentAssistant = messages
            .reversed()
            .prefix(20)
            .filter { $0.role == .assistant }
            .prefix(6)

        switch delta.kind {
        case .cardAdded, .relicAdded, .potionAdded:
            // Look for the most recent reward / shop / event plan and
            // compare the label to the picked item.
            for msg in recentAssistant {
                if let plan = msg.rewardPlan {
                    if let verdict = compareLabelToReward(label: delta.label, plan: plan) {
                        return verdict
                    }
                }
                if let plan = msg.shopPlan, delta.kind == .relicAdded || delta.kind == .potionAdded || delta.kind == .cardAdded {
                    if let verdict = compareLabelToShop(label: delta.label, plan: plan) {
                        return verdict
                    }
                }
                if let plan = msg.eventPlan, delta.kind == .relicAdded || delta.kind == .potionAdded || delta.kind == .cardAdded {
                    if let verdict = compareLabelToEvent(label: delta.label, plan: plan) {
                        return verdict
                    }
                }
            }
        case .goldSpent:
            // Look for a shop plan; verify the spend roughly matches our
            // recommended buy total (within 50g — the player may have
            // skipped one MAYBE item).
            for msg in recentAssistant {
                if let plan = msg.shopPlan,
                   let start = plan.goldStart, let after = plan.goldAfter {
                    let recommended = start - after
                    let actual = abs(Int(delta.label.dropLast()) ?? 0) // "-150g"
                    if abs(recommended - actual) <= 50 {
                        return (.matched, "Matches the buy plan I laid out (\(recommended)g)")
                    }
                    return (.different, "I had the buy plan at \(recommended)g")
                }
            }
        default:
            break
        }
        return (.unrelated, nil)
    }

    private func compareLabelToReward(label: String, plan: RewardPlan)
        -> (TrackerNote.MatchVerdict, String?)? {
        guard let pick = plan.options.first(where: { labelsMatch($0.label, label) }) else {
            return nil
        }
        let take = plan.options.first(where: { $0.verdict.uppercased() == "TAKE" })
        if pick.verdict.uppercased() == "TAKE" {
            return (.matched, "Matches my pick")
        }
        if let take {
            return (.different, "I had \(take.label) as TAKE; you took \(pick.label)")
        }
        return (.different, "I had this as \(pick.verdict)")
    }

    private func compareLabelToShop(label: String, plan: ShopPlan)
        -> (TrackerNote.MatchVerdict, String?)? {
        guard let item = plan.items.first(where: { labelsMatch($0.label, label) }) else {
            return nil
        }
        if item.verdict.uppercased() == "BUY" {
            return (.matched, "Matches the buy plan")
        }
        return (.different, "I had this as \(item.verdict)")
    }

    private func compareLabelToEvent(label: String, plan: EventPlan)
        -> (TrackerNote.MatchVerdict, String?)? {
        guard let opt = plan.options.first(where: { labelsMatch($0.label, label) }) else {
            return nil
        }
        if opt.verdict.uppercased() == "TAKE" {
            return (.matched, "Matches my pick")
        }
        return (.different, "I had this as \(opt.verdict)")
    }

    /// Tolerant label matching for `Streamline+` vs `Streamline+1` vs
    /// `streamline+0`. Lowercase, strip non-alphanumerics, compare
    /// stems. The model's labels are human-friendly ("Streamline+");
    /// the snapshot labels are derived from the save's IDs after pretty
    /// printing — they're close but rarely byte-identical.
    private func labelsMatch(_ a: String, _ b: String) -> Bool {
        let na = stem(a)
        let nb = stem(b)
        if na == nb { return true }
        // Allow prefix match for cases where one side has an upgrade
        // suffix the other doesn't ("streamline" vs "streamline1").
        return na.hasPrefix(nb) || nb.hasPrefix(na)
    }

    private func stem(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        return s.lowercased().unicodeScalars
            .filter { allowed.contains($0) }
            .reduce(into: "") { $0.append(Character($1)) }
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
                text: "Add an API key under Beta → Run Coach to enable the overlay's AI advice. The Vault never sees your key — it's stored on your local disk and used only to call \(provider.displayName) directly."
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
            screenshotPNG = await captureGameScreenPNG()
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

        let model = appState.config.overlayAIModel.isEmpty
            ? provider.defaultModel
            : appState.config.overlayAIModel
        let runContext = buildRunContext()
        let systemAddendum = appState.config.overlayCustomSystemPrompt
        let streamingEnabled = appState.config.overlayStreamingEnabled

        do {
            if streamingEnabled {
                // Insert the placeholder bubble FIRST so the chat
                // visibly opens with a "the assistant is starting…"
                // beat — without this, the user sees nothing for the
                // ~300ms before the first token lands.
                let placeholder = Message(role: .assistant, text: "", isStreaming: true)
                messages.append(placeholder)
                let placeholderID = placeholder.id

                var accumulated = ""
                let stream = streamProvider(
                    provider: provider,
                    model: model,
                    apiKey: key,
                    userQuestion: question,
                    screenshotPNG: screenshotPNG,
                    customSystemAddendum: systemAddendum,
                    runContext: runContext
                )
                for try await chunk in stream {
                    accumulated += chunk
                    if let idx = messages.firstIndex(where: { $0.id == placeholderID }) {
                        messages[idx].text = accumulated
                    }
                }
                if let idx = messages.firstIndex(where: { $0.id == placeholderID }) {
                    messages[idx].isStreaming = false
                    if accumulated.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        // Empty response — replace the placeholder with
                        // a humane error so the user isn't left staring
                        // at a blank bubble.
                        messages[idx].text = "⚠︎ Provider returned no content."
                    }
                }
                recordTokenSpend(prompt: question + runContext,
                                 response: accumulated,
                                 hadImage: screenshotPNG != nil)
            } else {
                let answer = try await callProvider(
                    provider: provider,
                    model: model,
                    apiKey: key,
                    userQuestion: question,
                    screenshotPNG: screenshotPNG,
                    customSystemAddendum: systemAddendum,
                    runContext: runContext
                )
                messages.append(.init(role: .assistant, text: answer))
                recordTokenSpend(prompt: question + runContext,
                                 response: answer,
                                 hadImage: screenshotPNG != nil)
            }
            lastError = nil
            statusLine = nil
        } catch let err as OverlayAIError {
            lastError = err.message
            statusLine = nil
            // If we'd inserted a streaming placeholder, finalize it
            // with the error text so the user has one clean bubble
            // rather than an empty placeholder + a separate error.
            if let last = messages.last, last.isStreaming {
                messages[messages.count - 1].text = "⚠︎ \(err.message)"
                messages[messages.count - 1].isStreaming = false
            } else {
                messages.append(.init(role: .assistant, text: "⚠︎ \(err.message)"))
            }
        } catch {
            let msg = (error as NSError).localizedDescription
            lastError = msg
            statusLine = nil
            if let last = messages.last, last.isStreaming {
                messages[messages.count - 1].text = "⚠︎ \(msg)"
                messages[messages.count - 1].isStreaming = false
            } else {
                messages.append(.init(role: .assistant, text: "⚠︎ \(msg)"))
            }
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
        case path, cardReward, bossRelic, shop, event, combat
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
        let png = await captureGameScreenPNG()
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
        case .combat:
            if let plan: CombatPlan = decodeJSON(raw), !plan.plays.isEmpty {
                return .init(role: .assistant, text: plan.summary, combatPlan: plan)
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
      "summary": "One sentence describing the recommended route.",
      "nodes": [
        {
          "label": "Elite",
          "type": "elite",
          "direction": "LEFT",
          "why": "Eight-word reason."
        }
      ]
    }

    Constraints:
    - 3 ≤ nodes.length ≤ 5
    - "type" ∈ "combat" | "elite" | "shop" | "rest" | "event" | "chest" | "boss" | "unknown"
    - "direction": the EXACT fork to take at that step — "LEFT", "RIGHT", \
      "CENTER", or null if there is no fork (only one path forward). \
      Determine this from the MAP screenshot: look at where the current \
      position marker is and identify which branch to take next.
    - The first node MUST have a direction if there are multiple paths from \
      the current position.
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

    /// Schema for in-fight combat play-order. Returns an ordered list
    /// of plays with optional targets, plus a reserve list for cards
    /// the player should hold for next turn.
    private static let combatJSONInstructions: String = """
    Respond with exactly one JSON object — no prose before or after — \
    matching this schema:

    {
      "summary": "One-sentence rationale for this turn.",
      "energy": 3,
      "incomingDamage": 11,
      "plays": [
        { "order": 1, "card": "Defend", "target": null, "why": "Block first — incoming 11 hits Bash later." },
        { "order": 2, "card": "Bash", "target": "Cultist", "why": "Apply Vulnerable for the Strike+." },
        { "order": 3, "card": "Strike+", "target": "Cultist", "why": "Vulnerable doubles 9 → 13." }
      ],
      "reserve": ["Iron Wave"],
      "nextTurn": "Save Bash for the second-to-last attack so Vulnerable lands on the boss intent."
    }

    Constraints:
    - "energy" = energy you start the turn with (use the snapshot if available)
    - "incomingDamage" = total raw damage from enemy intents this turn (omit if unreadable)
    - Each play.card MUST be a card the player can actually play this turn (in hand and within energy budget)
    - "plays" length ≤ energy + free-card count; do NOT propose plays that exceed budget
    - Order plays so blocks happen before attacks unless the math says otherwise
    - "target" only when there are ≥2 enemies; otherwise null
    - "reserve" lists cards to KEEP in hand (e.g. Bash for next turn) — strings only, ≤ 3 entries
    - "nextTurn" ≤ 22 words
    - "why" ≤ 14 words per play
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
        let png = await captureGameScreenPNG()
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
            let combat: CombatPlan?
        }
        guard let wrapper: Wrapper = decodeJSON(raw) else {
            return .init(role: .assistant, text: raw.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let summary = (wrapper.summary?.isEmpty == false ? wrapper.summary! :
                        (wrapper.path?.summary
                         ?? wrapper.reward?.summary
                         ?? wrapper.shop?.summary
                         ?? wrapper.event?.summary
                         ?? wrapper.combat?.summary
                         ?? raw))
        return .init(
            role: .assistant,
            text: summary,
            pathPlan: wrapper.path,
            rewardPlan: wrapper.reward,
            shopPlan: wrapper.shop,
            eventPlan: wrapper.event,
            combatPlan: wrapper.combat
        )
    }

    /// Schema for the auto-assist wrapper. Every field beyond `phase`
    /// + `summary` is optional — the model only fills in the payload
    /// matching the detected phase.
    private static let assistJSONInstructions: String = """
    OUTPUT ONLY A SINGLE JSON OBJECT. No markdown, no code fences, no \
    prose before or after. Your response must start with { and end with }.

    Detect the current game phase from the screenshot, then fill in the \
    matching payload field:

    {
      "phase": "card_reward" | "boss_relic" | "shop" | "event" | "map" | "combat" | "rest" | "other",
      "summary": "One sentence stating the recommended action.",
      "path":   { ...PathPlan when phase=map... },
      "reward": { ...RewardPlan when phase=card_reward or boss_relic... },
      "shop":   { ...ShopPlan when phase=shop... },
      "event":  { ...EventPlan when phase=event... },
      "combat": { ...CombatPlan when phase=combat... }
    }

    Sub-schemas:
    PathPlan   = { "summary": "...", "nodes":   [{ "label": "Elite", "type": "elite", "direction": "LEFT", "why": "..." }] }
    RewardPlan = { "summary": "...", "kind": "card_reward" | "boss_relic", "options": [{ "label": "Bash", "verdict": "TAKE" | "MAYBE" | "SKIP", "rank": "S" | "A" | "B" | "C" | "D", "why": "...", "synergies": ["..."] }] }
    ShopPlan   = { "summary": "...", "goldStart": 145, "goldAfter": 20, "items":   [{ "label": "Pen Nib", "kind": "relic" | "card" | "potion" | "removal", "price": 150, "verdict": "BUY" | "MAYBE" | "SKIP", "why": "..." }] }
    EventPlan  = { "summary": "...", "eventName": "Big Fish", "options": [{ "label": "...", "verdict": "TAKE" | "MAYBE" | "SKIP" | "AVOID", "why": "..." }] }
    CombatPlan = { "summary": "...", "energy": 3, "incomingDamage": 11, "plays": [{ "order": 1, "card": "Defend", "target": null, "why": "..." }], "reserve": ["Bash"], "nextTurn": "..." }

    Rules:
    - If cards are visible in hand at the bottom, phase is ALWAYS "combat" — fill the combat payload.
    - If a card reward screen is visible, phase is "card_reward".
    - If a shop/merchant is visible, phase is "shop".
    - If an event choice screen is visible, phase is "event".
    - If the map/path selection is visible, phase is "map".
    - For rest / other, just set "phase" + "summary" — no payload needed.
    - All "why" / "summary" strings: ≤ 20 words.
    - NEVER output plain text. If uncertain, use phase "other" with a summary.
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

    // MARK: - Glossary miss logging
    //
    // STS2 ships new cards in every Early Access build. The bundled
    // glossary covers the high-frequency tail; everything outside it
    // means the model is reasoning from training data alone. We can't
    // ship a bigger glossary on every build, but we CAN log what we
    // missed so a future content turn knows exactly which IDs to
    // prioritize. Privacy: stays local, never uploaded.

    /// IDs we've already written to the log this process. Bounds the
    /// log to one entry per (id) per app launch — without this, a
    /// player with 25 unknowns in their deck would write 100+ log
    /// lines per minute as the snapshot poller runs.
    private var loggedGlossaryMisses: Set<String> = []

    private func logGlossaryMisses(_ ids: Set<String>, character: String?) {
        let fresh = ids.subtracting(loggedGlossaryMisses)
        guard !fresh.isEmpty else { return }
        loggedGlossaryMisses.formUnion(fresh)
        guard let url = glossaryMissLogURL() else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        let chr = character ?? "?"
        let lines = fresh.sorted().map { "\(stamp)\t\(chr)\t\($0)\n" }.joined()
        do {
            try ensureParentDir(for: url)
            if FileManager.default.fileExists(atPath: url.path) {
                if let h = try? FileHandle(forWritingTo: url) {
                    _ = try? h.seekToEnd()
                    try? h.write(contentsOf: Data(lines.utf8))
                    try? h.close()
                }
            } else {
                let header = "# Slay the Spire 2 glossary misses — IDs in live decks not in STS2CardGlossary.\n# Format: <iso-stamp>\\t<character>\\t<id>\n"
                try (header + lines).data(using: .utf8)?.write(to: url, options: .atomic)
            }
        } catch {
            // Log writes are best-effort — silent failure is fine, the
            // user's gameplay is unaffected.
        }
    }

    private func glossaryMissLogURL() -> URL? {
        guard let support = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }
        return support
            .appendingPathComponent("SpireVault", isDirectory: true)
            .appendingPathComponent("missing-cards.log", isDirectory: false)
    }

    private func ensureParentDir(for url: URL) throws {
        let dir = url.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(
                at: dir, withIntermediateDirectories: true
            )
        }
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
            Look at the map screenshot. I need to know exactly which \
            branch to take RIGHT NOW — LEFT, RIGHT, or CENTER fork. \
            Then plan the best 3–5 node route. For each node with a \
            visible fork choice, state the direction explicitly. Use \
            my live deck, relics, HP, and gold. Prefer elites/shops \
            when my build wants them, rests when low. End the sequence \
            at the next act checkpoint.
            """,
            schema: Self.pathJSONInstructions,
            statusVerb: "Reading map"
        )
    }

    /// In-fight tactical advice. Returns a structured `CombatPlan` so
    /// the chat renders an energy-budgeted, ordered play list with
    /// targets and a "save for next turn" reserve. Saves the player
    /// from rereading prose every turn.
    func askCombat() async {
        var question = """
        I'm mid-combat. Read my hand, current energy, block, HP, and \
        every enemy's intent. Output an ORDERED list of plays that \
        respects my energy budget and minimizes net HP loss this turn. \
        Cross-reference card costs against my actual cards (deck \
        glossary in the context block). Mark cards I should HOLD for \
        next turn under "reserve".
        """
        
        if let lastCombat = messages.reversed().first(where: { $0.combatPlan != nil })?.combatPlan {
            let previousPlays = lastCombat.plays.map { play in
                let targetStr = play.target.flatMap { " -> \($0)" } ?? ""
                return "\(play.order). \(play.card)\(targetStr)"
            }.joined(separator: ", ")
            
            question += "\n\nContext: Last turn you advised me to play: [\(previousPlays)]."
            if let nextTurn = lastCombat.nextTurn {
                question += " You also noted for this turn: \"\(nextTurn)\"."
            }
            question += " Consider this previous advice if it's still relevant to the current board state."
        }
        
        await runStructured(
            kind: .combat,
            userQuestion: question,
            schema: Self.combatJSONInstructions,
            statusVerb: "Planning turn"
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
        let history = chatHistoryForPrompt()
        do {
            switch provider {
            case .openai:
                return try await callOpenAI(model: model, apiKey: apiKey,
                                            system: system,
                                            userQuestion: userQuestion,
                                            screenshotPNG: screenshotPNG,
                                            history: history)
            case .anthropic:
                return try await callAnthropic(model: model, apiKey: apiKey,
                                               system: system,
                                               userQuestion: userQuestion,
                                               screenshotPNG: screenshotPNG,
                                               history: history)
            }
        } catch {
            let nsErr = error as NSError
            let isTLSOrNetwork = nsErr.domain == NSURLErrorDomain &&
                [NSURLErrorSecureConnectionFailed,
                 NSURLErrorNetworkConnectionLost,
                 NSURLErrorTimedOut,
                 NSURLErrorCannotConnectToHost].contains(nsErr.code)
            guard isTLSOrNetwork else { throw error }
            try await Task.sleep(nanoseconds: 600_000_000)
            switch provider {
            case .openai:
                return try await callOpenAI(model: model, apiKey: apiKey,
                                            system: system,
                                            userQuestion: userQuestion,
                                            screenshotPNG: screenshotPNG,
                                            history: history)
            case .anthropic:
                return try await callAnthropic(model: model, apiKey: apiKey,
                                               system: system,
                                               userQuestion: userQuestion,
                                               screenshotPNG: screenshotPNG,
                                               history: history)
            }
        }
    }

    /// Shape the conversation history into a chronological list of
    /// `(role, text)` pairs the providers can both consume. We trim to
    /// the last ~12 messages so a long session doesn't blow the context
    /// window — the recap action is the right tool for "remember
    /// everything".
    private func chatHistoryForPrompt() -> [(Message.Role, String)] {
        // Drop both `system` and `tracker` rows — trackers are internal
        // observations from the snapshot watcher, not real conversation
        // turns. Forwarding them to the model would just dilute the
        // history with "Took Streamline+" lines.
        let kept = messages.suffix(12).filter { $0.role == .user || $0.role == .assistant }
        return kept.map { ($0.role, $0.text) }
    }

    private func baseSystemPrompt(addendum: String, runContext: String) -> String {
        var lines: [String] = [
            "You are an in-game Slay the Spire 2 run coach embedded in The Vault, a macOS companion app.",
            "Speak like an experienced friend coaching the player live: short, concrete, decision-first.",
            "When a [live-run-snapshot] block is provided below, TRUST IT as the source of truth for the player's deck, relics, HP, gold, character, ascension, and game mode. The screenshot is just the current decision UI — combine the snapshot with the screenshot to give specific advice.",
            "When a [deck-glossary] block is provided, TRUST ITS card and relic effects over your training data. STS2 has reworked many cards from STS1 and added new ones (e.g. Necrobinder cards) — the glossary is canonical.",
            "When a [glossary-misses] block lists IDs, those are cards/relics not yet in our bundled glossary. For those specifically, hedge: name the card/relic, but say something like \"I'm not 100% sure of its current STS2 effect — verify the card text on screen.\" Don't fabricate confident effects for them.",
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
        let snap = liveSnapshot ?? liveReader.snapshot(saveFolder: appState.saveFolder)
        if let snap, snap.inProgress {
            bits.append(snap.promptBlock())
            // Glossary: only include entries that match cards / relics
            // ACTUALLY in the player's deck. Bounds the prompt size to
            // O(deck size) instead of O(every card in the game), and
            // means the model gets exactly the references it needs to
            // reason about THIS run's deck without fluff.
            let glossary = STS2CardGlossary.glossaryBlock(
                deckCards: snap.deck,
                relicIDs: snap.relics,
                characterHint: snap.character
            )
            if !glossary.isEmpty {
                bits.append("[deck-glossary] // canonical effects for cards / relics in your live deck — TRUST THESE over your training data\n" + glossary)
            }
            // Log any unknown card / relic IDs once per process so we
            // can expand the glossary in future builds. Silent on the
            // happy path (nothing missing). Also tells the model to
            // hedge on the unknowns.
            let unmatched = STS2CardGlossary.unmatchedIdentifiers(
                deckCards: snap.deck,
                relicIDs: snap.relics,
                characterHint: snap.character
            )
            if !unmatched.isEmpty {
                logGlossaryMisses(unmatched, character: snap.character)
                let listed = unmatched.sorted().joined(separator: ", ")
                bits.append("[glossary-misses] // these IDs aren't in the bundled glossary — be cautious quoting their effects: \(listed)")
            }
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

    // MARK: - Streaming
    //
    // Token-by-token responses for free-form chat. Both providers speak
    // SSE — OpenAI uses the OpenAI-flavored "data: {json}\n\n" framing
    // with a final "data: [DONE]" sentinel; Anthropic uses the messages
    // API streaming format with named events (`content_block_delta`,
    // `message_stop`).
    //
    // We expose a single `streamProvider(...)` AsyncThrowingStream<String>
    // that yields incremental text chunks, then completes (or throws).
    // The caller is responsible for accumulating the chunks into a UI
    // bubble — the stream itself is stateless.
    //
    // Why structured calls don't go through here: a JSON object can't
    // render until it's fully parsed, and a half-streamed JSON would
    // either look like garbage or trigger a parse failure on every
    // intermediate token. For structured paths the value of streaming
    // is roughly zero; for free-form chat it's the difference between
    // "the chat is alive" and "the chat is broken".

    private func streamProvider(
        provider: Provider,
        model: String,
        apiKey: String,
        userQuestion: String,
        screenshotPNG: Data?,
        customSystemAddendum: String,
        runContext: String
    ) -> AsyncThrowingStream<String, Error> {
        let system = baseSystemPrompt(addendum: customSystemAddendum, runContext: runContext)
        switch provider {
        case .openai:
            return streamOpenAI(model: model, apiKey: apiKey, system: system,
                                userQuestion: userQuestion, screenshotPNG: screenshotPNG,
                                history: chatHistoryForPrompt())
        case .anthropic:
            return streamAnthropic(model: model, apiKey: apiKey, system: system,
                                   userQuestion: userQuestion, screenshotPNG: screenshotPNG,
                                   history: chatHistoryForPrompt())
        }
    }

    private func streamOpenAI(
        model: String,
        apiKey: String,
        system: String,
        userQuestion: String,
        screenshotPNG: Data?,
        history: [(Message.Role, String)]
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                    var msgs: [[String: Any]] = []
                    msgs.append(["role": "system", "content": system])
                    for (role, text) in history.dropLast() {
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
                    msgs.append(["role": "user", "content": lastUser])

                    let body: [String: Any] = [
                        "model": model,
                        "messages": msgs,
                        "max_tokens": 700,
                        "temperature": 0.4,
                        "stream": true,
                    ]
                    req.httpBody = try JSONSerialization.data(withJSONObject: body)

                    let (bytes, resp) = try await session.bytes(for: req)
                    if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                        // Drain the body so we can show a real error
                        // message instead of just "HTTP 401".
                        var bodyData = Data()
                        for try await byte in bytes { bodyData.append(byte) }
                        throw OverlayAIError.network(
                            parseProviderError(data: bodyData,
                                               status: http.statusCode,
                                               provider: "OpenAI")
                        )
                    }

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        // OpenAI prefixes every event with "data: ".
                        // The terminal sentinel is literally "data: [DONE]".
                        guard line.hasPrefix("data: ") else { continue }
                        let payload = String(line.dropFirst(6))
                        if payload == "[DONE]" { break }
                        guard let data = payload.data(using: .utf8),
                              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let choices = obj["choices"] as? [[String: Any]],
                              let delta = choices.first?["delta"] as? [String: Any],
                              let chunk = delta["content"] as? String,
                              !chunk.isEmpty
                        else { continue }
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func streamAnthropic(
        model: String,
        apiKey: String,
        system: String,
        userQuestion: String,
        screenshotPNG: Data?,
        history: [(Message.Role, String)]
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
                    req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")

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
                        "stream": true,
                    ]
                    req.httpBody = try JSONSerialization.data(withJSONObject: body)

                    let (bytes, resp) = try await session.bytes(for: req)
                    if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                        var bodyData = Data()
                        for try await byte in bytes { bodyData.append(byte) }
                        throw OverlayAIError.network(
                            parseProviderError(data: bodyData,
                                               status: http.statusCode,
                                               provider: "Anthropic")
                        )
                    }

                    // Anthropic sends pairs of `event: <name>` and
                    // `data: <json>` lines per SSE message. We only care
                    // about `content_block_delta` events with a text
                    // delta — `ping`, `message_start`, etc. are
                    // headers we can ignore for the streaming UI.
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard line.hasPrefix("data: ") else { continue }
                        let payload = String(line.dropFirst(6))
                        guard let data = payload.data(using: .utf8),
                              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let type = obj["type"] as? String
                        else { continue }
                        if type == "message_stop" { break }
                        if type == "content_block_delta",
                           let delta = obj["delta"] as? [String: Any],
                           let chunk = delta["text"] as? String,
                           !chunk.isEmpty {
                            continuation.yield(chunk)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Screenshot capture

    /// Primary capture path: ScreenCaptureKit (macOS 14+).
    ///
    /// SCKit is the only API that reliably captures Metal-rendered game
    /// content (STS2 is a Unity/Metal app). CGDisplayCreateImage reads
    /// the legacy compositor layer and misses Metal windows entirely.
    ///
    /// We also exclude The Vault's own process from the capture so the
    /// overlay panel doesn't obscure the game in the AI's screenshot.
    @available(macOS 14.0, *)
    private func captureWithSCKit() async -> Data? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == gameDisplayID })
                               ?? content.displays.first else { return nil }

            let excluded = content.applications.filter {
                $0.bundleIdentifier == "com.coreycrooks.thevault.app"
            }
            let filter = SCContentFilter(
                display: display,
                excludingApplications: excluded,
                exceptingWindows: []
            )

            let cfg = SCStreamConfiguration()
            // Capture at full display resolution; scaledPNG downscales to 1280px.
            cfg.width = display.width
            cfg.height = display.height

            let cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: cfg
            )
            return scaledPNG(from: cgImage, maxDimension: 1280)
        } catch {
            return nil
        }
    }

    /// Async wrapper: tries ScreenCaptureKit first, falls back to the
    /// legacy CGDisplayCreateImage path for macOS 13.
    func captureGameScreenPNG() async -> Data? {
        if #available(macOS 14.0, *) {
            if let png = await captureWithSCKit() { return png }
        }
        // macOS 13 fallback — doesn't capture Metal windows but is better
        // than nothing and works for non-Metal overlay content.
        return captureActiveDisplayPNG(maxDimension: 1280, displayID: gameDisplayID)
    }

    /// Shared PNG encoder: downscales a CGImage to fit within `maxDimension`
    /// and encodes it as PNG. Used by both the SCKit and legacy paths.
    nonisolated func scaledPNG(from cgImage: CGImage, maxDimension: CGFloat = 1280) -> Data? {
        let w = CGFloat(cgImage.width)
        let h = CGFloat(cgImage.height)
        let scale = min(1, maxDimension / max(w, h))
        let targetW = Int((w * scale).rounded())
        let targetH = Int((h * scale).rounded())
        let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: targetW, height: targetH))
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

    /// Legacy synchronous capture via CoreGraphics. Kept for macOS 13
    /// fallback; does NOT capture Metal-rendered game windows on macOS 14+.
    nonisolated func captureActiveDisplayPNG(maxDimension: CGFloat = 1280,
                                              displayID: CGDirectDisplayID = CGMainDisplayID()) -> Data? {
        guard let cgImage = CGDisplayCreateImage(displayID) else { return nil }
        return scaledPNG(from: cgImage, maxDimension: maxDimension)
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
import Foundation

@MainActor
final class OverlayChatStore {
    
    private static func chatFileURL(for seed: String) -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                               in: .userDomainMask).first!
        let chatsDir = support
            .appendingPathComponent("AscensionCompanion", isDirectory: true)
            .appendingPathComponent("vault", isDirectory: true)
            .appendingPathComponent("chats", isDirectory: true)
        
        try? FileManager.default.createDirectory(at: chatsDir, withIntermediateDirectories: true)
        
        // Strip out any weird characters from seed just in case
        let safeSeed = seed.components(separatedBy: .alphanumerics.inverted).joined()
        return chatsDir.appendingPathComponent("\(safeSeed).json")
    }
    
    static func save(messages: [OverlayAIService.Message], for seed: String) {
        guard !messages.isEmpty else { return }
        let url = chatFileURL(for: seed)
        do {
            let data = try JSONEncoder().encode(messages)
            try data.write(to: url, options: .atomic)
        } catch {
            print("Failed to save chat for seed \(seed): \(error)")
        }
    }
    
    static func load(for seed: String) -> [OverlayAIService.Message] {
        let url = chatFileURL(for: seed)
        guard let data = try? Data(contentsOf: url),
              let messages = try? JSONDecoder().decode([OverlayAIService.Message].self, from: data) else {
            return []
        }
        return messages
    }
}
