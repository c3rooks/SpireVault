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
        var suggestedModels: [String] {
            switch self {
            case .openai:    return ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"]
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
    /// just a role + body. If we ever need richer rendering (Markdown,
    /// citations, structured advice), we layer it on top of `text`.
    struct Message: Identifiable, Equatable {
        let id: UUID
        enum Role: Equatable { case user, assistant, system }
        let role: Role
        let text: String
        let createdAt: Date
        let attachedScreenshot: Bool
        init(role: Role, text: String, attachedScreenshot: Bool = false) {
            self.id = UUID()
            self.role = role
            self.text = text
            self.createdAt = Date()
            self.attachedScreenshot = attachedScreenshot
        }
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

    init(appState: AppState) {
        self.appState = appState
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 90
        self.session = URLSession(configuration: cfg)
    }

    // MARK: - Public actions

    /// Reset the visible chat. Doesn't touch the API key.
    func clearConversation() {
        messages.removeAll()
        lastError = nil
        statusLine = nil
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

    /// Cluely-style "What should I do?" — the same prompt but framed for
    /// the active screen. Always attaches the screenshot when allowed,
    /// even if the user disabled per-message attach.
    func whatShouldIDo() async {
        await ask("What should I do right now? Look at the screen and give me ONE recommended action with a confidence level and a short why. Be concrete — name the card / relic / path / shop item.",
                  includeScreenshot: true)
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
            "When the player attaches a screenshot, treat it as the source of truth for what's on screen.",
            "If you can't read the screen confidently, say so and ask for the specific decision.",
            "Slay the Spire 2 is in Early Access — only 3 acts and Ascension caps at A9. Do not invent acts, relics, or characters.",
            "Never claim to read game memory. You only see what the player explicitly shares.",
            "When recommending a single action, lead with the action sentence, then up to 3 short why-bullets.",
        ]
        if !runContext.isEmpty {
            lines.append("\nPlayer context (from local run history):")
            lines.append(runContext)
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
    private func buildRunContext() -> String {
        guard let appState else { return "" }
        var bits: [String] = []
        if let p = appState.steamAuth.profile {
            bits.append("Steam: \(p.personaName) (\(p.steamID))")
            if let s = p.stats {
                bits.append("Stats: \(s.totalRuns) runs · \(s.wins) wins · best A\(s.maxAscension)\(s.preferredCharacter.map { " · main \($0)" } ?? "")")
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
        return bits.joined(separator: "\n")
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
        var url = URL(string: "https://api.openai.com/v1/chat/completions")!
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
        _ = url

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
