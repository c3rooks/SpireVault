import SwiftUI
import VaultCore

// =========================================================================
// OverlayRootView
// -------------------------------------------------------------------------
// Cluely-inspired in-game AI coach. Two states:
//
//   • Collapsed pill — narrow horizontal control with the Vault emblem,
//                      a Hide toggle, and a quick "Coach" trigger.
//   • Expanded panel — chat history at top, action chips below
//                      (Ask / What should I do? / Recap), input row
//                      at the bottom with a screenshot toggle and send.
//
// Heavy lifting is in OverlayAIService — this view is purely presentation
// + glue. Keyboard: Cmd+Enter triggers "What should I do?" while focused
// in the input. Esc collapses back to the pill.
// =========================================================================

struct OverlayRootView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    var body: some View {
        Group {
            if controller.expanded {
                OverlayExpandedView(controller: controller)
                    .transition(.opacity)
            } else {
                OverlayPillView(controller: controller)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: controller.expanded ? 16 : 22, style: .continuous)
                .fill(Color(white: 0.06))
                .overlay(
                    RoundedRectangle(cornerRadius: controller.expanded ? 16 : 22, style: .continuous)
                        .stroke(Color.white.opacity(0.10), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.4), radius: 18, y: 6)
        )
        .clipShape(
            RoundedRectangle(cornerRadius: controller.expanded ? 16 : 22, style: .continuous)
        )
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.18), value: controller.expanded)
    }
}

// =========================================================================
// OverlayPillView — collapsed compact bar
// -------------------------------------------------------------------------
// Mirrors the way Cluely renders its top-of-screen status pill: a tiny
// row with brand mark + a couple of one-tap actions. Tapping the body
// expands into the chat panel.
// =========================================================================

struct OverlayPillView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 8) {
            brandMark
            Button {
                controller.toggleExpanded()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 10, weight: .bold))
                    Text("Coach")
                        .font(.system(size: 11, weight: .semibold))
                }
                .foregroundStyle(.white.opacity(0.85))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    Capsule().fill(Color.white.opacity(0.08))
                )
                .overlay(
                    Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .help("Open the Run Coach")
            Spacer(minLength: 0)
            Button {
                controller.enabled = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white.opacity(0.55))
                    .frame(width: 22, height: 22)
                    .background(
                        Circle().fill(Color.white.opacity(0.06))
                    )
            }
            .buttonStyle(.plain)
            .help("Close overlay (re-enable in Beta tab)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) {
            controller.toggleExpanded()
        }
    }

    private var brandMark: some View {
        Image("VaultEmblem")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: 22, height: 22)
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
// Visual layout, top → bottom:
//   1. Header bar:    [Vault logo + "Run Coach"] ........ [Hide] [End]
//   2. Chat scroll:   conversation history bubbles
//   3. Action chips:  [Ask] [What should I do?] [Recap]
//   4. Input row:     [Camera toggle] [text field] [Send]
//   5. Footer hint:   "⌘↵ Coach · Esc collapse · API key in Beta"
// =========================================================================

struct OverlayExpandedView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 8)
            divider
            chatScroll
                .frame(maxHeight: .infinity)
            divider
            actionChips
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            divider
            inputRow
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            footer
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
        .onAppear { inputFocused = true }
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 1)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image("VaultEmblem")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 20, height: 20)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            Text("Run Coach")
                .font(.system(size: 12, weight: .heavy))
                .foregroundStyle(.white)
            keyHint("BETA")
                .padding(.leading, 2)
            Spacer()
            Text(state.aiService.currentProvider().displayName)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white.opacity(0.55))
            Button {
                controller.collapse()
            } label: {
                pillIcon("chevron.up")
            }
            .buttonStyle(.plain)
            .help("Hide (collapse to pill)")
            Button {
                controller.openMainWindow()
            } label: {
                pillIcon("rectangle.on.rectangle")
            }
            .buttonStyle(.plain)
            .help("Open The Vault main window")
            Button {
                controller.enabled = false
            } label: {
                pillIcon("xmark", danger: true)
            }
            .buttonStyle(.plain)
            .help("End — disable overlay")
        }
    }

    private func keyHint(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 9, weight: .heavy))
            .tracking(1.2)
            .foregroundStyle(.white.opacity(0.6))
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color(red: 1, green: 0.45, blue: 0.1).opacity(0.18))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .stroke(Color(red: 1, green: 0.45, blue: 0.1).opacity(0.45), lineWidth: 1)
            )
    }

    private func pillIcon(_ name: String, danger: Bool = false) -> some View {
        Image(systemName: name)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(danger ? Color(red: 1, green: 0.45, blue: 0.45) : Color.white.opacity(0.7))
            .frame(width: 22, height: 22)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            )
    }

    // MARK: - Chat

    private var chatScroll: some View {
        ScrollViewReader { reader in
            ScrollView {
                VStack(spacing: 8) {
                    if state.aiService.messages.isEmpty {
                        emptyChatPlaceholder
                            .padding(.horizontal, 12)
                            .padding(.vertical, 18)
                    } else {
                        ForEach(state.aiService.messages) { msg in
                            ChatBubble(message: msg)
                                .id(msg.id)
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 10)
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
                    withAnimation(.easeOut(duration: 0.18)) {
                        reader.scrollTo(last, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var emptyChatPlaceholder: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Run Coach is ready.")
                .font(.system(size: 13, weight: .heavy))
                .foregroundStyle(.white)
            Text("Hit \(Image(systemName: "command")) ⏎ during a card reward, boss relic pick, or path choice and the coach will look at your screen and give you one ranked move.")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.6))
                .fixedSize(horizontal: false, vertical: true)
            if !hasAPIKey {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Color(red: 1, green: 0.7, blue: 0.2))
                    Text("Add an API key in Beta → Run Coach to enable AI advice.")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.7))
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var hasAPIKey: Bool {
        OverlayKeychain.hasKey(for: state.aiService.currentProvider().keychainAccount)
    }

    // MARK: - Chips

    private var actionChips: some View {
        HStack(spacing: 6) {
            chip("Assist", systemImage: "sparkles") {
                Task { await state.aiService.whatShouldIDo() }
            }
            chip("What should I do?", systemImage: "questionmark.bubble.fill") {
                Task { await state.aiService.whatShouldIDo() }
            }
            chip("Recap", systemImage: "list.bullet.rectangle") {
                Task { await state.aiService.recap() }
            }
            Spacer()
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
        }
    }

    private func chip(_ label: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 9.5, weight: .bold))
                Text(label)
                    .font(.system(size: 10.5, weight: .semibold))
            }
            .foregroundStyle(.white.opacity(0.8))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(Color.white.opacity(0.06))
            )
            .overlay(
                Capsule().stroke(Color.white.opacity(0.10), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(state.aiService.isThinking)
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
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(state.config.overlayAttachScreenshot
                                     ? Color(red: 1, green: 0.55, blue: 0.10)
                                     : .white.opacity(0.45))
                    .frame(width: 28, height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .fill(Color.white.opacity(0.05))
                    )
            }
            .buttonStyle(.plain)
            .help(state.config.overlayAttachScreenshot
                  ? "Screenshot will be attached to your next question"
                  : "Screenshot off — text-only mode")

            TextField("Ask about your run, or ⌘↵ for Assist", text: $controller.input)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.white.opacity(0.04))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color.white.opacity(0.10), lineWidth: 1)
                )
                .focused($inputFocused)
                .onSubmit { sendInput() }

            Button(action: sendInput) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22, weight: .semibold))
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
            // Invisible button to capture Cmd+Enter even when the text
            // field swallows plain Enter. macOS routes the chord to the
            // first matching shortcut up the responder chain.
            Button("Coach") {
                Task { await state.aiService.whatShouldIDo() }
            }
            .keyboardShortcut(.return, modifiers: .command)
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
            } else {
                Text("⌘↵ Assist · Tap × to disable · Beta tab for settings")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.40))
            }
            Spacer()
        }
    }
}

// =========================================================================
// ChatBubble
// =========================================================================

struct ChatBubble: View {
    let message: OverlayAIService.Message

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            switch message.role {
            case .user:
                Spacer(minLength: 28)
                bubble(
                    fill: LinearGradient(colors: [
                        Color(red: 1, green: 0.55, blue: 0.10),
                        Color(red: 1, green: 0.42, blue: 0.10),
                    ], startPoint: .topLeading, endPoint: .bottomTrailing),
                    textColor: .white,
                    alignment: .trailing
                )
            case .assistant:
                bubble(
                    fill: Color.white.opacity(0.06),
                    textColor: .white.opacity(0.92),
                    alignment: .leading
                )
                Spacer(minLength: 28)
            case .system:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func bubble(fill: some ShapeStyle,
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
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(fill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .frame(maxWidth: 260, alignment: alignment == .leading ? .leading : .trailing)
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
                    .fill(Color.white.opacity(phase == i ? 0.8 : 0.25))
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            Capsule().fill(Color.white.opacity(0.04))
        )
        .overlay(
            Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 12)
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
