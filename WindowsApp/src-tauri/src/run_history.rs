// run_history.rs
// ─────────────────────────────────────────────────────────────────────────────
// Reads all completed `.run` files from the STS2 save folder and returns them
// as `RunRecord` values. These are ingested into the embedded WebView2 via
// `window.SpireVault.ingestDesktopRuns(json)` — the same JS call the macOS
// WKWebView uses.
//
// The JSON shape matches what the web companion's `reviveRun()` / `parseRunRecord()`
// expects — camelCase keys, ISO date strings.
// ─────────────────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Matches the RunRecord shape in VaultCore + the web companion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub character: Option<String>,
    pub ascension: Option<i32>,
    pub floor_reached: Option<i32>,
    pub won: Option<bool>,
    pub killed_by: Option<String>,
    pub killed_by_floor: Option<i32>,
    pub ended_at: Option<String>,
    pub parsed_at: String,
    pub play_time_seconds: Option<f64>,
    pub deck: Vec<String>,
    pub relics: Vec<String>,
    pub potions: Vec<String>,
    pub act_1_boss: Option<String>,
    pub act_2_boss: Option<String>,
    pub act_3_boss: Option<String>,
    pub seed: Option<String>,
    pub game_mode: Option<String>,
    pub modifiers: Vec<String>,
    pub gold: Option<i32>,
    pub score: Option<i32>,
    pub path_taken: Vec<String>,
    pub build_version: Option<String>,
    // In-progress flag for the live save bridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_progress: Option<bool>,
}

fn normalize_id(prefix: &str, raw: &str) -> String {
    raw.strip_prefix(prefix).unwrap_or(raw).to_lowercase()
}

const EMPTY_POTION_IDS: &[&str] = &["empty_potion", "placeholder", "empty", "none", ""];

fn extract_string_or_id(v: &serde_json::Value) -> Option<String> {
    v.as_str()
        .map(|s| s.to_string())
        .or_else(|| v.get("id").and_then(|id| id.as_str()).map(|s| s.to_string()))
}

/// Parse a single `.run` file JSON blob into a `RunRecord`.
pub fn parse_run_json(json_str: &str, file_stem: &str) -> Option<RunRecord> {
    let obj: serde_json::Value = serde_json::from_str(json_str).ok()?;

    // Unique run ID — prefer the embedded `id`, fall back to file stem.
    let id = obj
        .get("id")
        .or_else(|| obj.get("seed"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| file_stem.to_string());

    let player = obj.get("player").unwrap_or(&obj);

    // Character
    let character = player
        .get("character")
        .or_else(|| obj.get("character"))
        .and_then(|v| extract_string_or_id(v))
        .map(|s| normalize_id("CHARACTER.", &s));

    // Ascension
    let ascension = obj
        .get("ascension_level")
        .or_else(|| obj.get("ascensionLevel"))
        .or_else(|| obj.get("ascension"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);

    // Floor
    let floor_reached = obj
        .get("floor_reached")
        .or_else(|| obj.get("floorReached"))
        .or_else(|| obj.get("floor_num"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);

    // Outcome
    let won = obj
        .get("victory")
        .or_else(|| obj.get("won"))
        .or_else(|| obj.get("win"))
        .and_then(|v| v.as_bool());

    // Killed by
    let killed_by = obj
        .get("killed_by")
        .or_else(|| obj.get("killedBy"))
        .and_then(|v| v.as_str())
        .map(|s| normalize_id("", s));
    let killed_by_floor = obj
        .get("killed_by_floor")
        .or_else(|| obj.get("killedByFloor"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);

    // Time
    let ended_at = obj
        .get("ended_at")
        .or_else(|| obj.get("endedAt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let play_time_seconds = obj
        .get("play_time")
        .or_else(|| obj.get("playTime"))
        .or_else(|| obj.get("play_time_seconds"))
        .and_then(|v| v.as_f64());
    let parsed_at = chrono::Utc::now().to_rfc3339();

    // Deck
    let deck: Vec<String> = player
        .get("deck")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let raw = extract_string_or_id(c)?;
                    let stripped = normalize_id("CARD.", &raw);
                    let upgrade = c
                        .get("current_upgrade_level")
                        .or_else(|| c.get("upgrades"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    if upgrade > 0 {
                        Some(format!("{}+{}", stripped, upgrade))
                    } else {
                        Some(stripped)
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Relics
    let relics: Vec<String> = player
        .get("relics")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| extract_string_or_id(r).map(|s| normalize_id("RELIC.", &s)))
                .collect()
        })
        .unwrap_or_default();

    // Potions (filter empty)
    let potions: Vec<String> = player
        .get("potions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let id = extract_string_or_id(p).map(|s| normalize_id("POTION.", &s))?;
                    if EMPTY_POTION_IDS.contains(&id.as_str()) {
                        None
                    } else {
                        Some(id)
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Boss kills — look in nested `boss_relics` history or flat kill markers.
    let act_1_boss = obj
        .get("act_1_boss_kill")
        .or_else(|| obj.get("act1Boss"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase());
    let act_2_boss = obj
        .get("act_2_boss_kill")
        .or_else(|| obj.get("act2Boss"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase());
    let act_3_boss = obj
        .get("act_3_boss_kill")
        .or_else(|| obj.get("act3Boss"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase());

    // Seed / Game mode / Modifiers
    let seed = obj
        .get("seed")
        .or_else(|| obj.get("seed_played"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let game_mode = obj
        .get("game_mode")
        .or_else(|| obj.get("gameMode"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase());
    let modifiers: Vec<String> = obj
        .get("modifiers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    extract_string_or_id(m).map(|s| normalize_id("MODIFIER.", &s))
                })
                .collect()
        })
        .unwrap_or_default();

    // Gold
    let gold = player
        .get("gold")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);
    let score = obj.get("score").and_then(|v| v.as_i64()).map(|v| v as i32);

    // Path
    let path_taken: Vec<String> = obj
        .get("path_taken")
        .or_else(|| obj.get("pathTaken"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    p.as_str()
                        .map(|s| s.to_string())
                        .or_else(|| extract_string_or_id(p))
                })
                .collect()
        })
        .unwrap_or_default();

    let build_version = obj
        .get("build_version")
        .or_else(|| obj.get("buildVersion"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(RunRecord {
        id,
        character,
        ascension,
        floor_reached,
        won,
        killed_by,
        killed_by_floor,
        ended_at,
        parsed_at,
        play_time_seconds,
        deck,
        relics,
        potions,
        act_1_boss,
        act_2_boss,
        act_3_boss,
        seed,
        game_mode,
        modifiers,
        gold,
        score,
        path_taken,
        build_version,
        in_progress: None,
    })
}

/// Scan a save folder for all `.run` files and return parsed records.
/// Runs that fail to parse are silently skipped (same as VaultCore).
pub fn scan_run_files(save_folder: &Path) -> Vec<RunRecord> {
    let mut runs: Vec<RunRecord> = Vec::new();

    let dir = match std::fs::read_dir(save_folder) {
        Ok(d) => d,
        Err(_) => return runs,
    };

    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("run") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let json = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Some(rec) = parse_run_json(&json, &stem) {
            runs.push(rec);
        }
    }

    // Sort newest first (by ended_at, then parsed_at)
    runs.sort_by(|a, b| {
        let at = |r: &RunRecord| r.ended_at.as_deref().unwrap_or(&r.parsed_at).to_string();
        at(b).cmp(&at(a))
    });

    runs
}
