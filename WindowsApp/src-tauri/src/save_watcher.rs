// save_watcher.rs
// ─────────────────────────────────────────────────────────────────────────────
// Watches the STS2 save folder for file changes using the `notify` crate
// (which uses ReadDirectoryChangesW on Windows — the native equivalent of
// macOS kqueue/FSEvents used by STS2LiveSaveWatcher.swift).
//
// Fires a debounced callback on any `.save` or `.run` file change so the Rust
// backend can re-parse and push fresh data to the WebView.
// ─────────────────────────────────────────────────────────────────────────────

use notify::{recommended_watcher, Event, EventKind, RecursiveMode, Watcher};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Minimum interval between callback invocations. Matches the macOS
/// `STS2LiveSaveWatcher` 500ms debounce.
const DEBOUNCE_MS: u64 = 500;

pub struct SaveWatcher {
    _watcher: Box<dyn Watcher + Send>,
}

impl SaveWatcher {
    /// Start watching `folder`. `on_change` is called (on a background thread)
    /// when any `.save` or `.run` file inside the folder is modified.
    /// Returns an owned `SaveWatcher` — drop it to stop watching.
    pub fn start<F>(folder: PathBuf, on_change: F) -> Result<Self, notify::Error>
    where
        F: Fn() + Send + 'static,
    {
        let last_fired: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

        let mut watcher = recommended_watcher(move |result: notify::Result<Event>| {
            let event = match result {
                Ok(e) => e,
                Err(_) => return,
            };

            // Only react to Modify and Create events on save/run files.
            let relevant = matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            );
            if !relevant {
                return;
            }
            let touches_save_file = event.paths.iter().any(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|ext| ext == "save" || ext == "run")
                    .unwrap_or(false)
            });
            if !touches_save_file {
                return;
            }

            // Debounce: only fire if DEBOUNCE_MS has passed since last call.
            let mut guard = last_fired.lock().unwrap();
            let now = Instant::now();
            let should_fire = match *guard {
                None => true,
                Some(last) => now.duration_since(last) >= Duration::from_millis(DEBOUNCE_MS),
            };
            if should_fire {
                *guard = Some(now);
                drop(guard); // release lock before calling user code
                on_change();
            }
        })?;

        watcher.watch(&folder, RecursiveMode::NonRecursive)?;

        Ok(SaveWatcher {
            _watcher: Box::new(watcher),
        })
    }
}
