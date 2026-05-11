import AppKit
import SwiftUI
import Combine
import VaultCore
import ScreenCaptureKit

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

/// Tiny observer interface the AI service uses to tell the controller
/// "something new arrived in the chat that the player may not have
/// seen yet". Lets the controller bump the unseen-dot on the pill
/// without the service having to know anything about pills or modes.
@MainActor
protocol OverlayObserverDelegate: AnyObject {
    func notePotentiallyUnseenMessage()
}

@MainActor
final class OverlayController: ObservableObject, OverlayObserverDelegate {

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

    /// How many tracker / assistant messages have arrived while the
    /// chat is collapsed. The pill renders a small attention dot when
    /// this is non-zero so the player knows the Coach has something
    /// new without expanding. Cleared whenever the chat opens.
    @Published private(set) var unseenObservations: Int = 0

    /// Called by `OverlayAIService` when a tracker chip or follow-up
    /// assistant message lands. Bumps the counter only while the chat
    /// is collapsed; when the chat is open the player is already
    /// looking at the message, so there's nothing unseen.
    func notePotentiallyUnseenMessage() {
        guard mode == .pill else { return }
        unseenObservations += 1
    }

    // MARK: - Plumbing

    private weak var appState: AppState?
    private var panel: OverlayPanel?
    private var hosting: NSHostingView<AnyView>?
    private var saveOriginDebounce: DispatchWorkItem?
    private var snapshotPollTimer: Timer?
    /// Real-time file watcher for `current_run.save`. Created lazily
    /// on enable so tracker chips fire within ~50ms of STS2 saving
    /// instead of waiting for the next 4-second poll. Falls back to
    /// the timer when the watcher can't attach (file missing, perms).
    private var saveWatcher: STS2LiveSaveWatcher?
    /// Process-wide global hot-key (default ⌥Space). Lets the player
    /// pop the overlay open from inside fullscreen STS2 without ever
    /// alt-tabbing. Re-bound when the user changes the binding in
    /// settings.
    private var hotKey: OverlayHotKey?

    // Sizing. Pill is the always-on-top status bar. Chat is the main
    // coach panel. Settings is a touch wider so the API key field and
    // provider tiles get room to breathe.
    private let collapsedSize = CGSize(width: 260, height: 40)
    private let expandedSize  = CGSize(width: 420, height: 540)
    private let settingsSize  = CGSize(width: 420, height: 580)

    init(appState: AppState) {
        self.appState = appState
        self.enabled = appState.config.overlayEnabled
        // Self-assign as the observer of the AI service so tracker
        // chips and Coach follow-ups bump the unseen-dot when chat is
        // collapsed. Done in init (not lazily on `show()`) so the dot
        // works correctly even if the user toggles enable/disable
        // without ever explicitly opening chat.
        appState.aiService.observerDelegate = self
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
            startSaveWatcher()
            applyHotKeyBinding()
            persistEnabled(true)
        } else {
            hide()
            stopSnapshotPolling()
            stopSaveWatcher()
            unbindHotKey()
            persistEnabled(false)
        }
    }

    /// Bind the global hot-key from the persisted config. Called from
    /// `applyEnabled` on launch + every time the user changes the
    /// binding in settings (BetaView calls this directly via
    /// `applyHotKeyBinding`). Tolerant of malformed config entries:
    /// if the user-saved modifier/key strings don't decode, we fall
    /// back to ⌥Space rather than refuse to bind anything.
    func applyHotKeyBinding() {
        guard let cfg = appState?.config else { return }
        unbindHotKey()
        guard cfg.overlayHotKeyEnabled else { return }
        let modifiers: [OverlayHotKey.Modifier] = cfg.overlayHotKeyModifiersRaw
            .compactMap { OverlayHotKey.Modifier(rawValue: $0) }
        let key = OverlayHotKey.Key(rawValue: cfg.overlayHotKeyKeyRaw) ?? .space
        let resolvedModifiers = modifiers.isEmpty ? [.option] : modifiers
        let hk = OverlayHotKey()
        hk.register(modifiers: resolvedModifiers, key: key) { [weak self] in
            // Press behaviour, by current mode:
            //   * .pill     → expand to chat (and focus the input
            //                 via OverlayExpandedView.onAppear).
            //   * .settings → switch to chat — settings is rarely
            //                 what the player wants to see when they
            //                 just hit the "ask the Coach" hotkey.
            //   * .chat     → collapse back to the pill, same
            //                 "press to invoke, press again to
            //                 dismiss" muscle memory as Spotlight.
            guard let self else { return }
            switch self.mode {
            case .pill, .settings: self.showChat()
            case .chat:            self.collapse()
            }
        }
        hotKey = hk
    }

    private func unbindHotKey() {
        hotKey?.unregister()
        hotKey = nil
    }

    /// Tick every 8 seconds while the overlay is visible — backstop for
    /// the kqueue watcher. With the watcher attached the loop is a
    /// soft no-op (the reader's 2s in-process cache + the kernel page
    /// cache make a redundant read essentially free). When the watcher
    /// can't attach (file not yet on disk, perms), the timer is the
    /// only path keeping the snapshot fresh — so we keep it on a slow
    /// cadence rather than removing it.
    ///
    /// Cadence note: 8s instead of the previous 4s because the watcher
    /// now handles the latency-sensitive path. Anything that gets here
    /// is by definition non-urgent.
    private func startSnapshotPolling() {
        stopSnapshotPolling()
        let timer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
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

    /// Attach the real-time `current_run.save` watcher. The watcher
    /// fires onChange within ~50ms of any save — we just call into
    /// the AI service to recompute the snapshot + emit tracker chips.
    /// This is the path that makes "I picked Streamline+ → 'Took
    /// Streamline+' chip" feel instant.
    private func startSaveWatcher() {
        stopSaveWatcher()
        guard let state = appState else { return }
        let watcher = STS2LiveSaveWatcher(reader: state.aiService.liveReader)
        watcher.start(
            saveFolderProvider: { [weak state] in state?.saveFolder },
            onChange: { [weak state] in
                // refreshLiveSnapshot does the diff + tracker emit + UI
                // update internally — we deliberately don't pass any
                // payload through, so the watcher stays event-shaped
                // ("something changed") and the AI service owns the
                // "what changed?" reasoning.
                state?.aiService.refreshLiveSnapshot()
            }
        )
        saveWatcher = watcher
    }

    private func stopSaveWatcher() {
        saveWatcher?.stop()
        saveWatcher = nil
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
        // Restore last-used origin if persisted *and* still on a connected
        // display. The classic "I disabled it and re-enabled it but it
        // didn't come back" report is usually one of: (a) an external
        // monitor was disconnected since the last position save, so the
        // saved coords land off-screen; (b) the saved origin is in a
        // negative half-plane on a since-rearranged multi-monitor
        // setup. Either way, falling back to `defaultOrigin()` puts the
        // pill back where the user can find it instead of leaving a
        // pixel of pill bleeding off the edge of nowhere.
        if let origin = persistedOrigin(), originIsOnAnyScreen(origin, size: collapsedSize) {
            p.setFrameTopLeftPoint(origin)
        } else if persistedOrigin() != nil {
            // Saved but unreachable — wipe it so we don't keep tripping
            // the same fallback every show(). Next user-initiated drag
            // will save a fresh origin.
            appState?.config.overlayOriginX = nil
            appState?.config.overlayOriginY = nil
            appState?.config.save()
        }

        let host = NSHostingView(rootView: AnyView(makeRootView()))
        host.translatesAutoresizingMaskIntoConstraints = false
        p.contentView = host
        self.hosting = host
        self.panel = p
        observeOriginChanges(panel: p)
        applySize(animated: false)
        p.alphaValue = 0.0
        p.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
            p.animator().alphaValue = 1.0
        }
        // Late layer cleanup + initial display sync on the next runloop
        // tick — by then AppKit has assigned the panel to a screen, so
        // syncGameDisplay() can resolve the correct display ID.
        DispatchQueue.main.async { [weak self, weak host] in
            host?.wantsLayer = true
            host?.layer?.isOpaque = false
            host?.layer?.backgroundColor = NSColor.clear.cgColor
            self?.syncGameDisplay()
        }
    }


    func hide() {
        guard let p = panel else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
            p.animator().alphaValue = 0.0
        }, completionHandler: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self = self, !self.enabled else { return }
                p.orderOut(nil)
                self.panel = nil
                self.hosting = nil
                // Reset to the pill so re-enabling later starts from the
                // canonical small state. Without this, a user who opens chat
                // (or settings), toggles "Enable" off in Beta → Run Coach,
                // then toggles it back on would get the chat/settings panel
                // back at its larger size — which violates the mental model
                // "the pill comes back when I re-enable." Doing this on hide
                // is safe: there's no panel to re-size, so it's a pure
                // state reset that the next `show()` reads.
                self.mode = .pill
            }
        })
    }

    func toggleExpanded() {
        mode = (mode == .pill) ? .chat : .pill
        applySize(animated: true)
    }

    func showChat() {
        guard mode != .chat else { return }
        mode = .chat
        applySize(animated: true)
        // Clear the unseen-observations counter the moment the chat
        // opens. This is the read-receipt — by definition, anything
        // the player can now see has been seen.
        unseenObservations = 0
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

    /// Public entry point for the monitor picker in OverlaySettingsView.
    /// Re-resolves the game display ID after the user pins or unpins a monitor.
    func syncGameDisplayPublic() {
        syncGameDisplay()
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
                self?.syncGameDisplay()
            }
        }
        NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeScreenNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.syncGameDisplay()
            }
        }
    }

    /// Pushes the display ID of the game monitor to OverlayAIService.
    ///
    /// Resolution order:
    ///   1. User-pinned UUID (config.overlayGameMonitorUUID) — survives reboots.
    ///   2. Auto: leftmost connected display on multi-monitor setups (the
    ///      "game on the left, Vault on the right" default). On a single
    ///      display falls back to the panel's own screen.
    ///
    /// We do NOT use panel.screen directly here because it can be nil
    /// immediately after orderFrontRegardless() during the first show().
    private func syncGameDisplay() {
        appState?.aiService.gameDisplayID = resolvedGameDisplayID()
    }

    /// Returns the CGDirectDisplayID that should be used for AI captures.
    /// Exposed so OverlaySettingsView can refresh the binding after the
    /// user picks a different monitor.
    func resolvedGameDisplayID() -> CGDirectDisplayID {
        let screens = NSScreen.screens
        // 1. Pinned UUID preference.
        if let uuid = appState?.config.overlayGameMonitorUUID {
            if let match = screens.first(where: { Self.uuidString(for: $0) == uuid }),
               let num = match.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                return CGDirectDisplayID(num.uint32Value)
            }
            // UUID no longer matches any screen — fall through to auto.
        }
        // 2. Auto: leftmost screen on multi-monitor, panel screen on single.
        if screens.count > 1 {
            let leftmost = screens.min(by: { $0.frame.minX < $1.frame.minX })
            if let s = leftmost,
               let num = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                return CGDirectDisplayID(num.uint32Value)
            }
        }
        // 3. Fall back to panel screen / main display.
        guard let panel else { return CGMainDisplayID() }
        let center = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }),
              let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return CGMainDisplayID() }
        return CGDirectDisplayID(number.uint32Value)
    }

    /// Stable UUID string for a given NSScreen. Uses CGDisplayCreateUUID
    /// which is backed by EDID + connector and survives reboots. Returns
    /// nil for virtual/mirrored displays that have no physical UUID.
    static func uuidString(for screen: NSScreen) -> String? {
        guard let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        let displayID = CGDirectDisplayID(num.uint32Value)
        guard let cfUUID = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, cfUUID) as String?
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

    /// Whether `origin` (a top-left point) places a panel of `size` such
    /// that at least the leftmost ~80pt of it lands inside *some*
    /// connected display's `visibleFrame`. We use the leading edge as
    /// the witness because the pill is wide enough that even a
    /// 200pt-trimmed pill is still grabbable; what we're guarding
    /// against is the whole panel landing entirely off-screen after a
    /// monitor swap.
    private func originIsOnAnyScreen(_ origin: NSPoint, size: CGSize) -> Bool {
        // setFrameTopLeftPoint takes a top-left, but NSScreen uses
        // bottom-left coordinates for visibleFrame. Convert: the
        // bottom-left of a panel positioned at top-left = origin and
        // height = size.height is (origin.x, origin.y - size.height).
        let panelRect = NSRect(
            x: origin.x,
            y: origin.y - size.height,
            width: size.width,
            height: size.height
        )
        let witness = NSRect(
            x: panelRect.minX,
            y: panelRect.minY,
            width: min(80, panelRect.width),
            height: panelRect.height
        )
        return NSScreen.screens.contains { $0.visibleFrame.intersects(witness) }
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
