use super::*;
use crate::codex_paginated_ancestry::{self as ancestry, Chain, HistoryBase, RolloutClaim};

const THREAD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MID: &str = "11111111-2222-4333-8444-555555555555";
const OLD: &str = "99999999-8888-4777-8666-555555555555";

fn claim(id: &str, base: Option<(&str, u64, u64)>) -> RolloutClaim {
    RolloutClaim {
        rollout_id: id.into(),
        history_base: base.map(|(thread_id, ordinal, offset)| HistoryBase {
            thread_id: thread_id.into(),
            end_ordinal_exclusive: ordinal.to_string(),
            end_byte_offset: offset.to_string(),
        }),
    }
}

fn chain(links: Vec<RolloutClaim>) -> Chain {
    ancestry::link(links).expect("fixture chain must link")
}

fn path(id: &str) -> String {
    format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{id}.jsonl")
}

#[test]
fn plans_ancestors_before_the_selected_rollout() {
    let chain = chain(vec![
        claim(THREAD, Some((MID, 40, 4000))),
        claim(MID, Some((OLD, 20, 2000))),
        claim(OLD, None),
    ]);
    let paths = [path(THREAD), path(MID), path(OLD)];
    let locators: Vec<_> = [THREAD, MID, OLD]
        .iter()
        .zip(&paths)
        .map(|(id, p)| Locator {
            rollout_id: id,
            rollout_path: p,
        })
        .collect();

    let plan = plan(THREAD, THREAD, &chain, &locators).unwrap();
    // Oldest first, so inherited records arrive in their original order.
    assert_eq!(
        plan.sources
            .iter()
            .map(|source| source.rollout_id.as_str())
            .collect::<Vec<_>>(),
        [OLD, MID, THREAD]
    );
    // A cut describes how much of THAT source a descendant used. OLD is used
    // up to 20 (named by MID), MID up to 40 (named by THREAD), and the newest
    // rollout contributes through its end.
    assert_eq!(plan.sources[0].end_ordinal_exclusive.as_deref(), Some("20"));
    assert_eq!(plan.sources[0].end_byte_offset.as_deref(), Some("2000"));
    assert_eq!(plan.sources[1].end_ordinal_exclusive.as_deref(), Some("40"));
    assert_eq!(plan.sources[1].end_byte_offset.as_deref(), Some("4000"));
    assert_eq!(plan.sources[2].end_ordinal_exclusive, None);
    assert_eq!(plan.sources[2].end_byte_offset, None);
    assert!(plan.reached_root);
    assert_eq!(plan.chain_byte_budget, CHAIN_BYTES);
    assert!(!plan.source_authenticated);
    assert!(!plan.history_complete);
}

#[test]
fn a_reverted_thread_keeps_its_stable_id_while_the_head_file_differs() {
    // After a revert the newest rollout has its own UUID, but the caller still
    // selects the stable thread and its locator is named for that thread.
    let physical = "0f0f0f0f-1e1e-4d4d-8c8c-3b3b3b3b3b3b";
    let chain = chain(vec![
        claim(physical, Some((OLD, 10, 1000))),
        claim(OLD, None),
    ]);
    let head_path =
        format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{THREAD}_{physical}.jsonl");
    let old_path = path(OLD);
    let locators = vec![
        Locator {
            rollout_id: physical,
            rollout_path: &head_path,
        },
        Locator {
            rollout_id: OLD,
            rollout_path: &old_path,
        },
    ];
    let plan = plan(THREAD, physical, &chain, &locators).unwrap();
    assert_eq!(plan.thread_id, THREAD);
    assert_eq!(plan.sources.last().unwrap().rollout_id, physical);
}

#[test]
fn archived_and_compressed_layouts_are_reported_without_rewriting_the_locator() {
    let chain = chain(vec![claim(THREAD, Some((OLD, 10, 1000))), claim(OLD, None)]);
    let head_path = path(THREAD);
    let archived = format!("archived_sessions/rollout-2026-01-05T12-00-00-{OLD}.jsonl.zst");
    let locators = vec![
        Locator {
            rollout_id: THREAD,
            rollout_path: &head_path,
        },
        Locator {
            rollout_id: OLD,
            rollout_path: &archived,
        },
    ];
    let plan = plan(THREAD, THREAD, &chain, &locators).unwrap();
    let ancestor = &plan.sources[0];
    assert_eq!(ancestor.rollout_path, archived);
    assert!(ancestor.compressed);
    assert!(ancestor.archived);
    assert!(!plan.sources[1].compressed);
    assert!(!plan.sources[1].archived);
}

#[test]
fn overlapping_inheritance_is_refused() {
    // A deeper ancestor must be cut strictly earlier. Equal or later cuts
    // would claim the same records twice.
    for (deeper_cut, label) in [(40_u64, "equal"), (60, "later")] {
        let chain = chain(vec![
            claim(THREAD, Some((MID, 40, 4000))),
            claim(MID, Some((OLD, deeper_cut, 6000))),
            claim(OLD, None),
        ]);
        let paths = [path(THREAD), path(MID), path(OLD)];
        let locators: Vec<_> = [THREAD, MID, OLD]
            .iter()
            .zip(&paths)
            .map(|(id, p)| Locator {
                rollout_id: id,
                rollout_path: p,
            })
            .collect();
        assert_eq!(
            plan(THREAD, THREAD, &chain, &locators),
            Err(Error::NonMonotonicCutoff),
            "{label} cut must be refused"
        );
    }
}

#[test]
fn a_locator_for_the_wrong_rollout_is_refused() {
    let chain = chain(vec![claim(THREAD, Some((OLD, 10, 1000))), claim(OLD, None)]);
    let head_path = path(THREAD);
    let wrong = path(MID);
    let locators = vec![
        Locator {
            rollout_id: THREAD,
            rollout_path: &head_path,
        },
        // Names the right link but points at a file for a different rollout.
        Locator {
            rollout_id: OLD,
            rollout_path: &wrong,
        },
    ];
    assert_eq!(
        plan(THREAD, THREAD, &chain, &locators),
        Err(Error::LocatorMismatch)
    );
}

#[test]
fn a_malformed_or_escaping_locator_is_refused() {
    let chain = chain(vec![claim(THREAD, None)]);
    for candidate in [
        "../outside/rollout-2026-01-05T12-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
        "/absolute/rollout-2026-01-05T12-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
        "sessions/2026/01/06/rollout-2026-01-05T12-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
        "sessions/2026/01/05/rollout-2026-13-05T12-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
        "sessions/2026/01/05/notes.txt",
    ] {
        let locators = vec![Locator {
            rollout_id: THREAD,
            rollout_path: candidate,
        }];
        assert_eq!(
            plan(THREAD, THREAD, &chain, &locators),
            Err(Error::LocatorMismatch),
            "must refuse: {candidate}"
        );
    }
}

#[test]
fn the_same_file_cannot_appear_twice_in_one_chain() {
    // A reverted head is named for the stable thread but has its own rollout
    // ID, so a malicious or corrupted chain could name that one file twice
    // while still passing every per-link name check.
    let physical = "0f0f0f0f-1e1e-4d4d-8c8c-3b3b3b3b3b3b";
    let head_path =
        format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{THREAD}_{physical}.jsonl");
    let chain = chain(vec![
        claim(physical, Some((THREAD, 20, 2000))),
        claim(THREAD, None),
    ]);
    let locators = vec![
        Locator {
            rollout_id: physical,
            rollout_path: &head_path,
        },
        // Valid for THREAD on its own, yet the very same stored file.
        Locator {
            rollout_id: THREAD,
            rollout_path: &head_path,
        },
    ];
    assert_eq!(
        plan(THREAD, physical, &chain, &locators),
        Err(Error::DuplicateLocator)
    );
}

#[test]
fn a_head_that_is_not_the_selected_rollout_is_refused() {
    let chain = chain(vec![claim(MID, None)]);
    let mid_path = path(MID);
    let locators = vec![Locator {
        rollout_id: MID,
        rollout_path: &mid_path,
    }];
    assert_eq!(
        plan(THREAD, THREAD, &chain, &locators),
        Err(Error::SelectedMismatch)
    );
}

#[test]
fn a_missing_locator_or_empty_chain_is_refused() {
    let chain = chain(vec![claim(THREAD, Some((OLD, 10, 1000))), claim(OLD, None)]);
    let head_path = path(THREAD);
    let locators = vec![Locator {
        rollout_id: THREAD,
        rollout_path: &head_path,
    }];
    assert_eq!(
        plan(THREAD, THREAD, &chain, &locators),
        Err(Error::IncompleteChain)
    );
}

#[test]
fn chain_bytes_are_accounted_and_capped() {
    let half = CHAIN_BYTES / 2;
    let consumed = accumulate(0, half).unwrap();
    assert_eq!(consumed, half);
    assert_eq!(accumulate(consumed, half).unwrap(), CHAIN_BYTES);
    // One byte past the whole-chain allowance stops resolution.
    assert_eq!(accumulate(CHAIN_BYTES, 1), Err(Error::ChainBytesExceeded));
    assert_eq!(accumulate(u64::MAX, 1), Err(Error::ChainBytesExceeded));
}
