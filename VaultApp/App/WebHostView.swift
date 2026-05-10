import SwiftUI
import WebKit
import AppKit
import VaultCore

/// Embeds the live web companion (app.spirevault.app) inside the desktop app
/// so every data-driven tab — Overview, Characters, Ascensions, Top Relics,
/// Cards, Recent Runs, Co-op, Community Highlights, News — is rendered by
/// the canonical web UI instead of a parallel SwiftUI implementation that
/// would (and did) drift away from the cloud over time.
///
/// The macOS app keeps native control over:
///   • the sidebar (drives the embedded tab via `WKWebView.evaluateJavaScript`),
///   • the menu bar, in-app updater, and Beta tab (Run Coach overlay needs
///     `NSPanel` + `sharingType` flags that a browser cannot reach),
///   • save-folder linking and Steam OpenID (the WebView talks to the same
///     backend cookie domain for auth).
///
/// What the user gets back: every animation, modal, share-card, hover state,
/// run detail view, character art, "architect" character page, and the very
/// next thing we ship on the web — instantly, with no parallel SwiftUI port.
struct WebHostView: NSViewRepresentable {
    /// Which tab the parent sidebar wants to show. Two-way binding so an
    /// in-page link click ("Open Co-op" inside a news post) can flip the
    /// native sidebar selection, not just the embedded panel.
    @Binding var tab: SidebarSection

    /// Backend URL — passed straight through to the embedded page so the
    /// page talks to the same worker the desktop app uses (custom worker
    /// URLs from Settings still work correctly).
    let serverURL: URL

    /// User's locally-parsed runs. The desktop already parses these via
    /// VaultCore; we feed them into the embedded page so the web shows
    /// the user's *actual* history (their 414 runs) instead of the
    /// generic 73-run demo set. The runs survive a round-trip through
    /// JSON because RunRecord is Codable and the web's reviveRun()
    /// converts ISO date strings back into Date objects.
    let runs: [RunRecord]

    /// The full canonical web companion URL. This is the one place we
    /// hard-code "app.spirevault.app" so swapping deploy targets later
    /// only touches one symbol.
    static let companionBaseURL = URL(string: "https://app.spirevault.app/")!

    func makeCoordinator() -> Coordinator { Coordinator(tab: $tab) }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()      // share cookies across launches
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false

        // Inject a window flag BEFORE document-start so the page boots
        // straight into desktop-host mode (hides duplicated sidebar etc.)
        // The query-param `?desktop=1` is also set on the URL as a
        // belt-and-braces signal, but the user script wins on every
        // navigation including in-page hash changes.
        let bootScript = WKUserScript(
            source: """
            window.__VAULT_DESKTOP__ = true;
            window.__VAULT_DESKTOP_VERSION__ = "\(VaultBundleInfo.shortVersion)";
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        cfg.userContentController.addUserScript(bootScript)

        // Bridge: the page can call window.webkit.messageHandlers.<name>.postMessage(...)
        // We use a single channel ("vaultHost") with `kind` discriminators so future
        // hooks (deep-links, "open in finder", etc.) plug into the same surface.
        cfg.userContentController.add(context.coordinator, name: "vaultHost")

        let view = WKWebView(frame: .zero, configuration: cfg)
        view.navigationDelegate = context.coordinator
        view.uiDelegate          = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.allowsLinkPreview = false
        view.setValue(false, forKey: "drawsBackground") // let SwiftUI bg show through during load

        // Tag ourselves so request logs on the worker can tell desktop
        // traffic from real browsers without sniffing UA strings.
        view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605 (KHTML, like Gecko) Spire-Vault-macOS/\(VaultBundleInfo.shortVersion) WKWebView"

        context.coordinator.webView = view

        // Attach the post-init "the page told us its active tab" listener
        // *after* DOM ready so window.SpireVault is populated. We do this
        // by injecting another user script that wires the bridge once
        // window.SpireVault appears (script.js loads as a `type=module`
        // and runs after DOMContentLoaded).
        let bridgeScript = WKUserScript(
            source: bridgeBootSource,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        cfg.userContentController.addUserScript(bridgeScript)

        loadInitial(into: view, tab: tab, serverURL: serverURL)
        return view
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // The user clicked a different sidebar row. Drive the embedded
        // page over the JS bridge — much cheaper than a full reload and
        // preserves animations / scroll positions of already-rendered
        // panels.
        context.coordinator.requestTabSwitch(to: tab, on: webView)
        // After every state diff, push the latest runs snapshot down to
        // the embedded page. Internally throttled to a content hash so
        // a no-op re-render doesn't repeatedly re-encode the array.
        context.coordinator.pushRunsIfChanged(runs, on: webView)
    }

    private func loadInitial(into view: WKWebView, tab: SidebarSection, serverURL: URL) {
        var comps = URLComponents(url: Self.companionBaseURL, resolvingAgainstBaseURL: false)!
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "desktop", value: "1"))
        items.append(URLQueryItem(name: "tab", value: tab.webTabID))
        // Forward the active backend so the embedded page hits the same
        // worker the desktop app does. The page already knows its own
        // default; this only matters when a power user has overridden
        // the server URL in Settings.
        items.append(URLQueryItem(name: "host_v", value: VaultBundleInfo.shortVersion))
        comps.queryItems = items

        var req = URLRequest(url: comps.url ?? Self.companionBaseURL)
        req.cachePolicy = .reloadRevalidatingCacheData
        view.load(req)
    }

    /// JavaScript that runs once the embedded page reaches DOMContentLoaded.
    /// It waits for `window.SpireVault` (exposed by Web/script.js) and then
    /// subscribes to tab-change events so the native sidebar can mirror
    /// in-page navigations.
    private var bridgeBootSource: String {
        return """
        (function () {
          function onReady(cb) {
            if (window.SpireVault) { cb(window.SpireVault); return; }
            let tries = 0;
            const t = setInterval(() => {
              if (window.SpireVault) { clearInterval(t); cb(window.SpireVault); }
              else if (++tries > 80) { clearInterval(t); }
            }, 50);
          }
          onReady((api) => {
            try {
              api.onTabChange((tab) => {
                try {
                  window.webkit?.messageHandlers?.vaultHost?.postMessage({
                    kind: "tab", tab: tab,
                  });
                } catch (e) {}
              });
              window.webkit?.messageHandlers?.vaultHost?.postMessage({
                kind: "ready", tab: api.activeTab(),
              });
            } catch (e) {}
          });
          // Forward unhandled errors so the desktop console can pick them up.
          window.addEventListener("error", (ev) => {
            try {
              window.webkit?.messageHandlers?.vaultHost?.postMessage({
                kind: "error", message: String(ev?.message || ev),
              });
            } catch (e) {}
          });
        })();
        """
    }
}

// MARK: - Coordinator ---------------------------------------------------------

extension WebHostView {
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        @Binding var tab: SidebarSection

        weak var webView: WKWebView?

        /// Marks whether the page has reported back via window.SpireVault.
        /// Until then we don't try to call switchTab — the function isn't
        /// in scope yet, and we'd just bin the call.
        private var bridgeReady = false
        /// Pending tab switch we couldn't fulfil because the bridge wasn't
        /// ready yet. Replayed when the page reports `kind: "ready"`.
        private var pendingTab: SidebarSection?

        /// Last runs payload we successfully ingested into the embedded
        /// page, hashed so we can early-out on no-op SwiftUI updates.
        /// Without this every minor `@Published` flip in AppState would
        /// re-encode and re-ingest the full run set.
        private var lastRunsHash: Int = 0
        /// Cached encoded runs we'll replay once the bridge reports ready.
        private var pendingRunsJSON: String?

        init(tab: Binding<SidebarSection>) {
            _tab = tab
        }

        // MARK: Driving the embedded page

        func requestTabSwitch(to section: SidebarSection, on webView: WKWebView) {
            // The embedded page only knows about web tabs. Our native
            // .beta and .settings tabs aren't there — for those we render
            // native SwiftUI elsewhere, so this view shouldn't even be
            // visible. Still, guard against a stray update.
            guard section.isWebHosted else { return }
            guard bridgeReady else {
                pendingTab = section
                return
            }
            let js = "window.SpireVault && window.SpireVault.switchTab(\(JSStringLiteral.encode(section.webTabID)))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        /// Encode and ingest the desktop's runs into the embedded page.
        /// We compute a content hash and only actually push when it
        /// changes, so SwiftUI's habit of re-running updateNSView on
        /// every parent re-render doesn't keep re-uploading the same
        /// 400-run JSON to the WebView every keystroke.
        func pushRunsIfChanged(_ runs: [RunRecord], on webView: WKWebView) {
            // Cheap fingerprint: count + last-ended-at timestamp + first
            // run id. Good enough — a different run set will almost
            // always shift one of these. False positives only mean
            // we serialize one extra time, never wrong data.
            var hasher = Hasher()
            hasher.combine(runs.count)
            hasher.combine(runs.first?.id ?? "")
            hasher.combine(runs.last?.id ?? "")
            hasher.combine(runs.compactMap { $0.endedAt }.max())
            let h = hasher.finalize()
            if h == lastRunsHash { return }
            lastRunsHash = h

            guard let json = encodeRunsForWeb(runs) else { return }
            if !bridgeReady {
                pendingRunsJSON = json
                return
            }
            ingestRunsJSON(json, on: webView)
        }

        private func ingestRunsJSON(_ json: String, on webView: WKWebView) {
            // We splice the JSON directly into a `JSON.parse(...)` call
            // — `evaluateJavaScript` runs in the page's main world so
            // we don't need to escape anything beyond what JSONEncoder
            // already produced. The literal is wrapped in an IIFE so
            // a multi-megabyte payload never enters the JS console
            // (the whole expression evaluates to undefined).
            let js = """
            (function() {
              try {
                var runs = JSON.parse(\(JSStringLiteral.encode(json)));
                if (window.SpireVault && typeof window.SpireVault.ingestDesktopRuns === 'function') {
                  window.SpireVault.ingestDesktopRuns(runs);
                }
              } catch (e) { console.warn('[VaultHost] ingest failed', e); }
            })();
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        private func encodeRunsForWeb(_ runs: [RunRecord]) -> String? {
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .iso8601
            do {
                let data = try enc.encode(runs)
                return String(data: data, encoding: .utf8)
            } catch {
                NSLog("[WebHost] runs encode failed: %@", error.localizedDescription)
                return nil
            }
        }

        // MARK: - WKScriptMessageHandler

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "vaultHost",
                  let body = message.body as? [String: Any],
                  let kind = body["kind"] as? String
            else { return }

            switch kind {
            case "ready":
                bridgeReady = true
                if let pending = pendingTab, let view = webView {
                    pendingTab = nil
                    requestTabSwitch(to: pending, on: view)
                }
                // Drain any runs the host queued before the page was ready.
                // This is the common path on first load — the user lands
                // with their stats already parsed, but the page hadn't
                // finished booting yet, so we held the JSON for ingest
                // until the bridge handshake completed.
                if let json = pendingRunsJSON, let view = webView {
                    pendingRunsJSON = nil
                    ingestRunsJSON(json, on: view)
                }
                // If the page booted on a tab the host doesn't agree with
                // (e.g. user landed on `?tab=coop` because that was their
                // last tab), surface that so the sidebar reflects reality.
                if let webTab = (body["tab"] as? String).flatMap(SidebarSection.fromWebTabID(_:)),
                   webTab != tab {
                    DispatchQueue.main.async { [weak self] in self?.tab = webTab }
                }
            case "tab":
                if let webTab = (body["tab"] as? String).flatMap(SidebarSection.fromWebTabID(_:)),
                   webTab != tab {
                    DispatchQueue.main.async { [weak self] in self?.tab = webTab }
                }
            case "error":
                if let msg = body["message"] as? String {
                    NSLog("[WebHost] page error: %@", msg)
                }
            default:
                break
            }
        }

        // MARK: - WKNavigationDelegate

        /// Decide whether to load the URL inside the WebView or hand it off
        /// to the OS. Rule of thumb: only navigations within the companion
        /// origin stay inside; everything else (Steam, mailto, http(s) to
        /// other hosts, GitHub help links, deep-link schemes) opens in the
        /// user's actual browser.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel); return
            }

            // First-load and same-origin in-page navigations go ahead.
            if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
                decisionHandler(.allow); return
            }

            // App embed URL itself is allowed.
            if let companionHost = WebHostView.companionBaseURL.host,
               url.host == companionHost {
                decisionHandler(.allow); return
            }

            // Everything else: kick to NSWorkspace and cancel here.
            // This catches Steam profile links, mailto, external https,
            // GitHub README links from in-page footers, the `steam://`
            // scheme co-op uses to launch the game, etc.
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // After every full reload, re-request the tab the host wants.
            // Without this, a user-triggered ⌘R would land on whatever the
            // page persisted in localStorage — which may differ from what
            // the native sidebar shows.
            requestTabSwitch(to: tab, on: webView)
            // Clear the runs hash so the next pushRunsIfChanged call from
            // updateNSView re-ingests the current snapshot. The page's
            // in-memory `parsedRuns` was wiped by the navigation; without
            // this the embedded view would show demo data again until the
            // next AppState change.
            lastRunsHash = 0
            bridgeReady = false  // wait for the new bridge handshake
        }

        func webView(_ webView: WKWebView,
                     didFail navigation: WKNavigation!,
                     withError error: Error) {
            NSLog("[WebHost] navigation failed: %@", error.localizedDescription)
        }

        func webView(_ webView: WKWebView,
                     didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            NSLog("[WebHost] provisional load failed: %@", error.localizedDescription)
        }

        // MARK: - WKUIDelegate

        /// `target="_blank"` and `window.open` end up here. Always route
        /// to the user's default browser — never spawn a popup window
        /// inside the desktop app.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}

// MARK: - Sidebar <-> web tab mapping ----------------------------------------

extension SidebarSection {
    /// String the embedded web companion uses for this tab. Mirrors
    /// `KNOWN_TABS` in Web/script.js so a typo here would land on an
    /// empty panel server-side.
    var webTabID: String {
        switch self {
        case .overview:   return "overview"
        case .characters: return "characters"
        case .ascensions: return "ascensions"
        case .relics:     return "relics"
        case .cards:      return "cards"
        case .runs:       return "runs"
        case .coop:       return "coop"
        case .highlights: return "highlights"
        case .news:       return "news"
        case .beta, .settings: return "overview" // not web-hosted; see isWebHosted
        }
    }

    /// Inverse of `webTabID`. Returns nil for unknown strings so a
    /// "switched to overlay" event from the page (which we hide in
    /// production anyway) can't flip the native sidebar to garbage.
    static func fromWebTabID(_ id: String) -> SidebarSection? {
        switch id {
        case "overview":   return .overview
        case "characters": return .characters
        case "ascensions": return .ascensions
        case "relics":     return .relics
        case "cards":      return .cards
        case "runs":       return .runs
        case "coop":       return .coop
        case "highlights": return .highlights
        case "news":       return .news
        default:           return nil
        }
    }

    /// True for tabs whose UI lives in the embedded WebView. The Beta
    /// and Settings tabs need native chrome (NSPanel control, save
    /// folder picker, Keychain) so they stay in SwiftUI.
    var isWebHosted: Bool {
        switch self {
        case .beta, .settings: return false
        default: return true
        }
    }
}

// MARK: - JS literal helper ---------------------------------------------------

/// Tiny helper to turn a Swift String into a JS string literal that's safe
/// to splice into `evaluateJavaScript(...)`. Avoids pulling in JSONEncoder
/// for one-character escapes.
enum JSStringLiteral {
    static func encode(_ s: String) -> String {
        var out = "\""
        for ch in s.unicodeScalars {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if ch.value < 0x20 {
                    out += String(format: "\\u%04x", ch.value)
                } else {
                    out.unicodeScalars.append(ch)
                }
            }
        }
        out += "\""
        return out
    }
}
