import SwiftUI
import VaultCore

// =========================================================================
// BetaView
// -------------------------------------------------------------------------
// Dedicated home for early / experimental features. The first inhabitant
// is the Run Coach overlay — a Cluely-style floating AI panel that sits
// over Slay the Spire 2 and answers "what should I do?" with screenshot
// context.
//
// This screen is intentionally NOT mentioned on the public marketing
// site. The product surface is "ship a small, trustworthy in-game coach
// that the player explicitly opted into," not "claim AI features on the
// landing page before they're proven."
//
// Layout, top → bottom:
//   1. Hero panel — what the Run Coach is, hotkeys, visual demo strip.
//   2. Enable toggle + position reset.
//   3. AI provider picker (OpenAI / Anthropic) and model.
//   4. API key field (stored on disk in Application Support — see
//      OverlayKeychain.swift for the v0.9.5 move off the macOS
//      keychain to a file-backed store; the type name is preserved
//      for call-site continuity).
//   5. Privacy switches (screenshot, hide-from-capture, always-on-top).
//   6. Custom system prompt addendum.
//   7. Live test panel — an inline copy of the chat for verifying setup
//      without leaving the tab.
// =========================================================================

struct BetaView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        ZStack {
            Theme.bgPrimary.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    heroBlock
                    enableBlock
                    aiProviderBlock
                    apiKeyBlock
                    privacyBlock
                    customPromptBlock
                    liveTestBlock
                    disclaimerFooter
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 24)
                .frame(maxWidth: 880, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - Hero

    private var heroBlock: some View {
        HStack(alignment: .top, spacing: 18) {
            Image("VaultEmblem")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Theme.gold.opacity(0.5), lineWidth: 1)
                )
                .shadow(color: Theme.accent.opacity(0.4), radius: 12)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("BETA")
                        .font(.system(size: 9, weight: .heavy, design: .rounded))
                        .tracking(1.6)
                        .foregroundStyle(Theme.accentBright)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Theme.accent.opacity(0.16)))
                        .overlay(Capsule().stroke(Theme.accent.opacity(0.6), lineWidth: 1))
                    Text("Run Coach")
                        .font(.system(size: 22, weight: .heavy, design: .serif))
                        .foregroundStyle(Theme.text)
                }
                Text("A floating AI panel that sits over Slay the Spire 2 and answers \"what should I do?\" with the actual screen as context. Bring your own API key — your screenshots and questions go straight to OpenAI or Anthropic, never through The Vault.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    badge("Optional")
                    badge("Bring your own key")
                    badge("Hidden from screen capture")
                    badge("Cmd+Enter to ask")
                }
                .padding(.top, 4)
            }
            Spacer(minLength: 0)
        }
        .premiumPanel(padding: 22, cornerRadius: 16)
    }

    private func badge(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 10, weight: .heavy))
            .tracking(0.5)
            .foregroundStyle(Theme.text.opacity(0.85))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.white.opacity(0.06)))
            .overlay(Capsule().stroke(Color.white.opacity(0.15), lineWidth: 1))
    }

    // MARK: - Enable

    private var enableBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Overlay", systemImage: "rectangle.on.rectangle")
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Enable the Run Coach overlay")
                            .font(.system(size: 13, weight: .heavy))
                            .foregroundStyle(Theme.textPrimary)
                        Text("A small pill appears at the top of your screen. Click it (or hit \(Image(systemName: "command")) ↵) to ask the Coach about whatever STS2 decision you're staring at.")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 12)
                    Toggle("", isOn: Binding(
                        get: { state.overlayController.enabled },
                        set: { state.overlayController.enabled = $0 }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }
                if state.overlayController.enabled {
                    HStack(spacing: 8) {
                        // Wipes the persisted top-left and rebuilds the
                        // panel at the default top-center origin. Toggling
                        // `enabled` off → on is the cleanest way to do this:
                        // `hide()` resets mode to .pill (so a chat-mode
                        // session won't reopen at chat size), and the next
                        // `show()` reads the now-nil origin.
                        Button("Reset position to top center") {
                            state.config.overlayOriginX = nil
                            state.config.overlayOriginY = nil
                            state.config.save()
                            state.overlayController.enabled = false
                            state.overlayController.enabled = true
                        }
                        .controlSize(.small)
                        // "Show now" used to force-expand chat as a
                        // debugging affordance. With the controller now
                        // resetting to .pill on every hide(), the more
                        // honest behavior is "bring the pill forward and
                        // let the user click into chat themselves."
                        Button("Bring overlay to front") {
                            state.overlayController.show()
                        }
                        .controlSize(.small)
                    }
                } else {
                    Text("Disabled. Toggle on to bring the pill back at the top of your main display.")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            .premiumPanel(padding: 14, cornerRadius: 10)
        }
    }

    // MARK: - AI provider

    private var aiProviderBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("AI provider", systemImage: "brain.head.profile")
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    ForEach(OverlayAIService.Provider.allCases) { p in
                        ProviderTile(
                            provider: p,
                            selected: state.config.overlayAIProviderRaw == p.rawValue
                        ) {
                            selectProvider(p)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Model")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(Theme.textSecondary)
                    Picker("", selection: Binding(
                        get: { state.config.overlayAIModel },
                        set: { state.config.overlayAIModel = $0; state.config.save() }
                    )) {
                        ForEach(currentProvider().suggestedModels, id: \.self) { m in
                            Text(m).tag(m)
                        }
                        // If the persisted model isn't in the suggested
                        // list (custom override), surface it so the user
                        // sees what's actually being sent.
                        if !currentProvider().suggestedModels.contains(state.config.overlayAIModel) {
                            Text("\(state.config.overlayAIModel) (custom)").tag(state.config.overlayAIModel)
                        }
                    }
                    .labelsHidden()
                    .controlSize(.small)
                    Text("You can also enter a custom model identifier in the field below to point at a specific snapshot.")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textTertiary)
                    HStack(spacing: 8) {
                        TextField("custom model id", text: Binding(
                            get: { state.config.overlayAIModel },
                            set: { state.config.overlayAIModel = $0; state.config.save() }
                        ))
                        .textFieldStyle(.plain)
                        .font(.system(size: 11, design: .monospaced))
                        .padding(8)
                        .background(Theme.cardBG, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6)
                            .stroke(Theme.cardBorder, lineWidth: 1))
                        Button("Reset to default") {
                            state.config.overlayAIModel = currentProvider().defaultModel
                            state.config.save()
                        }
                        .controlSize(.small)
                    }
                }
            }
            .premiumPanel(padding: 14, cornerRadius: 10)
        }
    }

    private func selectProvider(_ p: OverlayAIService.Provider) {
        state.config.overlayAIProviderRaw = p.rawValue
        state.config.overlayAIModel = p.defaultModel
        state.config.save()
    }

    // MARK: - API key

    private var apiKeyBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("API key", systemImage: "key.fill", accent: Theme.gold)
            APIKeyEditor(
                provider: currentProvider()
            )
            .premiumPanel(padding: 14, cornerRadius: 10)
        }
    }

    // MARK: - Privacy

    private var privacyBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Privacy & visibility", systemImage: "lock.shield")
            VStack(alignment: .leading, spacing: 14) {
                privacyToggle(
                    title: "Attach screenshot to questions",
                    sub: "When on, the active display is captured (downscaled to ~1280px) and sent with your question. Off = text-only mode using your tagged context.",
                    isOn: Binding(
                        get: { state.config.overlayAttachScreenshot },
                        set: { state.config.overlayAttachScreenshot = $0; state.config.save() }
                    )
                )
                Divider().background(Theme.cardBorder.opacity(0.5))
                privacyToggle(
                    title: "Hidden from screen recording",
                    sub: "Sets the panel's NSWindow.sharingType so OBS, Zoom, QuickTime, and macOS screen capture can't see it. Streamers want this on; Discord screenshare-the-coach use cases want it off.",
                    isOn: Binding(
                        get: { state.config.overlayInvisibleToCapture },
                        set: {
                            state.config.overlayInvisibleToCapture = $0
                            state.config.save()
                            state.overlayController.reapplyWindowFlags()
                        }
                    )
                )
                Divider().background(Theme.cardBorder.opacity(0.5))
                privacyToggle(
                    title: "Always on top",
                    sub: "Floats over fullscreen STS2. Off uses the normal window level so the Coach hides behind the game.",
                    isOn: Binding(
                        get: { state.config.overlayAlwaysOnTop },
                        set: {
                            state.config.overlayAlwaysOnTop = $0
                            state.config.save()
                            state.overlayController.reapplyWindowFlags()
                        }
                    )
                )
            }
            .premiumPanel(padding: 14, cornerRadius: 10)
        }
    }

    private func privacyToggle(title: String, sub: String, isOn: Binding<Bool>) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(Theme.textPrimary)
                Text(sub)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            Toggle("", isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }

    // MARK: - Custom system prompt

    private var customPromptBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Custom instructions", systemImage: "text.alignleft")
            VStack(alignment: .leading, spacing: 8) {
                Text("Optional. Appended to the default Slay the Spire 2 coaching prompt. Use it to bias the Coach toward a specific character build, ascension level, or playstyle.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                TextEditor(text: Binding(
                    get: { state.config.overlayCustomSystemPrompt },
                    set: { state.config.overlayCustomSystemPrompt = $0; state.config.save() }
                ))
                .font(.system(size: 11, design: .monospaced))
                .frame(minHeight: 88, maxHeight: 160)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(Theme.bgDeep, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.cardBorder, lineWidth: 1))
            }
            .premiumPanel(padding: 14, cornerRadius: 10)
        }
    }

    // MARK: - Live test

    private var liveTestBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Live test", systemImage: "checkmark.circle")
            VStack(alignment: .leading, spacing: 12) {
                Text("Verify your API key + provider work without launching the overlay. Asks the Coach a single question; responses appear below.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                HStack(spacing: 8) {
                    Button {
                        Task { await state.aiService.ask("Self-check: introduce yourself in one sentence as the Run Coach. Don't ask for a screenshot.", includeScreenshot: false) }
                    } label: {
                        Label("Test connection", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .controlSize(.small)
                    .disabled(state.aiService.isThinking || !OverlayKeychain.hasKey(for: currentProvider().keychainAccount))
                    Button {
                        Task { await state.aiService.whatShouldIDo() }
                    } label: {
                        Label("Capture screen + ask", systemImage: "camera.viewfinder")
                    }
                    .controlSize(.small)
                    .disabled(state.aiService.isThinking || !OverlayKeychain.hasKey(for: currentProvider().keychainAccount))
                    Spacer()
                    Button {
                        state.aiService.clearConversation()
                    } label: {
                        Label("Clear", systemImage: "trash")
                    }
                    .controlSize(.small)
                    .disabled(state.aiService.messages.isEmpty)
                }
                if !state.aiService.messages.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(state.aiService.messages.suffix(6)) { msg in
                            messageRow(msg)
                        }
                    }
                    .padding(10)
                    .background(Theme.bgDeep)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.cardBorder, lineWidth: 1))
                }
                if state.aiService.isThinking {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Thinking…")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                if let err = state.aiService.lastError {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.lossBright)
                }
            }
            .premiumPanel(padding: 14, cornerRadius: 10)
        }
    }

    private func messageRow(_ msg: OverlayAIService.Message) -> some View {
        let isUser = msg.role == .user
        return HStack(alignment: .top, spacing: 8) {
            Text(isUser ? "YOU" : "COACH")
                .font(.system(size: 9, weight: .heavy, design: .rounded))
                .tracking(1.5)
                .foregroundStyle(isUser ? Theme.accent : Theme.gold)
                .frame(width: 50, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                if isUser, msg.attachedScreenshot {
                    Label("Screen attached", systemImage: "photo.fill")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundStyle(Theme.textTertiary)
                }
                Text(msg.text)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Disclaimer

    private var disclaimerFooter: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("How this works")
                .font(.system(size: 11, weight: .heavy))
                .foregroundStyle(Theme.textSecondary)
            Text("• The Run Coach never modifies Slay the Spire 2. It doesn't read game memory, inject DLLs, automate gameplay, or replace your decisions.\n• Screenshots and questions go directly from your Mac to your chosen provider (OpenAI or Anthropic) using your API key. The Vault servers see none of it.\n• Your API key is stored on your local disk in ~/Library/Application Support/AscensionCompanion/vault/overlay-keys.json (perms 0600, scrambled at rest). It never leaves your Mac except in the request headers to the provider you picked.\n• This is Beta. The marketing site doesn't claim AI features — they ship here first, in front of real players, before they go on the front page.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(Theme.bgDeep)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.cardBorder, lineWidth: 1))
    }

    // MARK: - Helpers

    private func currentProvider() -> OverlayAIService.Provider {
        OverlayAIService.Provider(rawValue: state.config.overlayAIProviderRaw) ?? .openai
    }
}

// =========================================================================
// ProviderTile
// =========================================================================

private struct ProviderTile: View {
    let provider: OverlayAIService.Provider
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: provider == .openai ? "circle.hexagongrid.fill" : "triangle.fill")
                    .font(.system(size: 14, weight: .heavy))
                    .foregroundStyle(selected ? Theme.accent : Theme.textSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(provider.displayName)
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundStyle(Theme.textPrimary)
                    Text(hasKey
                         ? "API key on file"
                         : "No API key yet")
                    .font(.system(size: 10))
                    .foregroundStyle(hasKey ? Theme.winBright : Theme.textTertiary)
                }
                Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(selected ? Theme.accent : Theme.textTertiary)
            }
            .padding(12)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Theme.accentSoft : Theme.cardBG)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? Theme.accent : Theme.cardBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var hasKey: Bool {
        OverlayKeychain.hasKey(for: provider.keychainAccount)
    }
}

// =========================================================================
// APIKeyEditor
// -------------------------------------------------------------------------
// Secure-text input for the active provider's API key. Reads directly
// from the keychain on appear; on save, writes to keychain and surfaces
// a "Saved" affordance for ~2s. Hidden by default — clicking the eye
// shows the key in plain text so the user can verify a paste.
// =========================================================================

private struct APIKeyEditor: View {
    let provider: OverlayAIService.Provider

    @State private var typed: String = ""
    @State private var revealed: Bool = false
    @State private var status: String? = nil
    @State private var keyOnFile: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(provider.displayName) API key")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(Theme.textPrimary)
                    Text(provider.apiKeyHint)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.textTertiary)
                }
                Spacer()
                if keyOnFile {
                    Label("On file", systemImage: "lock.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.winBright)
                }
            }

            HStack(spacing: 8) {
                Group {
                    if revealed {
                        TextField(provider.apiKeyHint, text: $typed)
                            .textFieldStyle(.plain)
                            .font(.system(size: 11, design: .monospaced))
                    } else {
                        SecureField(provider.apiKeyHint, text: $typed)
                            .textFieldStyle(.plain)
                            .font(.system(size: 11, design: .monospaced))
                    }
                }
                .padding(8)
                .background(Theme.cardBG, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.cardBorder, lineWidth: 1))

                Button {
                    revealed.toggle()
                } label: {
                    Image(systemName: revealed ? "eye.slash" : "eye")
                }
                .buttonStyle(.plain)
                .controlSize(.small)
                .help(revealed ? "Hide key" : "Show key")

                Button("Save") {
                    save()
                }
                .controlSize(.small)
                .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Remove") {
                    OverlayKeychain.delete(account: provider.keychainAccount)
                    typed = ""
                    keyOnFile = false
                    status = "Removed."
                }
                .controlSize(.small)
                .disabled(!keyOnFile && typed.isEmpty)
            }

            if let s = status {
                Text(s)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.winBright)
            }
            Text("Your key is stored locally at ~/Library/Application Support/AscensionCompanion/vault/overlay-keys.json (file perms 0600, scrambled at rest). It's sent only in `Authorization` / `x-api-key` headers to the provider you select. The Vault server never sees it.")
                .font(.system(size: 10))
                .foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear { refreshFromStore() }
        .onChange(of: provider) { _ in refreshFromStore() }
    }

    private func refreshFromStore() {
        keyOnFile = OverlayKeychain.hasKey(for: provider.keychainAccount)
        // Don't pre-fill the field with the stored secret — make the user
        // explicitly paste again to change it. That avoids a "show key"
        // surfacing the stored value and matches the way 1Password and
        // similar tools handle credential edits.
        typed = ""
        status = keyOnFile ? "API key on file. Paste a new key + Save to replace it." : nil
    }

    private func save() {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let ok = OverlayKeychain.setAPIKey(trimmed, for: provider.keychainAccount)
        if ok {
            keyOnFile = true
            typed = ""
            status = "Saved."
        } else {
            status = "Couldn't write the key file. Check disk space and the Application Support folder permissions."
        }
    }
}
