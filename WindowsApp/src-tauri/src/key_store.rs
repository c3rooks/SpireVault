// key_store.rs
// ─────────────────────────────────────────────────────────────────────────────
// API key persistence — Windows equivalent of macOS OverlayKeychain.swift.
// Uses a file-backed JSON store (same strategy as the macOS v0.9.5 migration)
// written to %APPDATA%\TheVault\vault\overlay-keys.json with user-only ACLs.
//
// We deliberately avoid the Windows Credential Manager for now: the keyring
// crate requires a thread that can pump a UI message loop on some Windows
// versions, and the API key UX (paste once, stored forever) doesn't need
// the extra complexity. If we move to a native Win32 app later we can
// migrate to CryptProtectData (DPAPI) without changing the public API.
// ─────────────────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    fs,
};

#[derive(Debug, Serialize, Deserialize, Default)]
struct KeyStore {
    keys: HashMap<String, String>,
}

fn store_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = PathBuf::from(appdata)
        .join("TheVault")
        .join("vault");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("overlay-keys.json"))
}

fn load_store() -> KeyStore {
    let path = match store_path() {
        Some(p) => p,
        None => return KeyStore::default(),
    };
    let json = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return KeyStore::default(),
    };
    serde_json::from_str(&json).unwrap_or_default()
}

fn save_store(store: &KeyStore) {
    if let Some(path) = store_path() {
        if let Ok(json) = serde_json::to_string_pretty(store) {
            // Atomic write via temp file rename — same pattern as OverlayKeychain.swift
            let tmp = path.with_extension("tmp");
            if fs::write(&tmp, &json).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
    }
}

/// Store an API key for `provider` ("openai" or "anthropic").
pub fn set_api_key(provider: &str, key: &str) -> bool {
    let mut store = load_store();
    if key.is_empty() {
        store.keys.remove(provider);
    } else {
        store.keys.insert(provider.to_string(), key.to_string());
    }
    save_store(&store);
    true
}

/// Retrieve an API key for `provider`. Returns `None` if not set.
pub fn get_api_key(provider: &str) -> Option<String> {
    let store = load_store();
    store.keys.get(provider).cloned().filter(|k| !k.is_empty())
}

/// Clear all stored keys.
pub fn clear_all_keys() {
    save_store(&KeyStore::default());
}
