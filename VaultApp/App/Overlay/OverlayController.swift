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
//   • Collapsed — a tiny pill (~140×40) with avatar + status dot + online
//                 count. Always-on-top so it can sit over a fullscreen game.
//   • Expanded  — a 320×360 panel with status quick-switch, "online now"
//                 count, "looking now" count, and an Open-the-App shortcut.
//
// Privacy: the panel sets `sharingType = .none` so it doesn't appear in
// screen recordings or screenshots. That's a polite default for a game-
// overlay tool — streamers don't want random UI in their captures.
//
// Data: we observe the existing PresenceService (already wired up in
// AppState) so the overlay never opens a second network connection. If
// the user signs out, PresenceService becomes nil and we close the window.
// =========================================================================

@MainActor
final class OverlayController: ObservableObject {

    // MARK: - Public state

    /// Bound to `AppConfig.overlayEnabled`. Settings toggle flips this.
    @Published var enabled: Bool = false {
        didSet { applyEnabled() }
    }

    /// Whether the panel is currently in its expanded state.
    @Published private(set) var expanded: Bool = false

    // MARK: - Plumbing

    private weak var appState: AppState?
    private var panel: OverlayPanel?
    private var hosting: NSHostingView<AnyView>?
    private var saveOriginDebounce: DispatchWorkItem?

    private let collapsedSize = CGSize(width: 152, height: 38)
    private let expandedSize  = CGSize(width: 320, height: 360)

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
        p.level = .floating
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
        // a tool whose target use case is a fullscreen game capture.
        if #available(macOS 13.0, *) {
            p.sharingType = .none
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
        // Default: top-right of the main screen, ~20pt inset.
        let screen = NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.visibleFrame ?? .zero
        let x = frame.maxX - collapsedSize.width - 20
        let y = frame.maxY - collapsedSize.height - 20
        return NSPoint(x: x, y: y + collapsedSize.height) // top-left convention
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
// `NSPanel` subclass with `canBecomeKey = true` (so text fields would work
// inside) but `canBecomeMain = false` (so it never steals main-window
// status from the real app window). `acceptsFirstMouse` makes clicks land
// even when the app isn't the active app — critical for an overlay.
// =========================================================================

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    // NSWindow doesn't expose acceptsFirstMouse directly — that's on
    // the contentView. The NSHostingView we install handles its own
    // first-mouse semantics for SwiftUI buttons; the .nonactivatingPanel
    // style mask plus level: .floating is enough for the overlay to
    // receive clicks without stealing app activation from the game.
}
