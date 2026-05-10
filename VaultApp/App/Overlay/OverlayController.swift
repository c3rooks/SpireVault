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

    /// Bound to `AppConfig.overlayEnabled`. Beta tab toggle flips this.
    @Published var enabled: Bool = false {
        didSet { applyEnabled() }
    }

    /// Whether the panel is currently in its expanded state.
    @Published private(set) var expanded: Bool = false

    /// Two-way bound by the input row in the expanded view.
    @Published var input: String = ""

    // MARK: - Plumbing

    private weak var appState: AppState?
    private var panel: OverlayPanel?
    private var hosting: NSHostingView<AnyView>?
    private var saveOriginDebounce: DispatchWorkItem?

    private let collapsedSize = CGSize(width: 210, height: 38)
    private let expandedSize  = CGSize(width: 360, height: 460)

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
            persistEnabled(true)
        } else {
            hide()
            persistEnabled(false)
        }
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
        p.hasShadow = true
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
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
        hosting = nil
    }

    func toggleExpanded() {
        expanded.toggle()
        applySize(animated: true)
    }

    func collapse() {
        guard expanded else { return }
        expanded = false
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
        let size = expanded ? expandedSize : collapsedSize
        // Pivot from the top-left so the pill stays anchored where the
        // user dragged it — feels like the panel "unfolds" downward.
        let topLeft = NSPoint(x: panel.frame.origin.x,
                               y: panel.frame.origin.y + panel.frame.size.height)
        var frame = NSRect(origin: panel.frame.origin, size: size)
        frame.origin.y = topLeft.y - size.height
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
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
