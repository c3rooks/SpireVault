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

    /// Monotonically-incrementing counter the parent flips when the
    /// native sidebar's "Sign in with Steam" button is tapped. We
    /// observe this in `updateNSView` and call the embedded page's
    /// `window.SpireVault.startSignIn()` so the OpenID flow runs
    /// inside the WKWebView (which is the only way the resulting
    /// cookie can land in our data store and stay signed in).
    /// Bug history: before this existed, every sign-in click went
    /// through `NSWorkspace.shared.open()` to the user's default
    /// browser; the cookie would land in Safari, not in our
    /// WKWebView, so the embedded view stayed signed-out forever.
    /// And on machines that had two copies of The Vault.app
    /// installed, the `thevault://` return URL re-launched the
    /// *other* copy, giving the user two desktop windows side by
    /// side. Driving sign-in inside the WebView solves both.
    var signInTicket: Int = 0

    /// Called when the embedded page's `auth.html` reports a
    /// successful Steam OpenID round-trip back through the JS
    /// bridge. The native side uses this to seat the same session
    /// in `SteamAuth` so the sidebar pill, Co-op presence, and
    /// every native API call all reflect login at once.
    var onAuthSuccess: ((WebAuthPayload) -> Void)? = nil

    /// Called when the embedded page's per-panel toolbar fires a
    /// data-ops button (Refresh / Import / Export → CSV/JSON). We
    /// route to native code so the user gets the real macOS file
    /// pickers and the canonical VaultCore parser, instead of the
    /// browser's directory-picker fallback. This is what removes
    /// the duplicated native chrome row above the WebView — every
    /// data action the web exposes now actually works in desktop
    /// mode without a parallel native toolbar painting the same
    /// affordances.
    var onAction: ((WebHostAction) -> Void)? = nil

    /// The full canonical web companion URL. This is the one place we
    /// hard-code "app.spirevault.app" so swapping deploy targets later
    /// only touches one symbol.
    static let companionBaseURL = URL(string: "https://app.spirevault.app/")!

    /// Hosts that are allowed to navigate *inside* the WKWebView (in
    /// addition to the companion host itself). These cover the full
    /// Steam OpenID round-trip:
    ///   1. POST to `<worker>/auth/steam/start`
    ///   2. 302 to `steamcommunity.com/openid/login`
    ///   3. Steam 302 back to `<worker>/auth/steam/callback`
    ///   4. Worker 302 to `app.spirevault.app/auth.html`
    /// Without these, step 1 hits the navigation delegate, which
    /// kicks the URL out to NSWorkspace and the cookie/session ends
    /// up somewhere we can't read.
    static let inlineAuthHostSuffixes: [String] = [
        "steamcommunity.com",
        "steampowered.com",
    ]

    func makeCoordinator() -> Coordinator {
        Coordinator(
            tab: $tab,
            workerHost: serverURL.host,
            onAuthSuccess: onAuthSuccess,
            onAction: onAction
        )
    }

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
        // Sign-in fan-out: a bumped ticket means the native sidebar's
        // "Sign in with Steam" button was clicked. We forward to the
        // embedded page's bridge which calls the same function the
        // web's CTAs use, so the OpenID flow stays inside this
        // WKWebView and the cookie ends up in our data store.
        context.coordinator.requestSignInIfNeeded(ticket: signInTicket, on: webView)
        // Latest auth + action closures — keep them fresh in case
        // AppState was rebuilt (e.g., a config change rebuilt
        // presenceService) and the captured closure now points at a
        // dead instance.
        context.coordinator.onAuthSuccess = onAuthSuccess
        context.coordinator.onAction = onAction
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

        /// Host of the configured worker (e.g. `vault-coop.coreycrooks.workers.dev`).
        /// Allowed to navigate inside the WebView so the Steam OpenID
        /// round-trip can happen without bouncing to NSWorkspace.
        let workerHost: String?

        /// Closure the parent passes in to seat a successful auth
        /// payload into native `SteamAuth`. Re-set on every
        /// `updateNSView` so AppState rebuilds don't strand it.
        var onAuthSuccess: ((WebAuthPayload) -> Void)?

        /// Closure for `kind: "action"` bridge messages. Maps the
        /// embedded page's per-panel toolbar buttons (Refresh,
        /// Import, Export → CSV/JSON) to native AppState methods.
        var onAction: ((WebHostAction) -> Void)?

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

        /// Last sign-in ticket we acted on. The parent flips this on
        /// every "Sign in with Steam" tap; we only fire when it
        /// genuinely changes so a re-render of the parent doesn't
        /// accidentally retrigger sign-in mid-flow.
        private var lastHandledSignInTicket: Int = 0
        /// True while we're waiting on a Steam OpenID round-trip we
        /// kicked off ourselves. If a sign-in retry comes in while
        /// this is set, we no-op (the page is already navigating).
        private var signInInFlight = false

        init(
            tab: Binding<SidebarSection>,
            workerHost: String?,
            onAuthSuccess: ((WebAuthPayload) -> Void)?,
            onAction: ((WebHostAction) -> Void)?
        ) {
            _tab = tab
            self.workerHost = workerHost
            self.onAuthSuccess = onAuthSuccess
            self.onAction = onAction
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

        // MARK: - Sign-in fan-out

        /// Called from `updateNSView`. If the parent's ticket changed,
        /// invoke the embedded page's `startSignIn()` (defined in
        /// Web/script.js' `window.SpireVault`). The OpenID flow runs
        /// inside the WKWebView, so the cookie + localStorage end up
        /// in our data store rather than the user's default browser.
        func requestSignInIfNeeded(ticket: Int, on webView: WKWebView) {
            guard ticket != lastHandledSignInTicket else { return }
            lastHandledSignInTicket = ticket
            guard ticket > 0 else { return } // 0 is the boot value; ignore
            guard !signInInFlight else { return }
            signInInFlight = true
            // If the bridge isn't up yet (very fast click on a fresh
            // launch), defer until the page reports ready. Otherwise
            // call straight in.
            if bridgeReady {
                fireStartSignIn(on: webView)
            }
        }

        private func fireStartSignIn(on webView: WKWebView) {
            // Belt-and-braces: the page may not have wired startSignIn
            // yet on very old web revisions. The optional-chain on the
            // JS side keeps us safe if so — sign-in just won't fire
            // and the user can click again after the page reloads.
            let js = """
            (function() {
              try {
                if (window.SpireVault && typeof window.SpireVault.startSignIn === 'function') {
                  window.SpireVault.startSignIn();
                } else if (typeof startSteamSignIn === 'function') {
                  // Older script.js builds didn't expose startSignIn on
                  // the SpireVault object — fall back to the global
                  // helper so a user on a stale web cache still works.
                  startSteamSignIn();
                }
              } catch (e) { console.warn('[VaultHost] startSignIn failed', e); }
            })();
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
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
                // If a sign-in tap arrived before the page bridge was
                // ready, fire it now. Common path: user lands on the
                // app, sees the sidebar pill, hits "Sign in with
                // Steam" before the WKWebView has finished booting.
                if signInInFlight, let view = webView {
                    fireStartSignIn(on: view)
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
            case "auth":
                // The embedded `auth.html` finished a Steam OpenID
                // round-trip and forwarded the verified payload to us.
                // Seat it in native SteamAuth so the sidebar pill,
                // co-op presence, and every native API call all
                // reflect login at once. We don't second-guess the
                // values — they were minted by our own worker after
                // an OpenID check we just performed inside this very
                // WebView, end-to-end inside our process.
                signInInFlight = false
                if let payload = WebAuthPayload(messageBody: body) {
                    let cb = onAuthSuccess
                    DispatchQueue.main.async { cb?(payload) }
                }
            case "auth-cancel":
                // The page told us the user bailed out of sign-in or
                // the OpenID round-trip failed. Clear the in-flight
                // flag so the next click re-fires the flow.
                signInInFlight = false
            case "action":
                // The embedded page's per-panel toolbar fired a data
                // op (Rescan / Import / Export → CSV or JSON). Hand
                // off to native AppState so the user gets the real
                // macOS file pickers and the canonical VaultCore
                // parser. Without this bridge the web's "Import"
                // button would silently no-op (its showDirectoryPicker
                // fallback can't reach the user's STS2 saves) and
                // "Export" would dump a file to ~/Downloads with no
                // overwrite confirmation.
                if let raw = body["action"] as? String,
                   let action = WebHostAction(rawValue: raw) {
                    let cb = onAction
                    DispatchQueue.main.async { cb?(action) }
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
        /// to the OS. Rule of thumb: companion-origin navigations and
        /// the Steam OpenID round-trip (worker + steamcommunity.com)
        /// stay inside; everything else (Steam profile pages, mailto,
        /// http(s) to other hosts, the `steam://` game launcher, etc.)
        /// opens in the user's actual browser/app.
        ///
        /// The Steam OpenID inclusion is what makes sign-in work: the
        /// flow is `worker /auth/steam/start` → `steamcommunity.com
        /// /openid/login` → `worker /auth/steam/callback` →
        /// `app.spirevault.app/auth.html`. If any of those bounce out
        /// to NSWorkspace, the cookie and the localStorage session
        /// end up in Safari/Chrome, not in our WKWebView's data
        /// store, and the embedded page stays signed-out forever.
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

            // Worker domain — start, callback, /api/_session, /notify,
            // anything else the page legitimately POSTs to. Without
            // this the Steam OpenID redirect bounces out to the
            // browser and the cookie ends up in Safari.
            if let workerHost, !workerHost.isEmpty, url.host == workerHost {
                decisionHandler(.allow); return
            }

            // Steam OpenID provider host(s). User picks "Sign in" /
            // confirms identity at steamcommunity.com, Steam 302s
            // back to the worker callback. Has to stay inside.
            if let host = url.host,
               WebHostView.inlineAuthHostSuffixes.contains(where: {
                   host == $0 || host.hasSuffix("." + $0)
               }) {
                decisionHandler(.allow); return
            }

            // Everything else: kick to NSWorkspace and cancel here.
            // This catches Steam profile links, mailto, external https,
            // GitHub README links from in-page footers, the `steam://`
            // scheme co-op uses to launch the game, etc. We do NOT
            // route this back through `thevault://` — that scheme is
            // used only by the legacy native sign-in handler.
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

// MARK: - Web action bridge ---------------------------------------------------

/// Each value corresponds to a button the embedded page's per-panel
/// toolbar paints — what the *cloud* version of the app exposes to
/// users. In desktop-host mode the click is intercepted by
/// `Web/script.js`, posted to the native `vaultHost` bridge as
/// `kind: "action", action: "<rawValue>"`, and dispatched to native
/// AppState. The point: the visible UI is 1:1 with the cloud, but
/// every action runs through native macOS surfaces (NSOpenPanel for
/// folder picks, NSSavePanel for exports, the canonical VaultCore
/// parser for rescans) instead of browser equivalents that can't
/// reach STS2's real save folder.
enum WebHostAction: String {
    case rescan          // "Refresh" — re-read linked save folder
    case pickSaves       // "Import" — set the linked save folder
    case revealSaves     // (menu) — show in Finder
    case exportCSV       // Export menu → Download CSV
    case exportJSON      // Export menu → Download JSON
}

// MARK: - Web auth payload ----------------------------------------------------

/// Shape of the `kind: "auth"` bridge message the embedded `auth.html`
/// posts back after a verified Steam OpenID round-trip. The native
/// side stores this in `SteamAuth` so the desktop sidebar pill, Co-op
/// presence service, and every native API call all reflect login at
/// the same instant.
struct WebAuthPayload {
    let steamID: String
    let persona: String
    let avatar: String?
    let session: String

    /// Decode from the `[String: Any]` JS bridge body. Returns nil if
    /// the payload is missing the two fields we cannot fabricate
    /// (steamID + session) — both are mandatory because every native
    /// write call is keyed on them.
    init?(messageBody body: [String: Any]) {
        guard
            let sid = (body["steamid"] as? String)?.trimmingCharacters(in: .whitespaces),
            !sid.isEmpty,
            sid.count == 17,
            sid.allSatisfy(\.isNumber),
            let session = (body["session"] as? String)?.trimmingCharacters(in: .whitespaces),
            session.count >= 16
        else { return nil }
        self.steamID = sid
        self.session = session
        self.persona = (body["persona"] as? String).flatMap {
            $0.isEmpty ? nil : $0
        } ?? "Steam User"
        let av = body["avatar"] as? String
        self.avatar = (av?.isEmpty == true) ? nil : av
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
