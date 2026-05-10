import AppKit
import SwiftUI
import Combine
import VaultCore

// =========================================================================
// OverlayController
// -------------------------------------------------------------------------
// Owns the floating overlay window (an `NSPanel` with non-activating, all-
// spaces, full-screen-auxiliary collection behavior) and the SwiftUI view
// hierarchy hosted inside it. The overlay is a single window that re-sizes
// between two states:
//
//   • Collapsed — a tiny pill (~210×38) with the Vault emblem, a "Coach"
//                 trigger, and a quick close. Always-on-top so it sits
//                 over fullscreen STS2.
//   • Expanded  — a 360×460 chat panel in the Cluely style: header,
//                 conversation log, action chips (Assist · What should
//                 I do? · Recap), input field, footer hint.
//
// Privacy: when the user has `overlayInvisibleToCapture` on (default),
// `sharingType = .none` so the panel doesn't appear in screen recordings
// or shared screens. Streamers don't want random AI panels in their
// captures.
//
// Data: the overlay observes the existing PresenceService (already wired
// up on AppState) so it never opens its own network connections for the
// co-op count. AI calls go through OverlayAIService which talks directly
// to the user's chosen provider (OpenAI / Anthropic) — The Vault's
// servers see zero overlay traffic.
// =========================================================================

@MainActor
final class OverlayController: ObservableObject {

    // MARK: - Public state

    /// Three discrete display modes.
    ///   * pill    — the always-on top status pill (collapsed).
    ///   * chat    — the conversational AI coach panel.
    ///   * settings — provider / API key / privacy controls.
    enum Mode: Equatable { case pill, chat, settings }

    /// Bound to `AppConfig.overlayEnabled`. Beta tab toggle flips this.
    @Published var enabled: Bool = false {
        didSet { applyEnabled() }
    }

    /// Active display mode. Drives both the SwiftUI tree and the
    /// underlying NSPanel size.
    @Published private(set) var mode: Mode = .pill

    /// Two-way bound by the input row in the expanded view.
    @Published var input: String = ""

    /// Convenience for legacy call sites that just want to know
    /// "are we showing the chat or the pill?" without caring about
    /// settings.
    var expanded: Bool { mode != .pill }

    // MARK: - Plumbing

    private weak var appState: AppState?
    private var panel: OverlayPanel?
    private var hosting: NSHostingView<AnyView>?
    private var saveOriginDebounce: DispatchWorkItem?
    private var snapshotPollTimer: Timer?

    // Sizing. Pill is the always-on-top status bar. Chat is the main
    // coach panel. Settings is a touch wider so the API key field and
    // provider tiles get room to breathe.
    private let collapsedSize = CGSize(width: 260, height: 40)
    private let expandedSize  = CGSize(width: 420, height: 540)
    private let settingsSize  = CGSize(width: 420, height: 580)

    init(appState: AppState) {
        self.appState = appState
        self.enabled = appState.config.overlayEnabled
    }

    deinit {
        // NSPanel cleanup happens through ARC; nothing else to release.
    }

    // MARK: - Lifecycle

    /// Apply current `enabled` state. Called on toggle and on launch.
    func applyEnabled() {
        if enabled {
            show()
            startSnapshotPolling()
            persistEnabled(true)
        } else {
            hide()
            stopSnapshotPolling()
            persistEnabled(false)
        }
    }

    /// Tick every 4 seconds while the overlay is visible so the pill /
    /// live-run header reflects the player's actual progress without
    /// them having to tap the refresh button. The reader's own 2s
    /// in-process cache means most of these ticks are no-ops; the
    /// kernel page cache makes the few that aren't basically free.
    private func startSnapshotPolling() {
        stopSnapshotPolling()
        let timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let state = self.appState else { return }
                _ = state.aiService.refreshLiveSnapshot()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        snapshotPollTimer = timer
    }

    private func stopSnapshotPolling() {
        snapshotPollTimer?.invalidate()
        snapshotPollTimer = nil
    }

    /// Show the overlay window. Builds it on first call and restores the
    /// saved origin so the user's positioning survives relaunches.
    func show() {
        guard panel == nil else {
            panel?.orderFrontRegardless()
            return
        }
        let p = OverlayPanel(
            contentRect: NSRect(origin: defaultOrigin(), size: collapsedSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        let alwaysOnTop = appState?.config.overlayAlwaysOnTop ?? true
        p.level = alwaysOnTop ? .floating : .normal
        p.isFloatingPanel = true
        p.isOpaque = false
        p.backgroundColor = .clear
        // AppKit window shadow OFF. The window itself is a rectangle,
        // so the system shadow draws a sharp-cornered halo behind our
        // rounded SwiftUI card — that's the dark "black box behind the
        // border" the user reported. SwiftUI's `.shadow(...)` inside
        // OverlayRootView renders a shape-correct shadow that follows
        // the rounded corners; we use that one instead.
        p.hasShadow = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.titleVisibility = .hidden
        p.titlebarAppearsTransparent = true
        p.standardWindowButton(.closeButton)?.isHidden = true
        p.standardWindowButton(.miniaturizeButton)?.isHidden = true
        p.standardWindowButton(.zoomButton)?.isHidden = true
        p.isMovableByWindowBackground = true
        p.hidesOnDeactivate = false
        // Don't show up in OBS / screen recordings — courteous default for
        // a tool whose target use case is a fullscreen game capture. The
        // user can flip this off in Beta → Run Coach if they actually want
        // their stream to display the coach.
        if #available(macOS 13.0, *) {
            p.sharingType = (appState?.config.overlayInvisibleToCapture ?? true) ? .none : .readOnly
        }
        // Restore last-used origin if persisted; otherwise use top-right.
        if let origin = persistedOrigin() {
            p.setFrameTopLeftPoint(origin)
        }

        let host = NSHostingView(rootView: AnyView(makeRootView()))
        host.translatesAutoresizingMaskIntoConstraints = false
        p.contentView = host
        self.hosting = host
        self.panel = p
        observeOriginChanges(panel: p)
        applySize(animated: false)
        p.orderFrontRegardless()
        // Late layer cleanup. We set the hosting view's layer to clear
        // AFTER SwiftUI has rendered into it once — touching `host.layer`
        // before NSHostingView has materialized its backing path can
        // trigger an AppKit layout cycle that deadlocks subsequent
        // setFrame() calls on the panel. Doing it on the next runloop
        // tick gives SwiftUI time to settle. This is the actual fix for
        // the "black box behind the rounded border" report — without
        // this, the host's default dark layer paints through the
        // rounded SwiftUI card.
        DispatchQueue.main.async { [weak host] in
            host?.wantsLayer = true
            host?.layer?.isOpaque = false
            host?.layer?.backgroundColor = NSColor.clear.cgColor
        }
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
        hosting = nil
        // Reset to the pill so re-enabling later starts from the
        // canonical small state. Without this, a user who opens chat
        // (or settings), toggles "Enable" off in Beta → Run Coach,
        // then toggles it back on would get the chat/settings panel
        // back at its larger size — which violates the mental model
        // "the pill comes back when I re-enable." Doing this on hide
        // is safe: there's no panel to re-size, so it's a pure
        // state reset that the next `show()` reads.
        mode = .pill
    }

    func toggleExpanded() {
        mode = (mode == .pill) ? .chat : .pill
        applySize(animated: true)
    }

    func showChat() {
        guard mode != .chat else { return }
        mode = .chat
        applySize(animated: true)
    }

    func showSettings() {
        guard mode != .settings else { return }
        mode = .settings
        applySize(animated: true)
    }

    func collapse() {
        guard mode != .pill else { return }
        mode = .pill
        applySize(animated: true)
    }

    /// Bring the main app window to the front (Settings, Co-op tab, etc.).
    func openMainWindow() {
        for win in NSApp.windows where win is OverlayPanel == false {
            if win.canBecomeMain {
                win.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                return
            }
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Re-apply window-level + sharingType after the user changes them
    /// in Beta → Run Coach. Cheaper than tearing the panel down and
    /// rebuilding it; the panel keeps its position and key state.
    func reapplyWindowFlags() {
        guard let panel else { return }
        let alwaysOnTop = appState?.config.overlayAlwaysOnTop ?? true
        panel.level = alwaysOnTop ? .floating : .normal
        if #available(macOS 13.0, *) {
            panel.sharingType = (appState?.config.overlayInvisibleToCapture ?? true) ? .none : .readOnly
        }
    }

    // MARK: - Private

    private func makeRootView() -> some View {
        guard let appState else {
            return AnyView(EmptyView())
        }
        return AnyView(
            OverlayRootView(controller: self)
                .environmentObject(appState)
        )
    }

    private func applySize(animated: Bool) {
        guard let panel else { return }
        let size: CGSize
        switch mode {
        case .pill:     size = collapsedSize
        case .chat:     size = expandedSize
        case .settings: size = settingsSize
        }
        // Pivot from the top-left so the pill stays anchored where the
        // user dragged it — feels like the panel "unfolds" downward.
        let topLeft = NSPoint(x: panel.frame.origin.x,
                               y: panel.frame.origin.y + panel.frame.size.height)
        var frame = NSRect(origin: panel.frame.origin, size: size)
        frame.origin.y = topLeft.y - size.height
        // Keep the panel on screen — if the user dragged the pill near
        // the right edge, expanding to 420w would clip off the screen
        // and look broken. Snap horizontally back into the visible
        // frame minus a small margin.
        if let screen = panel.screen ?? NSScreen.main {
            let visible = screen.visibleFrame
            let margin: CGFloat = 8
            if frame.maxX > visible.maxX - margin {
                frame.origin.x = visible.maxX - margin - frame.width
            }
            if frame.minX < visible.minX + margin {
                frame.origin.x = visible.minX + margin
            }
        }
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
                panel.animator().setFrame(frame, display: true)
            }
        } else {
            panel.setFrame(frame, display: true)
        }
    }

    // Persist origin when the user drags the panel. Debounced so we
    // don't write to disk on every pixel of mouse movement. The
    // notification block fires on .main queue but isn't typed as
    // main-actor isolated, so we hop through Task { @MainActor }.
    private func observeOriginChanges(panel: NSPanel) {
        NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.scheduleOriginSave()
            }
        }
    }

    private func scheduleOriginSave() {
        saveOriginDebounce?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in self?.persistOrigin() }
        }
        saveOriginDebounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    private func persistOrigin() {
        guard let appState, let panel else { return }
        // We persist the top-left, since that's the anchor for collapse/
        // expand sizing. setFrameTopLeftPoint reads it back the same way.
        let topLeft = NSPoint(x: panel.frame.origin.x,
                              y: panel.frame.origin.y + panel.frame.size.height)
        appState.config.overlayOriginX = Double(topLeft.x)
        appState.config.overlayOriginY = Double(topLeft.y)
        appState.config.save()
    }

    private func persistedOrigin() -> NSPoint? {
        guard let cfg = appState?.config,
              let x = cfg.overlayOriginX,
              let y = cfg.overlayOriginY else {
            return nil
        }
        return NSPoint(x: x, y: y)
    }

    private func defaultOrigin() -> NSPoint {
        // Default: top-center of the main screen, ~30pt down — Cluely-
        // style "control bar at the top of the screen". Easy to find,
        // out of the way of most game UI.
        let screen = NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.visibleFrame ?? .zero
        let x = frame.midX - collapsedSize.width / 2
        let y = frame.maxY - 30
        return NSPoint(x: x, y: y)
    }

    private func persistEnabled(_ value: Bool) {
        guard let appState else { return }
        guard appState.config.overlayEnabled != value else { return }
        appState.config.overlayEnabled = value
        appState.config.save()
    }
}

// =========================================================================
// OverlayPanel
// -------------------------------------------------------------------------
// `NSPanel` subclass with `canBecomeKey = true` (so text fields work
// inside) but `canBecomeMain = false` (so it never steals main-window
// status from the real app window). The `.nonactivatingPanel` style mask
// plus `level: .floating` lets clicks land without stealing app
// activation from the underlying game.
// =========================================================================

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
