import AppKit
import Carbon.HIToolbox

// =========================================================================
// OverlayHotKey
// -------------------------------------------------------------------------
// Global hot-key for the Run Coach overlay. Default binding is
// ⌥Space — the "open my AI tool from inside the game" muscle memory
// most players already have from Cluely / Raycast / etc. Captured
// system-wide so the player never has to alt-tab out of fullscreen
// STS2 to ask a question.
//
// Why Carbon `RegisterEventHotKey` and not `NSEvent.addGlobalMonitor`:
//
//   * `addGlobalMonitor` requires the user to grant Accessibility
//     access in System Settings → Privacy & Security → Accessibility.
//     That's a horrible first-launch experience for a tool whose value
//     prop is "press a key, get help instantly". The user never sees
//     the system prompt for Carbon hot keys.
//
//   * Carbon's `RegisterEventHotKey` runs on a per-process event tap
//     that the OS routes hot-key events to before any other app sees
//     them — so the binding works even when the player is mid-fight
//     in fullscreen STS2 with the game window key.
//
//   * It's old C API but it's stable, supported on every macOS we care
//     about (13+), and the ergonomics are bounded by a tiny shim like
//     this one.
//
// Lifecycle: a single instance owned by `OverlayController`. Created
// when the overlay is enabled, destroyed when disabled. Fires on the
// main queue so the closure can safely touch SwiftUI / @Published
// state directly.
// =========================================================================

@MainActor
final class OverlayHotKey {

    /// Bitmask of modifier keys, in Carbon ("kEventKeyModifier*") form.
    /// We expose only the combinations that map cleanly to a key on a
    /// Mac keyboard so the settings UI can be a one-shot picker rather
    /// than a free-form recorder.
    enum Modifier: String, CaseIterable, Identifiable {
        case option       // ⌥
        case command      // ⌘
        case control      // ⌃
        case shift        // ⇧
        var id: String { rawValue }
        var label: String {
            switch self {
            case .option:  return "⌥ Option"
            case .command: return "⌘ Command"
            case .control: return "⌃ Control"
            case .shift:   return "⇧ Shift"
            }
        }
        var carbonMask: UInt32 {
            switch self {
            case .option:  return UInt32(optionKey)
            case .command: return UInt32(cmdKey)
            case .control: return UInt32(controlKey)
            case .shift:   return UInt32(shiftKey)
            }
        }
    }

    /// Keys we expose in the picker. "Space" is the default because
    /// it's the one combination the user is least likely to have
    /// already bound to something else (Cmd+Space is Spotlight, but
    /// Option+Space is rarely used and a single-press for the player
    /// to learn). The `keyCode` is the Carbon "kVK_*" constant — we
    /// store it as a UInt32 for the registration call.
    enum Key: String, CaseIterable, Identifiable {
        case space, returnKey, tab, escape
        case A, B, C, D, E, F, G, H, I, J, K, L, M
        case N, O, P, Q, R, S, T, U, V, W, X, Y, Z
        case digit1, digit2, digit3, digit4, digit5
        case digit6, digit7, digit8, digit9, digit0
        var id: String { rawValue }
        var label: String {
            switch self {
            case .space:     return "Space"
            case .returnKey: return "Return"
            case .tab:       return "Tab"
            case .escape:    return "Escape"
            case .digit1: return "1"; case .digit2: return "2"
            case .digit3: return "3"; case .digit4: return "4"
            case .digit5: return "5"; case .digit6: return "6"
            case .digit7: return "7"; case .digit8: return "8"
            case .digit9: return "9"; case .digit0: return "0"
            default: return rawValue
            }
        }
        var carbonKeyCode: UInt32 {
            switch self {
            case .space:     return UInt32(kVK_Space)
            case .returnKey: return UInt32(kVK_Return)
            case .tab:       return UInt32(kVK_Tab)
            case .escape:    return UInt32(kVK_Escape)
            case .A: return UInt32(kVK_ANSI_A); case .B: return UInt32(kVK_ANSI_B)
            case .C: return UInt32(kVK_ANSI_C); case .D: return UInt32(kVK_ANSI_D)
            case .E: return UInt32(kVK_ANSI_E); case .F: return UInt32(kVK_ANSI_F)
            case .G: return UInt32(kVK_ANSI_G); case .H: return UInt32(kVK_ANSI_H)
            case .I: return UInt32(kVK_ANSI_I); case .J: return UInt32(kVK_ANSI_J)
            case .K: return UInt32(kVK_ANSI_K); case .L: return UInt32(kVK_ANSI_L)
            case .M: return UInt32(kVK_ANSI_M); case .N: return UInt32(kVK_ANSI_N)
            case .O: return UInt32(kVK_ANSI_O); case .P: return UInt32(kVK_ANSI_P)
            case .Q: return UInt32(kVK_ANSI_Q); case .R: return UInt32(kVK_ANSI_R)
            case .S: return UInt32(kVK_ANSI_S); case .T: return UInt32(kVK_ANSI_T)
            case .U: return UInt32(kVK_ANSI_U); case .V: return UInt32(kVK_ANSI_V)
            case .W: return UInt32(kVK_ANSI_W); case .X: return UInt32(kVK_ANSI_X)
            case .Y: return UInt32(kVK_ANSI_Y); case .Z: return UInt32(kVK_ANSI_Z)
            case .digit1: return UInt32(kVK_ANSI_1); case .digit2: return UInt32(kVK_ANSI_2)
            case .digit3: return UInt32(kVK_ANSI_3); case .digit4: return UInt32(kVK_ANSI_4)
            case .digit5: return UInt32(kVK_ANSI_5); case .digit6: return UInt32(kVK_ANSI_6)
            case .digit7: return UInt32(kVK_ANSI_7); case .digit8: return UInt32(kVK_ANSI_8)
            case .digit9: return UInt32(kVK_ANSI_9); case .digit0: return UInt32(kVK_ANSI_0)
            }
        }
    }

    /// One global instance per process — the hot-key event handler is
    /// installed at the application event target and dispatches into a
    /// shared registry keyed by hotKeyID.
    private static var instances: [UInt32: OverlayHotKey] = [:]
    private static var nextSignature: UInt32 = 1
    private static var handlerInstalled = false

    private let signature: UInt32
    private var ref: EventHotKeyRef?
    private var onFire: () -> Void = {}

    init() {
        self.signature = OverlayHotKey.nextSignature
        OverlayHotKey.nextSignature += 1
    }

    deinit {
        // Nothing to do here — explicit `unregister()` should have
        // run from the @MainActor before we got here.
    }

    /// Bind the hot-key. Replaces any existing binding for this
    /// instance. `onFire` runs on the main queue.
    func register(modifiers: [Modifier], key: Key, onFire: @escaping () -> Void) {
        unregister()
        OverlayHotKey.installHandlerIfNeeded()
        self.onFire = onFire
        let modifierMask: UInt32 = modifiers.reduce(0) { $0 | $1.carbonMask }
        let hotKeyID = EventHotKeyID(signature: OSType(0x56_4C_54_48 /* "VLTH" */),
                                     id: signature)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            key.carbonKeyCode,
            modifierMask,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        if status == noErr, let ref {
            self.ref = ref
            OverlayHotKey.instances[signature] = self
        }
    }

    /// Tear down the binding. Safe to call when not registered.
    func unregister() {
        if let ref {
            UnregisterEventHotKey(ref)
            self.ref = nil
        }
        OverlayHotKey.instances.removeValue(forKey: signature)
        onFire = {}
    }

    // MARK: - Carbon event handler plumbing

    /// Install the process-wide event handler the first time anyone
    /// registers a hot key. We never uninstall — the cost of leaving
    /// it bound is one C function pointer.
    private static func installHandlerIfNeeded() {
        if handlerInstalled { return }
        handlerInstalled = true
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind:  UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_: EventHandlerCallRef?, event: EventRef?, _: UnsafeMutableRawPointer?) -> OSStatus in
                guard let event else { return noErr }
                var hotKeyID = EventHotKeyID()
                let status = GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotKeyID
                )
                if status != noErr { return status }
                // Hop to MainActor so the onFire closure can safely
                // touch SwiftUI / @Published state. Carbon dispatches
                // on the main thread already, but the type system
                // doesn't know that.
                let signature = hotKeyID.id
                Task { @MainActor in
                    OverlayHotKey.instances[signature]?.onFire()
                }
                return noErr
            },
            1, &spec, nil, nil
        )
    }
}
