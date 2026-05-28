// lib.rs
// ─────────────────────────────────────────────────────────────────────────────
// The Vault — Windows (Tauri 2)
//
// This module is the macOS WKWebView coordinator's spiritual twin:
//   • Boots two WebView2 windows: main (app.spirevault.app) + overlay.
//   • Injects window.__VAULT_DESKTOP__ + a webkit bridge shim so the web
//     companion's existing window.webkit.messageHandlers.vaultHost calls
//     route to Tauri commands without any change to script.js.
//   • Watches the STS2 save folder and pushes run data into the WebView
//     via window.SpireVault.ingestDesktopRuns(json).
//   • Pushes live snapshot deltas as tracker chips via
//     window.SpireVault.ingestTrackerChip(delta).
//   • Exposes Tauri commands for: API key get/set, screen capture,
//     overlay show/hide, save folder get/set.
// ─────────────────────────────────────────────────────────────────────────────

mod key_store;
mod run_history;
mod save_reader;
mod save_watcher;
mod snapshot_delta;

use run_history::{scan_run_files, RunRecord};
use save_reader::{default_sts2_save_path, read_live_snapshot, LiveRunSnapshot};
use save_watcher::SaveWatcher;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};

// ─── App state shared across commands ────────────────────────────────────────

pub struct VaultState {
    pub save_folder: Mutex<Option<PathBuf>>,
    pub last_snapshot: Mutex<Option<LiveRunSnapshot>>,
    pub last_run_count: Mutex<usize>,
    /// Kept alive so the watcher doesn't drop.
    pub _watcher: Mutex<Option<SaveWatcher>>,
}

impl VaultState {
    fn new() -> Arc<Self> {
        Arc::new(VaultState {
            save_folder: Mutex::new(None),
            last_snapshot: Mutex::new(None),
            last_run_count: Mutex::new(0),
            _watcher: Mutex::new(None),
        })
    }
}

// ─── Version string (mirrors VaultBundleInfo on macOS) ───────────────────────

const VAULT_VERSION: &str = env!("CARGO_PKG_VERSION");

// ─── JS bridge shim ──────────────────────────────────────────────────────────
//
// The web companion calls `window.webkit.messageHandlers.vaultHost.postMessage`
// to send events (auth success, tab-change, action buttons) back to the host.
// On macOS that lands in WKScriptMessageHandler. On Windows we rewrite the
// same call site in JavaScript so it routes to `window.__TAURI__.invoke()`
// instead — the web companion needs zero changes.
//
// Also inject window.__VAULT_DESKTOP__ and the SpireVault.seedSession shim
// so the auth handshake from auth.html works identically.

const WEBKIT_SHIM: &str = r#"
(function () {
  if (window.__VAULT_TAURI_SHIM__) return;
  window.__VAULT_TAURI_SHIM__ = true;

  // Replicate the webkit message-handler bridge so script.js needs no changes.
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.vaultHost = {
    postMessage: function(msg) {
      if (window.__TAURI__ && window.__TAURI__.invoke) {
        window.__TAURI__.invoke('vault_host_message', { msg: msg }).catch(function(e){
          console.warn('[VaultBridge] invoke failed', e, msg);
        });
      }
    }
  };

  // SpireVault.seedSession — called from auth.html after Steam OpenID
  // to seat the session natively. On macOS this goes through the JS bridge;
  // here we route it through Tauri invoke.
  var _origSpireVault = window.SpireVault || {};
  window.__patchSpireVaultSeedSession = function() {
    if (!window.SpireVault || window.SpireVault.__tauriPatched) return;
    var orig = window.SpireVault;
    window.SpireVault = Object.assign({}, orig, {
      __tauriPatched: true,
      seedSession: function(payload) {
        if (window.__TAURI__ && window.__TAURI__.invoke) {
          window.__TAURI__.invoke('vault_host_message', {
            msg: { kind: 'auth', payload: payload }
          }).catch(function(e) { console.warn('[VaultBridge] seedSession failed', e); });
        }
        return orig.seedSession ? orig.seedSession(payload) : false;
      }
    });
  };
  // Patch now (if SpireVault full impl is already loaded)
  // and again after DOM content loaded (if still the stub).
  window.__patchSpireVaultSeedSession();
  document.addEventListener('DOMContentLoaded', window.__patchSpireVaultSeedSession);
  window.addEventListener('load', window.__patchSpireVaultSeedSession);
})();
"#;

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Called by the webkit shim whenever the web companion would have called
/// `window.webkit.messageHandlers.vaultHost.postMessage(msg)` on macOS.
/// Routes each `kind` to the appropriate native action.
#[tauri::command]
async fn vault_host_message(
    msg: serde_json::Value,
    app: AppHandle,
    state: State<'_, Arc<VaultState>>,
) -> Result<(), String> {
    let kind = msg
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    match kind.as_str() {
        "auth" => {
            // Steam OpenID round-trip completed — seat the session.
            // The payload from auth.html mirrors what macOS acceptWebSession receives.
            let payload = msg.get("payload").cloned().unwrap_or_default();
            app.emit("vault:auth-success", &payload)
                .map_err(|e| e.to_string())?;
        }
        "tabChange" => {
            // Web page changed its active tab — emit to Rust side (for future tray menu sync).
            let tab = msg.get("tab").and_then(|v| v.as_str()).unwrap_or("overview");
            app.emit("vault:tab-change", tab).map_err(|e| e.to_string())?;
        }
        "action" => {
            let action = msg.get("action").and_then(|v| v.as_str()).unwrap_or("");
            match action {
                "rescan" => {
                    // Re-scan save folder and push fresh runs.
                    push_runs_to_webview(&app, &state);
                }
                "pickSaves" => {
                    // Show native folder picker — handled by the dialog plugin.
                    app.emit("vault:pick-saves", ()).map_err(|e| e.to_string())?;
                }
                "exportCSV" | "exportJSON" => {
                    app.emit("vault:export", action).map_err(|e| e.to_string())?;
                }
                _ => {}
            }
        }
        _ => {}
    }

    Ok(())
}

/// Return the current save folder path (or the auto-detected default).
#[tauri::command]
fn get_save_folder(state: State<'_, Arc<VaultState>>) -> Option<String> {
    let folder = state.save_folder.lock().unwrap();
    folder
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .or_else(|| default_sts2_save_path().map(|p| p.to_string_lossy().to_string()))
}

/// Persist a user-chosen save folder and restart the file watcher.
#[tauri::command]
async fn set_save_folder(
    path: String,
    app: AppHandle,
    state: State<'_, Arc<VaultState>>,
) -> Result<(), String> {
    let folder = PathBuf::from(&path);
    if !folder.exists() {
        return Err(format!("Folder not found: {}", path));
    }
    {
        let mut guard = state.save_folder.lock().unwrap();
        *guard = Some(folder.clone());
    }
    restart_watcher(app.clone(), state.inner().clone(), folder);
    // Immediately push fresh data.
    push_runs_to_webview(&app, &state);
    Ok(())
}

/// Return all parsed runs as a JSON array for `window.SpireVault.ingestDesktopRuns`.
#[tauri::command]
fn get_runs(state: State<'_, Arc<VaultState>>) -> Vec<RunRecord> {
    let folder = resolve_save_folder(&state);
    match folder {
        Some(f) => scan_run_files(&f),
        None => vec![],
    }
}

/// Return the current live run snapshot.
#[tauri::command]
fn get_live_snapshot(state: State<'_, Arc<VaultState>>) -> Option<LiveRunSnapshot> {
    let folder = resolve_save_folder(&state)?;
    read_live_snapshot(&folder)
}

/// API key commands — mirror OverlayKeychain.swift
#[tauri::command]
fn set_api_key(provider: String, key: String) -> bool {
    key_store::set_api_key(&provider, &key)
}

#[tauri::command]
fn get_api_key(provider: String) -> Option<String> {
    key_store::get_api_key(&provider)
}

#[tauri::command]
fn clear_api_keys() {
    key_store::clear_all_keys();
}

/// Show / hide the overlay window.
#[tauri::command]
async fn show_overlay(visible: bool, app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        if visible {
            overlay.show().map_err(|e| e.to_string())?;
            overlay.set_focus().map_err(|e| e.to_string())?;
        } else {
            overlay.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Resize the overlay to expand (chat mode) or collapse (pill mode).
#[tauri::command]
async fn resize_overlay(width: u32, height: u32, app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width,
                height,
            }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Persist overlay position (called by the overlay when the user drags it).
#[tauri::command]
async fn set_overlay_position(x: i32, y: i32, app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring the main window to front (used by overlay close button — mirrors
/// OverlayController.openMainWindow on macOS).
#[tauri::command]
async fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return app version so the WebView can show it.
#[tauri::command]
fn app_version() -> String {
    VAULT_VERSION.to_string()
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

fn resolve_save_folder(state: &VaultState) -> Option<PathBuf> {
    let guard = state.save_folder.lock().unwrap();
    guard.clone().or_else(|| default_sts2_save_path())
}

/// Re-scan and push runs + live snapshot to all open WebView windows.
fn push_runs_to_webview(app: &AppHandle, state: &VaultState) {
    let Some(folder) = resolve_save_folder(state) else { return };

    // ── Completed run history ────────────────────────────────────────────────
    let runs = scan_run_files(&folder);
    let run_count = runs.len();
    {
        let mut last = state.last_run_count.lock().unwrap();
        *last = run_count;
    }

    // Serialize runs array. On a 400-run history this is ~2 MB — acceptable
    // for a one-time ingest on startup; subsequent calls are cheap (change is
    // incremental) but we still send the full set for simplicity, matching
    // the macOS coordinator behaviour.
    if let Ok(json) = serde_json::to_string(&runs) {
        let js = format!(
            "if(window.SpireVault?.ingestDesktopRuns){{try{{window.SpireVault.ingestDesktopRuns({json})}}catch(e){{console.warn('[VaultBridge] ingest failed',e)}}}}",
        );
        eval_in_window(app, "main", &js);
    }

    // ── Live snapshot ────────────────────────────────────────────────────────
    let snapshot = read_live_snapshot(&folder);
    let mut prev_guard = state.last_snapshot.lock().unwrap();

    // Snapshot delta → tracker chips
    if let Some(snap) = &snapshot {
        if snap.in_progress {
            if let Some(prev) = prev_guard.as_ref() {
                let deltas = snapshot_delta::diff(prev, snap);
                for delta in deltas {
                    if let Ok(json) = serde_json::to_string(&delta) {
                        let js = format!(
                            "if(window.SpireVault?.ingestTrackerChip){{try{{window.SpireVault.ingestTrackerChip({json})}}catch(e){{}}}}",
                        );
                        eval_in_window(app, "main", &js);
                        eval_in_window(app, "overlay", &js);
                    }
                }
            }
            // Push snapshot to overlay for the live run header (floor/HP/gold pill)
            if let Ok(json) = serde_json::to_string(snap) {
                let js = format!(
                    "if(window.SpireVault?.ingestLiveSnapshot){{try{{window.SpireVault.ingestLiveSnapshot({json})}}catch(e){{}}}}",
                );
                eval_in_window(app, "main", &js);
                eval_in_window(app, "overlay", &js);
            }
        }
    }
    *prev_guard = snapshot;
}

fn eval_in_window(app: &AppHandle, label: &str, js: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.eval(js);
    }
}

// ─── Main-window show/hide helpers (driven by tray + window close) ────────────
//
// Shared by the tray left-click handler, the "Show SpireVault" menu item, and
// the "Hide to tray" menu item. Pulled out as free functions so all three
// entry points stay in sync — v0.9.9 split this logic between a half-wired
// tray handler and a Tauri command, which is how the bug slipped in.

/// Restore the main window from tray: show, unminimize, focus.
/// Called by the tray left-click handler and the "Show SpireVault" menu item.
fn restore_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };

    // Order matters on Windows: show() first (no-op if already visible),
    // then unminimize() (no-op if not minimized), then set_focus() to
    // bring to front + take keyboard focus. set_focus is called last so
    // foreground rules apply to a window that is already visible and
    // restored — otherwise Windows can swallow the focus request and
    // we'd just get a taskbar flash instead of a focused window.
    let _ = win.show();
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.set_focus();
}

/// Hide the main window to the tray. The process keeps running; the tray
/// icon (or Alt+Space overlay) is the only way to bring it back.
fn hide_main_window_to_tray(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

/// (Re)start the file watcher for `folder`. Stores the new watcher in state,
/// dropping the old one which stops the previous watch automatically.
fn restart_watcher(app: AppHandle, state: Arc<VaultState>, folder: PathBuf) {
    let state_clone = state.clone();
    let app_clone = app.clone();
    let folder_clone = folder.clone();

    let watcher_result = SaveWatcher::start(folder, move || {
        push_runs_to_webview(&app_clone, &state_clone);
    });

    match watcher_result {
        Ok(w) => {
            // Use the function-owned `state` directly. The previous
            // `state.clone()._watcher.lock()` form created a temporary
            // Arc that dropped at statement end, leaving the MutexGuard
            // dangling — rejected by Rust 2021's temporary-lifetime rules.
            let mut guard = state._watcher.lock().unwrap();
            *guard = Some(w);
            eprintln!(
                "[VaultWatcher] watching {}",
                folder_clone.display()
            );
        }
        Err(e) => {
            eprintln!("[VaultWatcher] failed to watch: {}", e);
        }
    }
}

// ─── Entry point ─────────────────────────────────────────────────────────────
//
// OBS / screen-recording invisibility (`SetWindowDisplayAffinity` with
// `WDA_EXCLUDEFROMCAPTURE`) intentionally removed from the v0.9.9 MVP —
// the Tauri 2 build no longer re-exports `tauri::raw_window_handle`, so
// the previous implementation no longer compiles. The macOS counterpart
// (`NSWindow.sharingType = .none`) still runs in the Swift app. When we
// re-introduce the Windows invisibility behaviour, pull HWND via
// `raw_window_handle::HasWindowHandle` directly (the crate is already a
// transitive dep of Tauri 2 winit) and call `SetWindowDisplayAffinity`
// from the `windows` crate.

pub fn run() {
    let vault_state = VaultState::new();
    let state_for_setup = vault_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // updater plugin intentionally omitted — see Cargo.toml comment.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .manage(vault_state)
        // Window-close → hide-to-tray. Clicking the X on the main window
        // hides it instead of quitting the process; the tray menu's "Quit"
        // item is the only true exit. This mirrors what users expect from
        // any system-tray app (Discord, Slack, Steam tray, etc.) and avoids
        // the "where did my live-run watcher go" surprise when someone X's
        // out mid-run.
        //
        // The overlay window is left alone — it's already small, frameless,
        // and skipTaskbar=true, so its close behaviour doesn't matter to
        // the user-facing flow. We only intercept the main window.
        //
        // TODO(0.10.x): expose this as a setting once the in-app
        // preferences panel lands, so users who prefer close-to-quit can
        // opt out. For the v0.9.10 bug-fix release we hardcode tray-friendly
        // behaviour because that's the whole point of the tray icon.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault_host_message,
            get_save_folder,
            set_save_folder,
            get_runs,
            get_live_snapshot,
            set_api_key,
            get_api_key,
            clear_api_keys,
            show_overlay,
            resize_overlay,
            set_overlay_position,
            show_main_window,
            app_version,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // ── Inject desktop flag + webkit bridge shim into both windows ──
            // Tauri 2.x dropped per-window `initialization_script` from the
            // config schema; everything that used to live there now flows
            // through `win.eval()` in setup, which fires before the first
            // user script and re-runs on every navigation reload. The
            // WEBKIT_SHIM patches Object.prototype glue separately on
            // DOMContentLoaded / load so late-bound SpireVault.seedSession
            // calls still land correctly.
            for label in ["main", "overlay"] {
                if let Some(win) = handle.get_webview_window(label) {
                    let version = VAULT_VERSION;
                    let overlay_flag = if label == "overlay" {
                        "window.__VAULT_OVERLAY__=true;"
                    } else {
                        ""
                    };
                    let init = format!(
                        "window.__VAULT_DESKTOP__=true;\
                         window.__VAULT_DESKTOP_PLATFORM__='windows';\
                         window.__VAULT_DESKTOP_VERSION__='{version}';\
                         {overlay_flag}\
                         {WEBKIT_SHIM}"
                    );
                    let _ = win.eval(&init);
                }
            }

            // OBS invisibility step intentionally removed — see top-of-module
            // comment for restoration plan.

            // ── Auto-detect STS2 save folder ────────────────────────────────
            let state = state_for_setup.clone();
            if let Some(folder) = default_sts2_save_path() {
                eprintln!("[Vault] auto-detected save folder: {}", folder.display());
                {
                    let mut guard = state.save_folder.lock().unwrap();
                    *guard = Some(folder.clone());
                }
                let handle_clone = handle.clone();
                let state_clone = state.clone();
                restart_watcher(handle_clone.clone(), state_clone.clone(), folder.clone());

                // Initial data push — do it after a short delay so the
                // WebView finishes loading before we call ingestDesktopRuns.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    push_runs_to_webview(&handle_clone, &state_clone);
                });
            }

            // ── Global hotkey: Alt+Space → toggle overlay ────────────────────
            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
            let shortcut =
                Shortcut::new(Some(Modifiers::ALT), Code::Space);
            let handle_hs = handle.clone();
            app.global_shortcut()
                .on_shortcut(shortcut.clone(), move |_app, _shortcut, _event| {
                    if let Some(overlay) = handle_hs.get_webview_window("overlay") {
                        let visible = overlay.is_visible().unwrap_or(false);
                        if visible {
                            let _ = overlay.hide();
                        } else {
                            let _ = overlay.show();
                            let _ = overlay.set_focus();
                        }
                    }
                })
                .ok();
            app.global_shortcut().register(shortcut).ok();

            // ── Tray menu + click handlers ───────────────────────────────────
            //
            // v0.9.9 registered the tray icon via tauri.conf.json but never
            // attached a menu or a real click handler, so the icon appeared
            // in the system tray but did nothing on click. v0.9.10 wires:
            //   • Show SpireVault   → restore + focus the main window
            //   • Hide to tray      → hide the main window (app keeps running)
            //   • ────────────────
            //   • Quit              → app.exit(0)
            // Left-click on the icon  → same as "Show SpireVault"
            // Right-click on the icon → opens the menu (default Tauri
            //   behaviour because tauri.conf.json sets menuOnLeftClick=false)
            //
            // The tray icon itself is configured in tauri.conf.json (with an
            // explicit id="main"); here we just look it up and attach the
            // menu + handlers. Tauri 2's MenuItem API has no "default item"
            // concept, but "Show SpireVault" is intentionally first so that
            // the platforms that DO bold the first item (some Linux DEs) get
            // the right one.
            let show_item = MenuItem::with_id(
                app,
                "tray_show",
                "Show SpireVault",
                true,
                None::<&str>,
            )?;
            let hide_item = MenuItem::with_id(
                app,
                "tray_hide",
                "Hide to tray",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(
                app,
                "tray_quit",
                "Quit",
                true,
                None::<&str>,
            )?;
            let tray_menu = Menu::with_items(
                app,
                &[&show_item, &hide_item, &separator, &quit_item],
            )?;

            if let Some(tray) = app.tray_by_id("main") {
                tray.set_menu(Some(tray_menu))?;
            } else {
                // Shouldn't happen — tauri.conf.json declares a tray with
                // id="main" — but if it ever does, log instead of panicking
                // so the rest of the app still boots.
                eprintln!(
                    "[Vault] tray icon 'main' not found at setup time; \
                     menu not attached. Check tauri.conf.json#app.trayIcon."
                );
            }

            // Global menu-event handler — fires for any menu in the app.
            // We only own the tray menu, so all ids here come from there.
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "tray_show" => restore_main_window(app),
                "tray_hide" => hide_main_window_to_tray(app),
                "tray_quit" => app.exit(0),
                _ => {}
            });

            // Global tray-icon event handler. Right-click is handled by Tauri
            // itself (opens the menu); we only need to wire left-click → show.
            // Filtering on `Up` avoids firing twice per click (Down + Up).
            app.on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    restore_main_window(tray.app_handle());
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running The Vault");
}
