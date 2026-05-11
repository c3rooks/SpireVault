// src/main.rs — Tauri entry point.
// Keeps the main thread minimal; all logic lives in lib.rs so tests can
// import without touching the Tauri runtime.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    the_vault_lib::run();
}
