// save_reader.rs
// ─────────────────────────────────────────────────────────────────────────────
// Reads STS2's `current_run.save` file and produces a `LiveRunSnapshot` —
// the same data shape the macOS app's `STS2LiveSaveReader` produces.
//
// STS2 on Windows writes saves to:
//   %APPDATA%\SlayTheSpire2\saves\
// The live save is `current_run.save` (JSON, no extension rename).
// Completed runs are written to individual `.run` files in the same folder.
// ─────────────────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Default STS2 save directory on Windows.
pub fn default_sts2_save_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let candidate = PathBuf::from(appdata)
        .join("SlayTheSpire2")
        .join("saves");
    if candidate.exists() {
        Some(candidate)
    } else {
        // Also check LocalAppData
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let alt = PathBuf::from(local)
                .join("SlayTheSpire2")
                .join("saves");
            if alt.exists() {
                return Some(alt);
            }
        }
        None
    }
}

/// Live in-game snapshot. Matches the shape `OverlayAIService` consumes on
/// macOS — same field names after camelCase→snake_case conversion so the
/// JSON round-trip through `window.SpireVault.ingestDesktopRuns` works.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRunSnapshot {
    pub in_progress: bool,
    pub character: Option<String>,
    pub ascension: Option<i32>,
    pub floor: i32,
    pub act: Option<i32>,
    pub current_hp: Option<i32>,
    pub max_hp: Option<i32>,
    pub gold: Option<i32>,
    pub seed: Option<String>,
    pub game_mode: Option<String>,
    pub modifiers: Vec<String>,
    pub deck: Vec<String>,
    pub relics: Vec<String>,
    pub potions: Vec<String>,
    pub last_room_type: Option<String>,
    pub file_modified_at: Option<String>,
    pub source_path: Option<String>,
}

impl Default for LiveRunSnapshot {
    fn default() -> Self {
        LiveRunSnapshot {
            in_progress: false,
            character: None,
            ascension: None,
            floor: 0,
            act: None,
            current_hp: None,
            max_hp: None,
            gold: None,
            seed: None,
            game_mode: None,
            modifiers: vec![],
            deck: vec![],
            relics: vec![],
            potions: vec![],
            last_room_type: None,
            file_modified_at: None,
            source_path: None,
        }
    }
}

// Empty potion slot IDs — same filter as `STS2LiveSaveReader` on macOS.
const EMPTY_POTION_IDS: &[&str] = &["empty_potion", "placeholder", "empty", "none", ""];

fn strip_prefix<'a>(prefix: &str, raw: &'a str) -> &'a str {
    raw.strip_prefix(prefix).unwrap_or(raw)
}

fn normalize_id(prefix: &str, raw: &str) -> String {
    strip_prefix(prefix, raw).to_lowercase()
}

fn live_room_type(room: Option<&str>, map_point: Option<&str>) -> String {
    let mp = map_point.unwrap_or("").to_lowercase();
    match mp.as_str() {
        "boss" => return "boss".into(),
        "elite" => return "elite".into(),
        "shop" => return "shop".into(),
        _ => {}
    }
    match room.unwrap_or("").to_lowercase().as_str() {
        "monster" | "combat" => "combat".into(),
        "elite" => "elite".into(),
        "boss" => "boss".into(),
        "shop" => "shop".into(),
        "event" => "event".into(),
        "rest" | "campfire" => "rest".into(),
        "ancient" | "treasure" => "chest".into(),
        _ => "unknown".into(),
    }
}

/// Read and parse `current_run.save` from the given save folder.
/// Returns `None` if the file doesn't exist or can't be parsed.
pub fn read_live_snapshot(save_folder: &Path) -> Option<LiveRunSnapshot> {
    // Try the primary live-save filename, then fallbacks.
    let candidates = ["current_run.save", "run_in_progress.json"];
    let (path, contents) = candidates
        .iter()
        .filter_map(|name| {
            let p = save_folder.join(name);
            let c = std::fs::read_to_string(&p).ok()?;
            Some((p, c))
        })
        .next()?;

    let modified = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0))
        })
        .flatten()
        .map(|dt| dt.to_rfc3339());

    parse_save_json(&contents, modified, Some(path.to_string_lossy().to_string()))
}

/// Parse a STS2 save-file JSON blob into a `LiveRunSnapshot`.
/// Public so the snapshot-delta test can pass raw JSON.
pub fn parse_save_json(
    json: &str,
    modified_at: Option<String>,
    source_path: Option<String>,
) -> Option<LiveRunSnapshot> {
    let obj: serde_json::Value = serde_json::from_str(json).ok()?;
    parse_snapshot_value(&obj, modified_at, source_path)
}

fn parse_snapshot_value(
    obj: &serde_json::Value,
    modified_at: Option<String>,
    source_path: Option<String>,
) -> Option<LiveRunSnapshot> {
    // Root-level `player` sub-object contains most gameplay state.
    let player = obj.get("player").unwrap_or(obj);

    // `in_progress` — a run is live if `game_state` is "IN_PROGRESS" or
    // the object has a non-null `run` sub-object without a `win` key.
    let game_state = obj
        .get("game_state")
        .or_else(|| obj.get("gameState"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let in_progress = game_state.eq_ignore_ascii_case("IN_PROGRESS")
        || game_state.eq_ignore_ascii_case("PLAYING")
        || (!game_state.is_empty() && obj.get("win").is_none());

    if !in_progress {
        return Some(LiveRunSnapshot {
            in_progress: false,
            ..Default::default()
        });
    }

    // Floor
    let floor = obj
        .get("floor_num")
        .or_else(|| obj.get("floorNum"))
        .or_else(|| obj.get("floor"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    // Act
    let act = obj
        .get("act")
        .or_else(|| obj.get("act_num"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);

    // HP
    let current_hp = player
        .get("current_health")
        .or_else(|| player.get("currentHealth"))
        .or_else(|| player.get("hp"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);
    let max_hp = player
        .get("max_health")
        .or_else(|| player.get("maxHealth"))
        .or_else(|| player.get("max_hp"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);

    // Gold
    let gold = player
        .get("gold")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);

    // Seed
    let seed = obj
        .get("seed")
        .or_else(|| obj.get("seed_played"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Character
    let character = {
        let raw = player
            .get("character")
            .or_else(|| obj.get("character"))
            .and_then(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| v.get("id").and_then(|id| id.as_str()).map(|s| s.to_string()))
            })
            .unwrap_or_default();
        if raw.is_empty() {
            None
        } else {
            Some(normalize_id("CHARACTER.", &raw))
        }
    };

    // Ascension
    let ascension = obj
        .get("ascension_level")
        .or_else(|| obj.get("ascensionLevel"))
        .or_else(|| obj.get("ascension"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);

    // Game mode
    let game_mode = obj
        .get("game_mode")
        .or_else(|| obj.get("gameMode"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase());

    // Modifiers
    let modifiers: Vec<String> = obj
        .get("modifiers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.as_str()
                        .map(|s| normalize_id("MODIFIER.", s))
                        .or_else(|| {
                            m.get("id")
                                .and_then(|id| id.as_str())
                                .map(|s| normalize_id("MODIFIER.", s))
                        })
                })
                .collect()
        })
        .unwrap_or_default();

    // Deck
    let deck: Vec<String> = player
        .get("deck")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let id = c
                        .as_str()
                        .map(|s| s.to_string())
                        .or_else(|| c.get("id").and_then(|id| id.as_str()).map(|s| s.to_string()))?;
                    let stripped = normalize_id("CARD.", &id);
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
                .filter_map(|r| {
                    r.as_str()
                        .map(|s| normalize_id("RELIC.", s))
                        .or_else(|| {
                            r.get("id")
                                .and_then(|id| id.as_str())
                                .map(|s| normalize_id("RELIC.", s))
                        })
                })
                .collect()
        })
        .unwrap_or_default();

    // Potions — filter empty slots (same logic as macOS fix)
    let potions: Vec<String> = player
        .get("potions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let id = p
                        .as_str()
                        .map(|s| s.to_string())
                        .or_else(|| {
                            p.get("id")
                                .and_then(|id| id.as_str())
                                .map(|s| s.to_string())
                        })?;
                    let normalized = normalize_id("POTION.", &id);
                    if EMPTY_POTION_IDS.contains(&normalized.as_str()) {
                        None
                    } else {
                        Some(normalized)
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Room type
    let room = obj
        .get("room_type")
        .or_else(|| obj.get("roomType"))
        .and_then(|v| v.as_str());
    let map_point = obj
        .get("map_point_type")
        .or_else(|| obj.get("currentRoom"))
        .and_then(|v| v.as_str());
    let last_room_type = Some(live_room_type(room, map_point))
        .filter(|s| s != "unknown");

    Some(LiveRunSnapshot {
        in_progress,
        character,
        ascension,
        floor,
        act,
        current_hp,
        max_hp,
        gold,
        seed,
        game_mode,
        modifiers,
        deck,
        relics,
        potions,
        last_room_type,
        file_modified_at: modified_at,
        source_path,
    })
}
