// snapshot_delta.rs
// ─────────────────────────────────────────────────────────────────────────────
// Port of `SnapshotDelta.diff` from STS2LiveSaveReader.swift.
// Compares two LiveRunSnapshot values and returns a list of player-visible
// changes ("Took Streamline+", "Potion Used", "Floor 13", etc.).
// The Run Coach overlay displays these as inline tracker chips.
// ─────────────────────────────────────────────────────────────────────────────

use crate::save_reader::LiveRunSnapshot;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeltaKind {
    CardAdded,
    CardRemoved,
    CardUpgraded,
    RelicAdded,
    RelicLost,
    PotionAdded,
    PotionUsed,
    GoldGained,
    GoldSpent,
    HpHealed,
    HpLost,
    FloorAdvanced,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDelta {
    pub kind: DeltaKind,
    pub label: String,
    pub detail: Option<String>,
    pub floor: i32,
    pub observed_at: String,
}

fn bag(items: &[String]) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    for item in items {
        *map.entry(item.clone()).or_insert(0) += 1;
    }
    map
}

fn bag_diff(a: &HashMap<String, usize>, b: &HashMap<String, usize>) -> HashMap<String, usize> {
    let mut out = HashMap::new();
    for (k, &va) in a {
        let vb = b.get(k).copied().unwrap_or(0);
        if va > vb {
            out.insert(k.clone(), va - vb);
        }
    }
    out
}

fn pretty_name(id: &str) -> String {
    id.replace('+', " +")
        .split('_')
        .map(|word| {
            let mut c = word.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Strip the `+N` upgrade suffix to get the base card ID.
fn strip_upgrade(id: &str) -> &str {
    if let Some(plus_pos) = id.rfind('+') {
        // Only strip if what follows is a digit (or nothing, i.e. `+`).
        let after = &id[plus_pos + 1..];
        if after.is_empty() || after.chars().all(|c| c.is_ascii_digit()) {
            return &id[..plus_pos];
        }
    }
    id
}

/// Detect (added "X+1", removed "X+0") pairs → reclassify as upgrades.
fn extract_upgrades(
    added: &HashMap<String, usize>,
    removed: &HashMap<String, usize>,
) -> (
    HashMap<String, usize>,
    HashMap<String, usize>,
    HashMap<String, usize>,
) {
    let mut upgrades: HashMap<String, usize> = HashMap::new();
    let mut adds_left = added.clone();
    let mut removes_left = removed.clone();

    for (added_key, &added_count) in added {
        let base = strip_upgrade(added_key);
        // Find a removed entry whose base matches.
        let matching_removed: Vec<String> = removes_left
            .keys()
            .filter(|k| strip_upgrade(k) == base && k.as_str() != added_key.as_str())
            .cloned()
            .collect();

        for removed_key in matching_removed {
            let remove_count = *removes_left.get(&removed_key).unwrap_or(&0);
            let pairs = added_count.min(remove_count);
            if pairs == 0 {
                continue;
            }
            *upgrades.entry(added_key.clone()).or_insert(0) += pairs;
            let adds = adds_left.entry(added_key.clone()).or_insert(0);
            *adds = adds.saturating_sub(pairs);
            if *adds == 0 {
                adds_left.remove(added_key);
            }
            let rems = removes_left.entry(removed_key.clone()).or_insert(0);
            *rems = rems.saturating_sub(pairs);
            if *rems == 0 {
                removes_left.remove(&removed_key);
            }
        }
    }

    (upgrades, adds_left, removes_left)
}

/// Compare two snapshots and emit player-visible deltas.
/// Returns empty vec when no significant change occurred.
pub fn diff(previous: &LiveRunSnapshot, current: &LiveRunSnapshot) -> Vec<SnapshotDelta> {
    // Guard: same run only.
    if previous.character != current.character {
        return vec![];
    }
    if current.floor < previous.floor {
        return vec![];
    }

    let mut out: Vec<SnapshotDelta> = vec![];
    let now = chrono::Utc::now().to_rfc3339();
    let floor = current.floor;

    // ── Cards ──────────────────────────────────────────────────────────────
    let prev_bag = bag(&previous.deck);
    let curr_bag = bag(&current.deck);
    let added_raw = bag_diff(&curr_bag, &prev_bag);
    let removed_raw = bag_diff(&prev_bag, &curr_bag);
    let (upgrades, adds, removes) = extract_upgrades(&added_raw, &removed_raw);

    for (id, count) in &upgrades {
        for _ in 0..*count {
            out.push(SnapshotDelta {
                kind: DeltaKind::CardUpgraded,
                label: format!("{}+", pretty_name(strip_upgrade(id))),
                detail: Some("Upgraded".into()),
                floor,
                observed_at: now.clone(),
            });
        }
    }
    for (id, count) in &adds {
        for _ in 0..*count {
            out.push(SnapshotDelta {
                kind: DeltaKind::CardAdded,
                label: pretty_name(id),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        }
    }
    for (id, count) in &removes {
        for _ in 0..*count {
            out.push(SnapshotDelta {
                kind: DeltaKind::CardRemoved,
                label: pretty_name(id),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        }
    }

    // ── Relics ─────────────────────────────────────────────────────────────
    let prev_relic_bag = bag(&previous.relics);
    let curr_relic_bag = bag(&current.relics);
    for (id, count) in bag_diff(&curr_relic_bag, &prev_relic_bag) {
        for _ in 0..count {
            out.push(SnapshotDelta {
                kind: DeltaKind::RelicAdded,
                label: pretty_name(&id),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        }
    }
    for (id, count) in bag_diff(&prev_relic_bag, &curr_relic_bag) {
        for _ in 0..count {
            out.push(SnapshotDelta {
                kind: DeltaKind::RelicLost,
                label: pretty_name(&id),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        }
    }

    // ── Potions (bag semantics — slot order irrelevant) ───────────────────
    let prev_potion_bag = bag(&previous.potions);
    let curr_potion_bag = bag(&current.potions);
    for (id, count) in bag_diff(&curr_potion_bag, &prev_potion_bag) {
        for _ in 0..count {
            out.push(SnapshotDelta {
                kind: DeltaKind::PotionAdded,
                label: pretty_name(&id),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        }
    }
    for (id, count) in bag_diff(&prev_potion_bag, &curr_potion_bag) {
        for _ in 0..count {
            out.push(SnapshotDelta {
                kind: DeltaKind::PotionUsed,
                label: pretty_name(&id),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        }
    }

    // ── Gold (±50 threshold) ───────────────────────────────────────────────
    if let (Some(prev_gold), Some(curr_gold)) = (previous.gold, current.gold) {
        let delta = curr_gold - prev_gold;
        if delta >= 50 {
            out.push(SnapshotDelta {
                kind: DeltaKind::GoldGained,
                label: format!("+{}g", delta),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        } else if delta <= -50 {
            out.push(SnapshotDelta {
                kind: DeltaKind::GoldSpent,
                label: format!("{}g", delta),
                detail: None,
                floor,
                observed_at: now.clone(),
            });
        }
    }

    // ── HP (only when floor advanced — avoids in-combat spam) ─────────────
    if current.floor > previous.floor {
        if let (Some(prev_hp), Some(curr_hp)) = (previous.current_hp, current.current_hp) {
            let delta = curr_hp - prev_hp;
            if delta >= 8 {
                out.push(SnapshotDelta {
                    kind: DeltaKind::HpHealed,
                    label: format!("+{} HP", delta),
                    detail: None,
                    floor,
                    observed_at: now.clone(),
                });
            } else if delta <= -8 {
                out.push(SnapshotDelta {
                    kind: DeltaKind::HpLost,
                    label: format!("{} HP", delta),
                    detail: None,
                    floor,
                    observed_at: now.clone(),
                });
            }
        }
    }

    // ── Floor advance (only when nothing else surfaced) ───────────────────
    if current.floor > previous.floor && out.is_empty() {
        out.push(SnapshotDelta {
            kind: DeltaKind::FloorAdvanced,
            label: format!("Floor {}", current.floor),
            detail: previous.last_room_type.as_ref().map(|r| format!("from {}", r)),
            floor: current.floor,
            observed_at: now,
        });
    }

    out
}
