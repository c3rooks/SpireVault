import SwiftUI
import VaultCore

// =========================================================================
// OverlayRootView
// -------------------------------------------------------------------------
// The Cluely-inspired in-game AI coach. Three cohabiting modes inside the
// same NSPanel, switched on `controller.mode`:
//
//   • Pill     — narrow status bar at the top of the screen with the
//                live run snapshot (Defect A6 · F12 · 57/75 · 145g) and
//                a single ⚡ Coach trigger.
//   • Chat     — full panel: live run header, conversation, command-
//                palette chips for each game phase, input row, footer.
//   • Settings — provider tiles, API key field, privacy toggles. So the
//                player can configure the coach without leaving the
//                fullscreen game to find the Beta tab.
//
// All three render on a custom glass background (NSVisualEffectView
// behind a soft tint) so the panel reads as a system surface even when
// floated over a fullscreen game.
// =========================================================================

struct OverlayRootView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    var body: some View {
        ZStack {
            OverlayGlassBackground(cornerRadius: cornerRadius(for: controller.mode))
            Group {
                switch controller.mode {
                case .pill:
                    OverlayPillView(controller: controller)
                        .transition(.opacity.combined(with: .scale(scale: 0.98)))
                case .chat:
                    OverlayExpandedView(controller: controller)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                case .settings:
                    OverlaySettingsView(controller: controller)
                        .transition(.opacity.combined(with: .move(edge: .trailing)))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .clipShape(
            RoundedRectangle(cornerRadius: cornerRadius(for: controller.mode), style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius(for: controller.mode), style: .continuous)
                .strokeBorder(LinearGradient(colors: [
                    Color.white.opacity(0.18),
                    Color.white.opacity(0.04),
                ], startPoint: .top, endPoint: .bottom), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.45), radius: 22, y: 8)
        .preferredColorScheme(.dark)
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: controller.mode)
        .onAppear {
            // Snap a fresh snapshot on first paint so the header isn't
            // blank for a beat. Cheap (a single JSON read) and usually
            // hits the cache on subsequent renders.
            _ = state.aiService.refreshLiveSnapshot()
        }
    }

    private func cornerRadius(for mode: OverlayController.Mode) -> CGFloat {
        switch mode {
        case .pill:                  return 22
        case .chat, .settings:       return 18
        }
    }
}

// =========================================================================
// OverlayGlassBackground
// -------------------------------------------------------------------------
// Combines an NSVisualEffectView (.hudWindow) with a brand-tinted
// gradient + a soft inner highlight so the panel reads as a polished
// system surface, not a flat black rectangle.
// =========================================================================

struct OverlayGlassBackground: View {
    let cornerRadius: CGFloat

    var body: some View {
        ZStack {
            VisualEffectBlur(material: .hudWindow, blendingMode: .behindWindow)
            LinearGradient(
                colors: [
                    Color(red: 0.07, green: 0.07, blue: 0.10).opacity(0.92),
                    Color(red: 0.05, green: 0.04, blue: 0.07).opacity(0.96),
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            // Subtle ember glow at the top-left so the brand color
            // shows up without bleeding all over the panel.
            LinearGradient(
                colors: [
                    Color(red: 1.0, green: 0.55, blue: 0.10).opacity(0.18),
                    Color.clear,
                ],
                startPoint: .topLeading, endPoint: .bottom
            )
            .blendMode(.screen)
            .frame(maxWidth: 220, maxHeight: 90, alignment: .topLeading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.top, -10)
            .padding(.leading, -10)
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

/// Bridge to NSVisualEffectView so SwiftUI can render system blur
/// behind the panel. Lives here (not in a shared utility file) so the
/// overlay module is self-contained and easy to lift out later.
struct VisualEffectBlur: NSViewRepresentable {
    var material: NSVisualEffectView.Material
    var blendingMode: NSVisualEffectView.BlendingMode

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blendingMode
        v.state = .active
        v.isEmphasized = false
        return v
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blendingMode
    }
}

// =========================================================================
// OverlayPillView — collapsed status pill
// -------------------------------------------------------------------------
// The pill now does triple duty:
//   1. Brand mark + drag handle.
//   2. Live run summary ("Defect A6 · F12 · 57/75 · 145g") when there's
//      a snapshot, OR a friendly "Run Coach idle" chip when there isn't.
//   3. Quick actions: ⚡ Coach (open chat), × (disable overlay).
// =========================================================================

struct OverlayPillView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    private var snap: STS2LiveSaveReader.LiveRunSnapshot? {
        state.aiService.liveSnapshot
    }

    var body: some View {
        HStack(spacing: 10) {
            brandMark
            // Live snapshot or idle hint, depending on whether a run is
            // on disk. Tap-targets the entire body so dragging works
            // anywhere along the pill.
            Group {
                if let s = snap, s.inProgress {
                    livePillContent(s)
                } else {
                    idlePillContent
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture {
                controller.showChat()
            }

            askButton
            closeButton
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func livePillContent(_ s: STS2LiveSaveReader.LiveRunSnapshot) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color(red: 0.30, green: 0.85, blue: 0.45))
                .frame(width: 6, height: 6)
                .overlay(
                    Circle()
                        .stroke(Color(red: 0.30, green: 0.85, blue: 0.45).opacity(0.6), lineWidth: 4)
                        .scaleEffect(1.4)
                        .opacity(0.6)
                )
            Text(s.headlineLine)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    private var idlePillContent: some View {
        HStack(spacing: 6) {
            Image(systemName: "moon.zzz")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white.opacity(0.55))
            Text("Run Coach · idle")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
        }
    }

    private var askButton: some View {
        Button {
            controller.showChat()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "sparkles")
                    .font(.system(size: 10, weight: .heavy))
                Text("Coach")
                    .font(.system(size: 11, weight: .heavy))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule()
                    .fill(LinearGradient(colors: [
                        Color(red: 1, green: 0.55, blue: 0.10),
                        Color(red: 1, green: 0.35, blue: 0.08),
                    ], startPoint: .top, endPoint: .bottom))
            )
            .overlay(
                Capsule().stroke(Color.white.opacity(0.20), lineWidth: 1)
            )
            .shadow(color: Color(red: 1, green: 0.4, blue: 0.1).opacity(0.45), radius: 6, y: 1)
        }
        .buttonStyle(.plain)
        .help("Open the Run Coach (⌘⏎ to ask Assist)")
    }

    private var closeButton: some View {
        Button {
            controller.enabled = false
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .black))
                .foregroundStyle(.white.opacity(0.55))
                .frame(width: 22, height: 22)
                .background(
                    Circle().fill(Color.white.opacity(0.06))
                )
                .overlay(
                    Circle().stroke(Color.white.opacity(0.10), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .help("Close overlay (re-enable in Beta tab)")
    }

    private var brandMark: some View {
        Image("VaultEmblem")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: 24, height: 24)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.white.opacity(0.18), lineWidth: 1)
            )
            .shadow(color: Color(red: 1, green: 0.5, blue: 0.1).opacity(0.4), radius: 6)
    }
}

// =========================================================================
// OverlayExpandedView — chat panel
// -------------------------------------------------------------------------
// Layout, top → bottom:
//   1. Header bar with brand + provider badge + collapse / settings / end
//   2. Live run summary card (deck/relics/HP/gold) if a run is on disk
//   3. Chat scroll
//   4. Command palette: card / boss / shop / path / fight / deck-plan
//   5. Input row with screenshot toggle + send
//   6. Footer / status line
// =========================================================================

struct OverlayExpandedView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 10)
            divider
            if let snap = state.aiService.liveSnapshot, snap.inProgress {
                LiveRunStrip(snap: snap, controller: controller)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                divider
            }
            chatScroll
                .frame(maxHeight: .infinity)
            divider
            commandPalette
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 6)
            inputRow
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            footer
                .padding(.horizontal, 14)
                .padding(.bottom, 9)
        }
        .onAppear { inputFocused = true }
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 1)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Image("VaultEmblem")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 22, height: 22)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text("Run Coach")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(.white)
                Text("\(state.aiService.currentProvider().displayName) · \(modelLabel)")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(1)
            }
            keyHint("BETA")
                .padding(.leading, 2)
            Spacer()
            iconButton("gearshape.fill", help: "Coach settings") {
                controller.showSettings()
            }
            iconButton("chevron.up", help: "Hide (collapse to pill)") {
                controller.collapse()
            }
            iconButton("rectangle.on.rectangle", help: "Open The Vault main window") {
                controller.openMainWindow()
            }
            iconButton("xmark", help: "End — disable overlay", danger: true) {
                controller.enabled = false
            }
        }
    }

    private var modelLabel: String {
        let m = state.config.overlayAIModel
        return m.isEmpty ? state.aiService.currentProvider().defaultModel : m
    }

    private func keyHint(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 9, weight: .heavy))
            .tracking(1.2)
            .foregroundStyle(.white.opacity(0.7))
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color(red: 1, green: 0.45, blue: 0.1).opacity(0.20))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .stroke(Color(red: 1, green: 0.45, blue: 0.1).opacity(0.50), lineWidth: 1)
            )
    }

    private func iconButton(_ name: String, help: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(danger ? Color(red: 1, green: 0.45, blue: 0.45) : Color.white.opacity(0.72))
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .help(help)
    }

    // MARK: - Chat

    private var chatScroll: some View {
        ScrollViewReader { reader in
            ScrollView {
                VStack(spacing: 8) {
                    if state.aiService.messages.isEmpty {
                        emptyChatPlaceholder
                            .padding(.horizontal, 14)
                            .padding(.vertical, 18)
                    } else {
                        ForEach(state.aiService.messages) { msg in
                            ChatBubble(message: msg)
                                .id(msg.id)
                        }
                        .padding(.horizontal, 14)
                        .padding(.top, 12)
                        .padding(.bottom, 6)
                    }
                    if state.aiService.isThinking {
                        ThinkingDots()
                            .padding(.bottom, 6)
                    }
                }
            }
            .onChange(of: state.aiService.messages.count) { _ in
                if let last = state.aiService.messages.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) {
                        reader.scrollTo(last, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var emptyChatPlaceholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "wand.and.stars")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(Color(red: 1, green: 0.55, blue: 0.10))
                Text(state.aiService.liveSnapshot?.inProgress == true
                     ? "Coach loaded your run."
                     : "Run Coach is ready.")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(.white)
            }
            Text(state.aiService.liveSnapshot?.inProgress == true
                 ? "Tap a chip below for the decision in front of you, or hit \(Image(systemName: "command")) ⏎ for one ranked answer."
                 : "Launch a Slay the Spire 2 run, then tap a chip below — Coach will read your save and give you specific advice.")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.65))
                .fixedSize(horizontal: false, vertical: true)
            if !hasAPIKey {
                Button {
                    controller.showSettings()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "key.fill")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Color(red: 1, green: 0.7, blue: 0.2))
                        Text("Add an API key — opens Coach settings")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundStyle(.white.opacity(0.85))
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white.opacity(0.4))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color(red: 1, green: 0.7, blue: 0.2).opacity(0.10))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(Color(red: 1, green: 0.7, blue: 0.2).opacity(0.45), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var hasAPIKey: Bool {
        OverlayKeychain.hasKey(for: state.aiService.currentProvider().keychainAccount)
    }

    // MARK: - Command palette
    //
    // Each chip maps to a phase-specific OverlayAIService action so
    // the model gets a tightly-scoped prompt, not a vague "what should
    // I do". The chip layout wraps over two rows so a 420w panel
    // doesn't crush the labels.

    private var commandPalette: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Top row: the Assist button is the primary affordance —
            // gradient-filled, slightly larger, takes screen + auto-
            // routes to the right specialist. This is the "I don't
            // know which chip to press" escape hatch.
            HStack(spacing: 6) {
                AssistButton(isThinking: state.aiService.isThinking) {
                    Task { await state.aiService.whatShouldIDo() }
                }
                Spacer(minLength: 0)
                Button {
                    state.aiService.clearConversation()
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white.opacity(0.45))
                        .frame(width: 24, height: 24)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Color.white.opacity(0.04))
                        )
                }
                .buttonStyle(.plain)
                .help("Clear chat")
                .disabled(state.aiService.messages.isEmpty)
            }
            // Phase-specific chips. Each routes to the structured
            // specialist that returns a visual card (RewardPlanCard,
            // ShopPlanCard, EventPlanCard, PathPlanCard).
            HStack(spacing: 6) {
                CommandChip(label: "Card pick", systemImage: "rectangle.portrait.on.rectangle.portrait.fill", tint: .accentOrange) {
                    Task { await state.aiService.askCardPick() }
                }
                CommandChip(label: "Boss relic", systemImage: "crown.fill", tint: .accentGold) {
                    Task { await state.aiService.askRelicPick() }
                }
                CommandChip(label: "Shop", systemImage: "bag.fill", tint: .accentTeal) {
                    Task { await state.aiService.askShop() }
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                CommandChip(label: "Path", systemImage: "map.fill", tint: .accentBlue) {
                    Task { await state.aiService.askPath() }
                }
                CommandChip(label: "Event", systemImage: "questionmark.diamond.fill", tint: .accentPurple) {
                    Task { await state.aiService.askEvent() }
                }
                CommandChip(label: "Fight", systemImage: "bolt.shield.fill", tint: .accentRed) {
                    Task { await state.aiService.askCombat() }
                }
                CommandChip(label: "Plan", systemImage: "list.star", tint: .accentGold) {
                    Task { await state.aiService.askDeckPlan() }
                }
                Spacer(minLength: 0)
            }
        }
        .opacity(state.aiService.isThinking ? 0.55 : 1)
        .disabled(state.aiService.isThinking)
        .animation(.easeOut(duration: 0.18), value: state.aiService.isThinking)
    }

    // MARK: - Input

    private var inputRow: some View {
        HStack(spacing: 8) {
            Button {
                state.config.overlayAttachScreenshot.toggle()
                state.config.save()
            } label: {
                Image(systemName: state.config.overlayAttachScreenshot
                      ? "camera.viewfinder"
                      : "camera.metering.unknown")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(state.config.overlayAttachScreenshot
                                     ? Color(red: 1, green: 0.55, blue: 0.10)
                                     : .white.opacity(0.45))
                    .frame(width: 30, height: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(0.05))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(state.config.overlayAttachScreenshot
                                    ? Color(red: 1, green: 0.55, blue: 0.10).opacity(0.45)
                                    : Color.white.opacity(0.10), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
            .help(state.config.overlayAttachScreenshot
                  ? "Screenshot will be attached to your next question"
                  : "Screenshot off — text-only mode")

            TextField("Ask the Coach about your run…", text: $controller.input)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(Color.white.opacity(0.12), lineWidth: 1)
                )
                .focused($inputFocused)
                .onSubmit { sendInput() }

            Button(action: sendInput) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(controller.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                     ? Color.white.opacity(0.20)
                                     : Color(red: 1, green: 0.5, blue: 0.10))
            }
            .buttonStyle(.plain)
            .disabled(controller.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                      || state.aiService.isThinking)
            .keyboardShortcut(.return, modifiers: [])
        }
        .background(
            ZStack {
                // Cmd+Enter goes to "Assist" regardless of input focus
                // — matches Cluely's "ask the screen" muscle memory.
                Button("Assist") {
                    Task { await state.aiService.whatShouldIDo() }
                }
                .keyboardShortcut(.return, modifiers: .command)
                // Esc collapses the panel back to the pill, even when
                // the text field is focused. Mirrors the Spotlight /
                // Cluely "press Esc to dismiss" behavior so players
                // don't have to grab the trackpad mid-fight.
                Button("Collapse") {
                    controller.collapse()
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
            .opacity(0)
            .frame(width: 0, height: 0)
        )
    }

    private func sendInput() {
        let q = controller.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        controller.input = ""
        Task { await state.aiService.ask(q) }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 8) {
            if let s = state.aiService.statusLine {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.55))
                Text(s)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(1)
            } else if let err = state.aiService.lastError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Color(red: 1, green: 0.55, blue: 0.30))
                Text(err)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color(red: 1, green: 0.55, blue: 0.30))
                    .lineLimit(1)
            } else {
                Text("⌘⏎ Assist · ⏎ Send · Esc collapse")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.40))
            }
            Spacer()
            spendMeter
        }
    }

    /// Tiny session-spend readout. Approximate (we don't get real token
    /// counts back from every provider call) — its job is to make the
    /// player trust the Coach isn't quietly burning through their API
    /// credits, not to be a billing system. Hides itself until the
    /// player has actually made a request.
    @ViewBuilder
    private var spendMeter: some View {
        let tokens = state.aiService.sessionTokensSpent
        let cost = state.aiService.sessionCostUSD
        if tokens > 0 {
            HStack(spacing: 4) {
                Image(systemName: "dollarsign.circle")
                    .font(.system(size: 9, weight: .heavy))
                Text(formatCost(cost))
                    .font(.system(size: 9.5, weight: .heavy, design: .monospaced))
                Text("· \(formatTokens(tokens))")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.35))
            }
            .foregroundStyle(.white.opacity(0.5))
            .help("Estimated session spend (\(tokens) tokens). Approximate — actual provider billing is the source of truth.")
        }
    }

    private func formatCost(_ usd: Double) -> String {
        if usd < 0.01 { return "<$0.01" }
        if usd < 1   { return String(format: "$%.3f", usd) }
        return String(format: "$%.2f", usd)
    }

    private func formatTokens(_ n: Int) -> String {
        if n < 1000 { return "\(n)t" }
        return String(format: "%.1fkt", Double(n) / 1000)
    }
}

// =========================================================================
// LiveRunStrip — header strip showing the live snapshot
// -------------------------------------------------------------------------
// Renders just below the chat header so the player has constant
// visibility into what state the Coach is reasoning over. Tappable to
// force a refresh from disk.
// =========================================================================

struct LiveRunStrip: View {
    let snap: STS2LiveSaveReader.LiveRunSnapshot
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 10) {
            characterChip
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text((snap.character ?? "Unknown").capitalized)
                        .font(.system(size: 11.5, weight: .heavy))
                        .foregroundStyle(.white)
                    if let a = snap.ascension {
                        Text("A\(a)")
                            .font(.system(size: 9.5, weight: .heavy))
                            .tracking(0.5)
                            .foregroundStyle(.white.opacity(0.85))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(
                                RoundedRectangle(cornerRadius: 3, style: .continuous)
                                    .fill(Color(red: 1, green: 0.55, blue: 0.10).opacity(0.30))
                            )
                    }
                    if let mode = snap.modeBadge {
                        Text(mode)
                            .font(.system(size: 9, weight: .heavy))
                            .tracking(0.4)
                            .foregroundStyle(.white.opacity(0.85))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(
                                RoundedRectangle(cornerRadius: 3, style: .continuous)
                                    .fill(Color(red: 0.30, green: 0.85, blue: 0.45).opacity(0.30))
                            )
                    }
                }
                Text(snap.subtitleLine)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            HPBar(current: snap.currentHP ?? 0, max: snap.maxHP ?? 0)
                .frame(width: 80, height: 8)
            refreshButton
        }
        .contentShape(Rectangle())
        .onTapGesture { _ = state.aiService.refreshLiveSnapshot() }
    }

    private var characterChip: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(LinearGradient(colors: characterTint, startPoint: .top, endPoint: .bottom))
            Text(initials)
                .font(.system(size: 11, weight: .black, design: .rounded))
                .foregroundStyle(.white)
        }
        .frame(width: 26, height: 26)
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(Color.white.opacity(0.18), lineWidth: 1)
        )
    }

    private var initials: String {
        let c = (snap.character ?? "?").prefix(2).uppercased()
        return String(c)
    }

    private var characterTint: [Color] {
        // Match the run-detail color scheme so cross-surface UX stays
        // consistent: ironclad red, silent green, defect blue, …
        switch snap.character {
        case "ironclad":    return [Color(red: 0.85, green: 0.20, blue: 0.20), Color(red: 0.55, green: 0.10, blue: 0.10)]
        case "silent":      return [Color(red: 0.20, green: 0.70, blue: 0.30), Color(red: 0.10, green: 0.45, blue: 0.20)]
        case "defect":      return [Color(red: 0.20, green: 0.55, blue: 0.95), Color(red: 0.10, green: 0.30, blue: 0.65)]
        case "regent":      return [Color(red: 0.65, green: 0.45, blue: 0.95), Color(red: 0.40, green: 0.25, blue: 0.65)]
        case "necrobinder": return [Color(red: 0.65, green: 0.55, blue: 0.30), Color(red: 0.40, green: 0.30, blue: 0.15)]
        default:            return [Color(red: 0.30, green: 0.30, blue: 0.40), Color(red: 0.15, green: 0.15, blue: 0.20)]
        }
    }

    private var refreshButton: some View {
        Button {
            _ = state.aiService.refreshLiveSnapshot()
        } label: {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white.opacity(0.6))
                .frame(width: 22, height: 22)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                )
        }
        .buttonStyle(.plain)
        .help("Re-read current_run.save from disk")
    }
}

/// HP bar — green when full, gold when bloodied, red when critical.
struct HPBar: View {
    let current: Int
    let max: Int

    private var ratio: Double {
        guard max > 0 else { return 0 }
        return min(1, Double(current) / Double(max))
    }

    private var fill: Color {
        switch ratio {
        case 0..<0.34: return Color(red: 0.95, green: 0.30, blue: 0.30)
        case 0..<0.67: return Color(red: 0.95, green: 0.75, blue: 0.30)
        default:       return Color(red: 0.30, green: 0.85, blue: 0.45)
        }
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                Capsule()
                    .fill(fill)
                    .frame(width: geo.size.width * ratio)
                    .animation(.easeOut(duration: 0.4), value: ratio)
            }
        }
    }
}

// =========================================================================
// CommandChip — coloured pill for the command palette
// =========================================================================

struct CommandChip: View {
    let label: String
    let systemImage: String
    let tint: ChipTint
    let action: () -> Void

    @State private var hovered = false

    enum ChipTint {
        case accentOrange, accentGold, accentTeal, accentBlue, accentRed, accentPurple
        var color: Color {
            switch self {
            case .accentOrange: return Color(red: 1, green: 0.55, blue: 0.10)
            case .accentGold:   return Color(red: 1, green: 0.80, blue: 0.30)
            case .accentTeal:   return Color(red: 0.30, green: 0.80, blue: 0.75)
            case .accentBlue:   return Color(red: 0.40, green: 0.65, blue: 1.00)
            case .accentRed:    return Color(red: 1.00, green: 0.40, blue: 0.40)
            case .accentPurple: return Color(red: 0.75, green: 0.55, blue: 1.00)
            }
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(tint.color)
                Text(label)
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(.white.opacity(0.92))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule().fill(hovered
                               ? Color.white.opacity(0.10)
                               : Color.white.opacity(0.05))
            )
            .overlay(
                Capsule().stroke(hovered
                                 ? tint.color.opacity(0.55)
                                 : Color.white.opacity(0.10), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(.easeOut(duration: 0.12), value: hovered)
    }
}

// =========================================================================
// OverlaySettingsView — in-overlay settings page
// -------------------------------------------------------------------------
// Player can switch provider, paste an API key, and toggle privacy
// without leaving the floating panel. Mirrors the Beta tab's structure
// but tighter — this is the in-game shortcut, not the full configurator.
// =========================================================================

struct OverlaySettingsView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    @State private var typedKey: String = ""
    @State private var keyRevealed: Bool = false
    @State private var keyOnFile: Bool = false
    @State private var saveMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 10)
            divider
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    providerBlock
                    apiKeyBlock
                    modelBlock
                    toggleBlock
                    fullSettingsLink
                }
                .padding(14)
            }
            .frame(maxHeight: .infinity)
            divider
            footer
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
        }
        .onAppear { refreshKeychainState() }
    }

    private var divider: some View {
        Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "gearshape.fill")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color(red: 1, green: 0.55, blue: 0.10))
            Text("Coach settings")
                .font(.system(size: 13, weight: .heavy))
                .foregroundStyle(.white)
            Spacer()
            iconButton("arrow.uturn.backward", help: "Back to chat") {
                controller.showChat()
            }
            iconButton("xmark", help: "End — disable overlay", danger: true) {
                controller.enabled = false
            }
        }
    }

    private func iconButton(_ name: String, help: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(danger ? Color(red: 1, green: 0.45, blue: 0.45) : Color.white.opacity(0.72))
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .help(help)
    }

    // MARK: - Provider tiles

    private var providerBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("Provider")
            HStack(spacing: 8) {
                ForEach(OverlayAIService.Provider.allCases) { p in
                    OverlayProviderTile(
                        provider: p,
                        selected: state.config.overlayAIProviderRaw == p.rawValue
                    ) {
                        state.config.overlayAIProviderRaw = p.rawValue
                        state.config.overlayAIModel = p.defaultModel
                        state.config.save()
                        refreshKeychainState()
                    }
                }
            }
        }
    }

    // MARK: - API key

    private var apiKeyBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("API key")
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text(provider.apiKeyHint)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.45))
                    Spacer()
                    if keyOnFile {
                        Label("On file", systemImage: "checkmark.shield.fill")
                            .font(.system(size: 9.5, weight: .heavy))
                            .foregroundStyle(Color(red: 0.4, green: 0.85, blue: 0.45))
                    }
                }
                HStack(spacing: 8) {
                    Group {
                        if keyRevealed {
                            TextField("paste your key here", text: $typedKey)
                                .textFieldStyle(.plain)
                        } else {
                            SecureField("paste your key here", text: $typedKey)
                                .textFieldStyle(.plain)
                        }
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .fill(Color.white.opacity(0.05))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .stroke(Color.white.opacity(0.10), lineWidth: 1)
                    )
                    Button {
                        keyRevealed.toggle()
                    } label: {
                        Image(systemName: keyRevealed ? "eye.slash" : "eye")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white.opacity(0.7))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.plain)
                    .help(keyRevealed ? "Hide key" : "Show key")
                }
                HStack(spacing: 8) {
                    Button {
                        saveKey()
                    } label: {
                        Text("Save")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                Capsule()
                                    .fill(LinearGradient(colors: [
                                        Color(red: 1, green: 0.55, blue: 0.10),
                                        Color(red: 1, green: 0.35, blue: 0.08),
                                    ], startPoint: .top, endPoint: .bottom))
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(typedKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Button {
                        OverlayKeychain.delete(account: provider.keychainAccount)
                        typedKey = ""
                        refreshKeychainState()
                        saveMessage = "Removed from Keychain."
                    } label: {
                        Text("Remove")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.65))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(Color.white.opacity(0.05)))
                            .overlay(Capsule().stroke(Color.white.opacity(0.10), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(!keyOnFile && typedKey.isEmpty)

                    Spacer()
                    Button {
                        Task { await state.aiService.ask("Self-check: introduce yourself in one sentence as the Run Coach.", includeScreenshot: false) }
                        controller.showChat()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "antenna.radiowaves.left.and.right")
                                .font(.system(size: 10, weight: .bold))
                            Text("Test")
                                .font(.system(size: 10.5, weight: .heavy))
                        }
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(Color.white.opacity(0.06)))
                        .overlay(Capsule().stroke(Color.white.opacity(0.10), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(!keyOnFile)
                    .help("Send a test prompt to verify the key works")
                }
                if let s = saveMessage {
                    Text(s)
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(Color(red: 0.4, green: 0.85, blue: 0.45))
                }
                Text("Stored in your macOS Keychain. The Vault server never sees your key — it's sent in headers straight to \(provider.displayName).")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.40))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.white.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
        }
    }

    // MARK: - Model picker

    private var modelBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("Model")
            VStack(alignment: .leading, spacing: 6) {
                Picker("", selection: Binding(
                    get: { state.config.overlayAIModel },
                    set: { state.config.overlayAIModel = $0; state.config.save() }
                )) {
                    ForEach(provider.suggestedModels, id: \.self) { m in
                        Text(m).tag(m)
                    }
                    if !provider.suggestedModels.contains(state.config.overlayAIModel) {
                        Text("\(state.config.overlayAIModel) (custom)").tag(state.config.overlayAIModel)
                    }
                }
                .labelsHidden()
                .controlSize(.small)
                Text("`gpt-4o-mini` is the recommended default — vision-capable and cheap. Switch to `gpt-4o` or `claude-3-5-sonnet` if you want stronger reasoning per call.")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.45))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.white.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
        }
    }

    // MARK: - Toggles

    private var toggleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("Privacy & visibility")
            VStack(spacing: 10) {
                rowToggle(
                    title: "Attach screenshot",
                    sub: "Send the active display (~1280px) with each Coach question.",
                    isOn: Binding(
                        get: { state.config.overlayAttachScreenshot },
                        set: { state.config.overlayAttachScreenshot = $0; state.config.save() }
                    )
                )
                rowDivider
                rowToggle(
                    title: "Hidden from screen recording",
                    sub: "Coach panel is invisible in OBS / Zoom / QuickTime.",
                    isOn: Binding(
                        get: { state.config.overlayInvisibleToCapture },
                        set: {
                            state.config.overlayInvisibleToCapture = $0
                            state.config.save()
                            state.overlayController.reapplyWindowFlags()
                        }
                    )
                )
                rowDivider
                rowToggle(
                    title: "Always on top",
                    sub: "Float over fullscreen STS2 instead of hiding behind it.",
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
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.white.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
        }
    }

    private var rowDivider: some View {
        Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1)
    }

    private func rowToggle(title: String, sub: String, isOn: Binding<Bool>) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 11.5, weight: .heavy))
                    .foregroundStyle(.white)
                Text(sub)
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.55))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }

    // MARK: - Misc

    private var fullSettingsLink: some View {
        Button {
            controller.openMainWindow()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 10.5, weight: .bold))
                Text("Open full Beta settings in The Vault")
                    .font(.system(size: 11, weight: .heavy))
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .bold))
            }
            .foregroundStyle(.white.opacity(0.7))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Capsule().fill(Color.white.opacity(0.04)))
            .overlay(Capsule().stroke(Color.white.opacity(0.10), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Image(systemName: "lock.fill")
                .font(.system(size: 9))
                .foregroundStyle(.white.opacity(0.4))
            Text("Your key + screenshots stay on your Mac. The Vault server sees zero AI traffic.")
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.white.opacity(0.45))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
    }

    private func sectionLabel(_ s: String) -> some View {
        Text(s.uppercased())
            .font(.system(size: 9, weight: .heavy))
            .tracking(1.4)
            .foregroundStyle(.white.opacity(0.50))
    }

    private var provider: OverlayAIService.Provider {
        OverlayAIService.Provider(rawValue: state.config.overlayAIProviderRaw) ?? .openai
    }

    private func refreshKeychainState() {
        keyOnFile = OverlayKeychain.hasKey(for: provider.keychainAccount)
        typedKey = ""
        saveMessage = keyOnFile ? "API key already stored. Paste a new one to replace." : nil
    }

    private func saveKey() {
        let trimmed = typedKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if OverlayKeychain.setAPIKey(trimmed, for: provider.keychainAccount) {
            keyOnFile = true
            typedKey = ""
            saveMessage = "Saved to Keychain."
        } else {
            saveMessage = "Couldn't save to Keychain. Open Keychain Access to investigate."
        }
    }
}

// =========================================================================
// OverlayProviderTile — compact provider picker for the overlay sheet
// =========================================================================

struct OverlayProviderTile: View {
    let provider: OverlayAIService.Provider
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                ZStack {
                    Circle().fill(selected
                                   ? Color(red: 1, green: 0.55, blue: 0.10).opacity(0.20)
                                   : Color.white.opacity(0.06))
                    Image(systemName: provider == .openai ? "circle.hexagongrid.fill" : "triangle.fill")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(selected
                                         ? Color(red: 1, green: 0.55, blue: 0.10)
                                         : Color.white.opacity(0.6))
                }
                .frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(provider.displayName)
                        .font(.system(size: 11.5, weight: .heavy))
                        .foregroundStyle(.white)
                    Text(OverlayKeychain.hasKey(for: provider.keychainAccount)
                         ? "Key on file"
                         : "No key")
                        .font(.system(size: 9.5))
                        .foregroundStyle(OverlayKeychain.hasKey(for: provider.keychainAccount)
                                         ? Color(red: 0.4, green: 0.85, blue: 0.45)
                                         : .white.opacity(0.42))
                }
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(selected
                                     ? Color(red: 1, green: 0.55, blue: 0.10)
                                     : Color.white.opacity(0.30))
            }
            .padding(10)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(selected ? Color(red: 1, green: 0.55, blue: 0.10).opacity(0.10) : Color.white.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(selected ? Color(red: 1, green: 0.55, blue: 0.10).opacity(0.55) : Color.white.opacity(0.08), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// =========================================================================
// ChatBubble
// -------------------------------------------------------------------------
// Renders one message. For assistant messages that carry a structured
// `PathPlan`, the route card renders ABOVE the text bubble — STS2 lets
// the player draw on the in-game map, so our job is to *show* them
// the route to draw, not draw on top of the game window.
// =========================================================================

struct ChatBubble: View {
    let message: OverlayAIService.Message

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            switch message.role {
            case .user:
                Spacer(minLength: 36)
                bubble(
                    fill: AnyShapeStyle(LinearGradient(colors: [
                        Color(red: 1, green: 0.55, blue: 0.10),
                        Color(red: 1, green: 0.42, blue: 0.10),
                    ], startPoint: .topLeading, endPoint: .bottomTrailing)),
                    textColor: .white,
                    alignment: .trailing
                )
            case .assistant:
                VStack(alignment: .leading, spacing: 8) {
                    if let plan = message.pathPlan {
                        PathPlanCard(plan: plan)
                    }
                    if let plan = message.rewardPlan {
                        RewardPlanCard(plan: plan)
                    }
                    if let plan = message.shopPlan {
                        ShopPlanCard(plan: plan)
                    }
                    if let plan = message.eventPlan {
                        EventPlanCard(plan: plan)
                    }
                    if let plan = message.combatPlan {
                        CombatPlanCard(plan: plan)
                    }
                    bubble(
                        fill: AnyShapeStyle(Color.white.opacity(0.07)),
                        textColor: .white.opacity(0.92),
                        alignment: .leading
                    )
                }
                Spacer(minLength: 36)
            case .tracker:
                if let note = message.tracker {
                    TrackerChip(note: note)
                }
                Spacer(minLength: 0)
            case .system:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func bubble(fill: AnyShapeStyle,
                        textColor: Color,
                        alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 4) {
            if message.role == .user, message.attachedScreenshot {
                HStack(spacing: 4) {
                    Image(systemName: "photo.fill")
                        .font(.system(size: 9, weight: .bold))
                    Text("Screen attached")
                        .font(.system(size: 9, weight: .heavy))
                }
                .foregroundStyle(.white.opacity(0.85))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.black.opacity(0.18)))
            }
            Text(message.text)
                .font(.system(size: 12))
                .foregroundStyle(textColor)
                .multilineTextAlignment(alignment == .leading ? .leading : .trailing)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(fill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .frame(maxWidth: 320, alignment: alignment == .leading ? .leading : .trailing)
    }
}

// =========================================================================
// PathPlanCard
// -------------------------------------------------------------------------
// Visual route the model recommends. Lives above the assistant bubble
// when a structured plan parses successfully. Each node:
//   * shows the room icon + label
//   * renders in its room-type tint
//   * highlights as "NEXT" for index 0
//   * displays the model's `why` underneath (≤ 14 words by contract)
// Nodes are connected by a vertical guide rail so it reads as a route,
// not just a list. Tap-and-hold any node to copy the rationale.
// =========================================================================

struct PathPlanCard: View {
    let plan: OverlayAIService.PathPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            nodes
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [
                    Color(red: 0.10, green: 0.12, blue: 0.18),
                    Color(red: 0.06, green: 0.07, blue: 0.10),
                ], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(red: 1, green: 0.55, blue: 0.10).opacity(0.30), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.30), radius: 6, y: 2)
        .frame(maxWidth: 320, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "map.fill")
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(Color(red: 1, green: 0.55, blue: 0.10))
            Text("Recommended route")
                .font(.system(size: 10.5, weight: .heavy))
                .tracking(0.6)
                .foregroundStyle(.white.opacity(0.78))
            Spacer()
            Text("\(plan.nodes.count) steps")
                .font(.system(size: 9.5, weight: .heavy))
                .foregroundStyle(.white.opacity(0.4))
        }
        .padding(.bottom, 8)
    }

    private var nodes: some View {
        VStack(spacing: 6) {
            ForEach(Array(plan.nodes.enumerated()), id: \.offset) { idx, node in
                PathNodeRow(node: node,
                            index: idx,
                            isLast: idx == plan.nodes.count - 1)
            }
        }
    }
}

private struct PathNodeRow: View {
    let node: OverlayAIService.PathNode
    let index: Int
    let isLast: Bool

    private var meta: PathRoomMeta { PathRoomMeta.for(type: node.type) }
    private var isNext: Bool { index == 0 }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Left rail: numbered tile + a dotted connector down to
            // the next node. The connector stops at the last node so
            // the timeline doesn't trail off into nothing.
            VStack(spacing: 2) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(meta.tint.opacity(isNext ? 0.32 : 0.18))
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(meta.tint.opacity(isNext ? 0.95 : 0.45), lineWidth: 1)
                    Image(systemName: meta.systemImage)
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundStyle(meta.tint)
                }
                .frame(width: 30, height: 30)
                if !isLast {
                    Rectangle()
                        .fill(meta.tint.opacity(0.30))
                        .frame(width: 2, height: 18)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(node.label)
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(.white)
                    if isNext {
                        Text("NEXT")
                            .font(.system(size: 8.5, weight: .heavy))
                            .tracking(1)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(
                                Capsule().fill(Color(red: 1, green: 0.55, blue: 0.10))
                            )
                    }
                    Spacer(minLength: 0)
                    Text("Step \(index + 1)")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundStyle(.white.opacity(0.35))
                }
                if let why = node.why, !why.isEmpty {
                    Text(why)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.white.opacity(0.65))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .padding(.top, 2)
        }
    }
}

// =========================================================================
// AssistButton
// -------------------------------------------------------------------------
// Primary "do it for me" affordance. Bigger, gradient-filled,
// always-visible at the top of the command palette. Player taps this
// when they want the Coach to look at the screen and figure out the
// right kind of advice on its own — auto-detects card_reward / shop /
// boss_relic / event / map / combat and returns the matching visual
// card. Cmd+Enter from anywhere routes here too.
// =========================================================================

struct AssistButton: View {
    let isThinking: Bool
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "wand.and.stars")
                    .font(.system(size: 11.5, weight: .heavy))
                Text("Assist")
                    .font(.system(size: 12, weight: .heavy))
                Text("⌘⏎")
                    .font(.system(size: 9.5, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.62))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(Color.black.opacity(0.18))
                    )
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(LinearGradient(colors: [
                        Color(red: 1, green: 0.55, blue: 0.10),
                        Color(red: 1, green: 0.32, blue: 0.08),
                    ], startPoint: .top, endPoint: .bottom))
            )
            .overlay(
                Capsule().stroke(Color.white.opacity(hovered ? 0.40 : 0.20), lineWidth: 1)
            )
            .shadow(color: Color(red: 1, green: 0.4, blue: 0.1).opacity(hovered ? 0.65 : 0.45),
                    radius: hovered ? 9 : 6, y: 1)
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(.easeOut(duration: 0.12), value: hovered)
        .help("Look at the screen and tell me what to do")
    }
}

/// Maps room type → icon + tint. Centralized so the chat card, live
/// snapshot row, and any future "expanded route" surface render the
/// same icon for the same room type. Keep in sync with the strings
/// the prompt is allowed to emit (`pathJSONInstructions`).
private struct PathRoomMeta {
    let systemImage: String
    let tint: Color

    static func `for`(type: String) -> PathRoomMeta {
        switch type.lowercased() {
        case "combat", "monster":
            return .init(systemImage: "bolt.fill",
                         tint: Color(red: 1.00, green: 0.40, blue: 0.40))
        case "elite":
            return .init(systemImage: "shield.lefthalf.filled.badge.plus",
                         tint: Color(red: 1.00, green: 0.75, blue: 0.30))
        case "shop":
            return .init(systemImage: "bag.fill",
                         tint: Color(red: 0.30, green: 0.80, blue: 0.75))
        case "rest", "campfire":
            return .init(systemImage: "flame.fill",
                         tint: Color(red: 1.00, green: 0.55, blue: 0.10))
        case "event":
            return .init(systemImage: "questionmark.diamond.fill",
                         tint: Color(red: 0.75, green: 0.55, blue: 1.00))
        case "chest", "treasure":
            return .init(systemImage: "shippingbox.fill",
                         tint: Color(red: 1.00, green: 0.85, blue: 0.45))
        case "boss":
            return .init(systemImage: "crown.fill",
                         tint: Color(red: 0.95, green: 0.30, blue: 0.55))
        default:
            return .init(systemImage: "circle.dashed",
                         tint: Color.white.opacity(0.55))
        }
    }
}

// =========================================================================
// ThinkingDots
// =========================================================================

struct ThinkingDots: View {
    @State private var phase = 0
    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color.white.opacity(phase == i ? 0.85 : 0.25))
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            Capsule().fill(Color.white.opacity(0.05))
        )
        .overlay(
            Capsule().stroke(Color.white.opacity(0.10), lineWidth: 1)
        )
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 14)
    }
}

// =========================================================================
// AvatarImage — kept from earlier overlay so the rest of the app
// (sidebar, co-op view, etc.) can reuse it.
// =========================================================================

struct AvatarImage: View {
    let urlString: String?
    let size: CGFloat

    var body: some View {
        Group {
            if let s = urlString, let url = URL(string: s) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable()
                    default: fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 1))
    }

    private var fallback: some View {
        ZStack {
            Color(red: 0.15, green: 0.10, blue: 0.18)
            Image(systemName: "person.fill")
                .foregroundStyle(.white.opacity(0.35))
                .font(.system(size: size * 0.55, weight: .bold))
        }
    }
}

// =========================================================================
// RewardPlanCard
// -------------------------------------------------------------------------
// The over-your-shoulder card-pick / boss-relic visualizer. Each option
// the model returned renders as its own row with:
//   * Verdict pill (TAKE / MAYBE / SKIP) — colored, sorted to top
//   * Rank chip (S / A / B / C / D) for fine-grained ordering
//   * The label (card or relic name)
//   * The why-bullet (≤ 18 words)
//   * Optional synergy tags ("channel", "frost", "block scaling")
//
// The TAKE option is decorated with an accent border + a subtle glow
// so the player's eye lands there in <500ms — that's the whole point.
// =========================================================================

struct RewardPlanCard: View {
    let plan: OverlayAIService.RewardPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            VStack(spacing: 6) {
                ForEach(plan.options) { opt in
                    RewardOptionRow(option: opt)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [
                    Color(red: 0.10, green: 0.12, blue: 0.18),
                    Color(red: 0.06, green: 0.07, blue: 0.10),
                ], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(red: 1, green: 0.55, blue: 0.10).opacity(0.30), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.30), radius: 6, y: 2)
        .frame(maxWidth: 320, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: kindIcon)
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(Color(red: 1, green: 0.55, blue: 0.10))
            Text(kindLabel)
                .font(.system(size: 10.5, weight: .heavy))
                .tracking(0.6)
                .foregroundStyle(.white.opacity(0.78))
            Spacer()
            Text("\(plan.options.count) options")
                .font(.system(size: 9.5, weight: .heavy))
                .foregroundStyle(.white.opacity(0.4))
        }
        .padding(.bottom, 8)
    }

    private var kindIcon: String {
        switch (plan.kind ?? "").lowercased() {
        case "boss_relic", "elite_relic": return "crown.fill"
        case "event_reward":              return "questionmark.diamond.fill"
        default:                          return "rectangle.portrait.on.rectangle.portrait.fill"
        }
    }
    private var kindLabel: String {
        switch (plan.kind ?? "").lowercased() {
        case "boss_relic":   return "Boss relic — ranked"
        case "elite_relic":  return "Elite relic — ranked"
        case "event_reward": return "Event reward — ranked"
        default:             return "Card reward — ranked"
        }
    }
}

private struct RewardOptionRow: View {
    let option: OverlayAIService.RewardOption

    private var meta: VerdictMeta { VerdictMeta.for(verdict: option.verdict) }
    private var rankMeta: RankMeta { RankMeta.for(rank: option.rank ?? "") }
    private var isTake: Bool { meta.kind == .take }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                verdictPill
                rankPill
                Text(option.label)
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            if let why = option.why, !why.isEmpty {
                Text(why)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.65))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let syns = option.synergies, !syns.isEmpty {
                HStack(spacing: 4) {
                    ForEach(syns, id: \.self) { s in
                        Text(s)
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundStyle(.white.opacity(0.7))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(
                                Capsule().fill(Color.white.opacity(0.06))
                            )
                            .overlay(
                                Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1)
                            )
                    }
                }
                .padding(.top, 1)
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(isTake
                      ? meta.tint.opacity(0.10)
                      : Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(isTake
                        ? meta.tint.opacity(0.55)
                        : Color.white.opacity(0.06), lineWidth: 1)
        )
    }

    private var verdictPill: some View {
        Text(option.verdict.uppercased())
            .font(.system(size: 9, weight: .heavy))
            .tracking(0.8)
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(meta.tint))
    }

    @ViewBuilder
    private var rankPill: some View {
        if option.rank?.isEmpty == false {
            Text(option.rank!.uppercased())
                .font(.system(size: 9, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: 16, height: 16)
                .background(Circle().fill(rankMeta.tint))
                .overlay(
                    Circle().stroke(Color.white.opacity(0.15), lineWidth: 0.5)
                )
        }
    }
}

/// Maps verdict string → tint + kind enum. Used by reward + event cards.
private struct VerdictMeta {
    enum Kind { case take, maybe, skip, avoid, buy }
    let tint: Color
    let kind: Kind

    static func `for`(verdict: String) -> VerdictMeta {
        switch verdict.uppercased() {
        case "TAKE":  return .init(tint: Color(red: 0.30, green: 0.85, blue: 0.45), kind: .take)
        case "BUY":   return .init(tint: Color(red: 0.30, green: 0.85, blue: 0.45), kind: .buy)
        case "MAYBE": return .init(tint: Color(red: 1.00, green: 0.75, blue: 0.30), kind: .maybe)
        case "SKIP":  return .init(tint: Color(red: 0.55, green: 0.55, blue: 0.65), kind: .skip)
        case "AVOID": return .init(tint: Color(red: 0.95, green: 0.30, blue: 0.30), kind: .avoid)
        default:      return .init(tint: Color.white.opacity(0.45), kind: .skip)
        }
    }
}

private struct RankMeta {
    let tint: Color
    static func `for`(rank: String) -> RankMeta {
        switch rank.uppercased() {
        case "S": return .init(tint: Color(red: 1.00, green: 0.30, blue: 0.55))
        case "A": return .init(tint: Color(red: 0.30, green: 0.85, blue: 0.45))
        case "B": return .init(tint: Color(red: 0.40, green: 0.65, blue: 1.00))
        case "C": return .init(tint: Color(red: 1.00, green: 0.75, blue: 0.30))
        case "D": return .init(tint: Color(red: 0.95, green: 0.30, blue: 0.30))
        default:  return .init(tint: Color.white.opacity(0.30))
        }
    }
}

// =========================================================================
// ShopPlanCard
// -------------------------------------------------------------------------
// Itemized shop visualizer. Each row shows price, BUY/MAYBE/SKIP
// verdict, and the why-bullet. The header carries the gold-before /
// gold-after math so the player can see at a glance "BUY everything
// recommended → 145 → 20 gold left".
// =========================================================================

struct ShopPlanCard: View {
    let plan: OverlayAIService.ShopPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            VStack(spacing: 5) {
                ForEach(plan.items) { item in
                    ShopItemRow(item: item)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [
                    Color(red: 0.10, green: 0.12, blue: 0.18),
                    Color(red: 0.06, green: 0.07, blue: 0.10),
                ], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(red: 0.30, green: 0.80, blue: 0.75).opacity(0.32), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.30), radius: 6, y: 2)
        .frame(maxWidth: 320, alignment: .leading)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "bag.fill")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(Color(red: 0.30, green: 0.80, blue: 0.75))
                Text("Shop — buy order")
                    .font(.system(size: 10.5, weight: .heavy))
                    .tracking(0.6)
                    .foregroundStyle(.white.opacity(0.78))
                Spacer()
                Text("\(plan.items.count) items")
                    .font(.system(size: 9.5, weight: .heavy))
                    .foregroundStyle(.white.opacity(0.4))
            }
            if plan.goldStart != nil || plan.goldAfter != nil {
                HStack(spacing: 4) {
                    Image(systemName: "circlebadge.2.fill")
                        .font(.system(size: 8, weight: .heavy))
                        .foregroundStyle(Color(red: 1.00, green: 0.85, blue: 0.30))
                    if let start = plan.goldStart {
                        Text("\(start)g")
                            .font(.system(size: 10, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.78))
                    }
                    Image(systemName: "arrow.right")
                        .font(.system(size: 8, weight: .heavy))
                        .foregroundStyle(.white.opacity(0.4))
                    if let after = plan.goldAfter {
                        Text("\(after)g left")
                            .font(.system(size: 10, weight: .heavy, design: .monospaced))
                            .foregroundStyle(after >= 0
                                             ? Color(red: 0.30, green: 0.85, blue: 0.45)
                                             : Color(red: 0.95, green: 0.30, blue: 0.30))
                    }
                }
            }
        }
        .padding(.bottom, 8)
    }
}

private struct ShopItemRow: View {
    let item: OverlayAIService.ShopItem

    private var meta: VerdictMeta { VerdictMeta.for(verdict: item.verdict) }
    private var isBuy: Bool { meta.kind == .buy }
    private var kindIcon: String {
        switch (item.kind ?? "").lowercased() {
        case "card":    return "rectangle.portrait.fill"
        case "relic":   return "crown.fill"
        case "potion":  return "drop.fill"
        case "removal": return "xmark.bin.fill"
        case "upgrade": return "arrow.up.circle.fill"
        default:        return "circle.fill"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: kindIcon)
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(meta.tint)
                    .frame(width: 14)
                Text(item.label)
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                if let p = item.price {
                    Text("\(p)g")
                        .font(.system(size: 10, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(
                            Capsule().fill(Color(red: 1.00, green: 0.85, blue: 0.30).opacity(0.20))
                        )
                }
                Text(item.verdict.uppercased())
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.7)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(meta.tint))
            }
            if let why = item.why, !why.isEmpty {
                Text(why)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.leading, 20)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isBuy ? meta.tint.opacity(0.08) : Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(isBuy ? meta.tint.opacity(0.45) : Color.white.opacity(0.06), lineWidth: 1)
        )
    }
}

// =========================================================================
// EventPlanCard
// -------------------------------------------------------------------------
// Visual event-choice ranker for STS2 `?` map nodes. The header shows
// the event name (when readable from screen). Each option is a row with
// the verdict pill (TAKE / MAYBE / SKIP / AVOID) and the why-bullet.
// AVOID is colored red because some events have run-bricking choices
// at low HP and the player should see that warning at a glance.
// =========================================================================

struct EventPlanCard: View {
    let plan: OverlayAIService.EventPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            VStack(spacing: 5) {
                ForEach(plan.options) { opt in
                    EventOptionRow(option: opt)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [
                    Color(red: 0.10, green: 0.12, blue: 0.18),
                    Color(red: 0.06, green: 0.07, blue: 0.10),
                ], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(red: 0.75, green: 0.55, blue: 1.00).opacity(0.32), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.30), radius: 6, y: 2)
        .frame(maxWidth: 320, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.diamond.fill")
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(Color(red: 0.75, green: 0.55, blue: 1.00))
            Text(plan.eventName ?? "Event — ranked")
                .font(.system(size: 10.5, weight: .heavy))
                .tracking(0.4)
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(1)
            Spacer()
            Text("\(plan.options.count) options")
                .font(.system(size: 9.5, weight: .heavy))
                .foregroundStyle(.white.opacity(0.4))
        }
        .padding(.bottom, 8)
    }
}

private struct EventOptionRow: View {
    let option: OverlayAIService.EventOption
    private var meta: VerdictMeta { VerdictMeta.for(verdict: option.verdict) }
    private var isTake: Bool { meta.kind == .take }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                Text(option.verdict.uppercased())
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.7)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(meta.tint))
                Text(option.label)
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            if let why = option.why, !why.isEmpty {
                Text(why)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isTake ? meta.tint.opacity(0.10) : Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(isTake ? meta.tint.opacity(0.55) : Color.white.opacity(0.06), lineWidth: 1)
        )
    }
}

// =========================================================================
// CombatPlanCard
// -------------------------------------------------------------------------
// In-fight play-order checklist. Renders the model's structured
// `CombatPlan` as a numbered turn:
//   * Header with energy budget chip + incoming-damage chip.
//   * Vertical play list ① ② ③ with card name (bold) → optional target
//     and a one-line rationale per play. The first play gets a "PLAY"
//     accent so the player's eye lands there first; subsequent plays
//     deemphasize gracefully.
//   * Reserve row showing cards to HOLD for next turn.
//   * Footer: one-sentence "next-turn" guidance.
//
// Why this exists: combat advice was the last action still returning
// plain text. Players had to re-read a paragraph every turn. With this
// card they glance, play, glance, play. STS2 combat rewards exact
// ordering ("Bash before Strike+ for the Vulnerable double") and a
// numbered checklist communicates that visually.
// =========================================================================

struct CombatPlanCard: View {
    let plan: OverlayAIService.CombatPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            playsStack
            if let reserve = plan.reserve, !reserve.isEmpty {
                reserveRow(reserve)
            }
            if let next = plan.nextTurn, !next.isEmpty {
                nextTurnRow(next)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [
                    Color(red: 0.10, green: 0.12, blue: 0.18),
                    Color(red: 0.06, green: 0.07, blue: 0.10),
                ], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(red: 0.95, green: 0.30, blue: 0.30).opacity(0.32), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.30), radius: 6, y: 2)
        .frame(maxWidth: 320, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.shield.fill")
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(Color(red: 0.95, green: 0.40, blue: 0.40))
            Text("Turn plan")
                .font(.system(size: 10.5, weight: .heavy))
                .tracking(0.6)
                .foregroundStyle(.white.opacity(0.78))
            Spacer()
            if let e = plan.energy {
                statChip(icon: "bolt.fill",
                         value: "\(e)",
                         tint: Color(red: 1.0, green: 0.78, blue: 0.30))
            }
            if let d = plan.incomingDamage {
                statChip(icon: "shield.lefthalf.filled",
                         value: "\(d)",
                         tint: Color(red: 0.95, green: 0.40, blue: 0.40))
            }
        }
        .padding(.bottom, 8)
    }

    private func statChip(icon: String, value: String, tint: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .heavy))
                .foregroundStyle(tint)
            Text(value)
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .overlay(Capsule().stroke(tint.opacity(0.35), lineWidth: 1))
    }

    private var playsStack: some View {
        VStack(spacing: 6) {
            ForEach(plan.plays) { play in
                CombatPlayRow(play: play, isFirst: play.order == 1)
            }
        }
    }

    private func reserveRow(_ reserve: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("HOLD FOR NEXT TURN")
                .font(.system(size: 9, weight: .heavy))
                .tracking(0.7)
                .foregroundStyle(.white.opacity(0.45))
            HStack(spacing: 4) {
                ForEach(reserve, id: \.self) { name in
                    Text(name)
                        .font(.system(size: 10.5, weight: .heavy))
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(
                            Capsule().fill(Color(red: 0.40, green: 0.65, blue: 1.00).opacity(0.12))
                        )
                        .overlay(
                            Capsule().stroke(Color(red: 0.40, green: 0.65, blue: 1.00).opacity(0.45),
                                            lineWidth: 1)
                        )
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.top, 8)
    }

    private func nextTurnRow(_ next: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "arrow.uturn.right.circle")
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(.white.opacity(0.45))
                .padding(.top, 1)
            Text(next)
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.75))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.top, 8)
    }
}

private struct CombatPlayRow: View {
    let play: OverlayAIService.CombatPlay
    let isFirst: Bool

    private var accent: Color {
        isFirst
            ? Color(red: 0.95, green: 0.40, blue: 0.40)
            : Color.white.opacity(0.14)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ZStack {
                Circle()
                    .fill(isFirst ? accent : Color.white.opacity(0.06))
                    .overlay(Circle().stroke(accent.opacity(isFirst ? 0.85 : 0.35), lineWidth: 1))
                Text("\(play.order)")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .foregroundStyle(isFirst ? .white : .white.opacity(0.75))
            }
            .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(play.card)
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(.white)
                    if let target = play.target, !target.isEmpty {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white.opacity(0.4))
                        Text(target)
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    if isFirst {
                        Text("PLAY")
                            .font(.system(size: 8.5, weight: .heavy))
                            .tracking(0.8)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(accent))
                    }
                    Spacer(minLength: 0)
                }
                if let why = play.why, !why.isEmpty {
                    Text(why)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.white.opacity(0.62))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(isFirst ? accent.opacity(0.08) : Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(isFirst ? accent.opacity(0.45) : Color.white.opacity(0.06), lineWidth: 1)
        )
    }
}

// =========================================================================
// TrackerChip
// -------------------------------------------------------------------------
// Slim inline chip posted by the snapshot watcher when the player's
// live save changes. Renders very differently from a chat bubble — no
// avatar, no border-radius bubble, no full-width fill — just a thin
// row with an icon, a label, and an optional "matches my pick" badge.
//
// Why thin: trackers can fire several times per turn (card pick + gold
// spent, relic added + HP delta on a chest open). If they each took
// the visual weight of a chat bubble the log would feel like noise.
// Compact rows let the player skim ten observations as fast as they'd
// skim two chat bubbles, which is the right ratio.
//
// The optional "MATCHES" / "DIFFERENT" badge converts the chip into a
// silent accuracy log — over time the player can scroll back and see
// "the Coach was right 7/10 times this run" without us ever asking.
// =========================================================================

struct TrackerChip: View {
    let note: OverlayAIService.TrackerNote

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: kindMeta.icon)
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(kindMeta.tint)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(headline)
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    matchBadge
                    Spacer(minLength: 0)
                    Text("F\(note.floor)")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundStyle(.white.opacity(0.35))
                }
                if let comment = note.matchComment, !comment.isEmpty {
                    Text(comment)
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(borderTint, lineWidth: 1)
        )
        .frame(maxWidth: 320, alignment: .leading)
    }

    private var headline: String {
        switch note.kind {
        case .cardAdded:     return "Took \(note.label)"
        case .cardRemoved:   return "Removed \(note.label)"
        case .cardUpgraded:  return "Upgraded \(note.label)"
        case .relicAdded:    return "Relic: \(note.label)"
        case .relicLost:     return "Lost relic: \(note.label)"
        case .potionAdded:   return "Potion: \(note.label)"
        case .potionUsed:    return "Used \(note.label)"
        case .goldGained:    return "Gold \(note.label)"
        case .goldSpent:     return "Spent \(note.label)"
        case .hpHealed:      return "Healed \(note.label)"
        case .hpLost:        return "Lost \(note.label)"
        case .floorAdvanced: return note.label
        }
    }

    private var kindMeta: (icon: String, tint: Color) {
        switch note.kind {
        case .cardAdded:     return ("rectangle.portrait.on.rectangle.portrait.fill",
                                     Color(red: 0.30, green: 0.85, blue: 0.45))
        case .cardRemoved:   return ("trash.fill", Color.white.opacity(0.4))
        case .cardUpgraded:  return ("arrow.up.circle.fill",
                                     Color(red: 1.00, green: 0.55, blue: 0.10))
        case .relicAdded:    return ("crown.fill",
                                     Color(red: 1.00, green: 0.78, blue: 0.30))
        case .relicLost:     return ("crown", Color.white.opacity(0.4))
        case .potionAdded:   return ("flask.fill",
                                     Color(red: 0.55, green: 0.80, blue: 1.00))
        case .potionUsed:    return ("flask",
                                     Color(red: 0.55, green: 0.80, blue: 1.00).opacity(0.7))
        case .goldGained:    return ("dollarsign.circle.fill",
                                     Color(red: 1.00, green: 0.78, blue: 0.30))
        case .goldSpent:     return ("dollarsign.circle",
                                     Color(red: 1.00, green: 0.78, blue: 0.30).opacity(0.7))
        case .hpHealed:      return ("heart.fill",
                                     Color(red: 0.30, green: 0.85, blue: 0.45))
        case .hpLost:        return ("heart.slash.fill",
                                     Color(red: 0.95, green: 0.30, blue: 0.30))
        case .floorAdvanced: return ("arrow.right.circle", Color.white.opacity(0.5))
        }
    }

    @ViewBuilder
    private var matchBadge: some View {
        switch note.matchVerdict {
        case .matched:
            badge(text: "MATCHES", tint: Color(red: 0.30, green: 0.85, blue: 0.45))
        case .different:
            badge(text: "DIFFERENT", tint: Color(red: 1.00, green: 0.75, blue: 0.30))
        case .skipped:
            badge(text: "SKIPPED", tint: Color.white.opacity(0.35))
        case .unrelated:
            EmptyView()
        }
    }

    private func badge(text: String, tint: Color) -> some View {
        Text(text)
            .font(.system(size: 8, weight: .heavy))
            .tracking(0.7)
            .foregroundStyle(.white)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Capsule().fill(tint))
    }

    private var borderTint: Color {
        switch note.matchVerdict {
        case .matched:   return Color(red: 0.30, green: 0.85, blue: 0.45).opacity(0.30)
        case .different: return Color(red: 1.00, green: 0.75, blue: 0.30).opacity(0.30)
        case .skipped:   return Color.white.opacity(0.10)
        case .unrelated: return Color.white.opacity(0.06)
        }
    }
}
