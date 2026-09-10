use super::*;
use crate::codex_paginated_ancestry::{self as ancestry, HistoryBase, RolloutClaim};
use crate::codex_paginated_chain::{CHAIN_BYTES, Locator};

const THREAD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
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

fn path(id: &str) -> String {
    format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{id}.jsonl")
}

/// A two-link chain: THREAD inherits OLD up to ordinal 6 / byte 1042.
fn two_link_plan() -> Plan {
    let chain = ancestry::link(vec![claim(THREAD, Some((OLD, 6, 1042))), claim(OLD, None)])
        .expect("fixture chain");
    let head = path(THREAD);
    let old = path(OLD);
    let locators = vec![
        Locator {
            rollout_id: THREAD,
            rollout_path: &head,
        },
        Locator {
            rollout_id: OLD,
            rollout_path: &old,
        },
    ];
    chain_plan::plan(THREAD, THREAD, &chain, &locators).expect("fixture plan")
}

fn observed(id: &str, decoded: u64, records: u32, stored: u64) -> Observed {
    Observed {
        rollout_id: id.into(),
        decoded_bytes: decoded,
        record_count: records,
        stored_bytes: stored,
    }
}

#[test]
fn records_each_source_and_totals_stored_bytes() {
    let plan = two_link_plan();
    let resolution = resolve(
        &plan,
        &[
            observed(OLD, 4000, 12, 4000),
            observed(THREAD, 9000, 30, 9000),
        ],
    )
    .unwrap();

    assert_eq!(resolution.profile, PROFILE);
    assert_eq!(resolution.thread_id, THREAD);
    assert_eq!(
        resolution
            .sources
            .iter()
            .map(|source| source.rollout_id.as_str())
            .collect::<Vec<_>>(),
        [OLD, THREAD]
    );
    // The cut belongs to the ancestor that is inherited from.
    assert_eq!(
        resolution.sources[0].end_ordinal_exclusive.as_deref(),
        Some("6")
    );
    assert_eq!(resolution.sources[1].end_ordinal_exclusive, None);
    assert_eq!(resolution.sources[0].record_count, 12);
    assert_eq!(resolution.chain_stored_bytes, "13000");
    assert!(resolution.reached_root);
    assert!(!resolution.source_authenticated);
    // Following every pointer never proves the durable history is complete.
    assert!(!resolution.history_complete);
}

#[test]
fn a_compressed_ancestor_is_budgeted_by_stored_bytes_but_cut_by_decoded_size() {
    let chain = ancestry::link(vec![claim(THREAD, Some((OLD, 6, 1042))), claim(OLD, None)])
        .expect("fixture chain");
    let head = path(THREAD);
    let archived = format!("archived_sessions/rollout-2026-01-05T12-00-00-{OLD}.jsonl.zst");
    let locators = vec![
        Locator {
            rollout_id: THREAD,
            rollout_path: &head,
        },
        Locator {
            rollout_id: OLD,
            rollout_path: &archived,
        },
    ];
    let plan = chain_plan::plan(THREAD, THREAD, &chain, &locators).unwrap();
    let resolution = resolve(
        &plan,
        &[
            // Decoded 4000 bytes comfortably contains byte offset 1042, while
            // only 900 compressed bytes were actually read from storage.
            observed(OLD, 4000, 12, 900),
            observed(THREAD, 9000, 30, 9000),
        ],
    )
    .unwrap();
    assert!(resolution.sources[0].compressed);
    assert!(resolution.sources[0].archived);
    assert_eq!(resolution.sources[0].decoded_bytes, "4000");
    assert_eq!(resolution.sources[0].stored_bytes, "900");
    assert_eq!(resolution.chain_stored_bytes, "9900");
}

#[test]
fn a_cut_beyond_the_source_it_names_is_refused() {
    let plan = two_link_plan();
    // Byte offset 1042 cannot lie inside a 500-byte ancestor.
    assert_eq!(
        resolve(
            &plan,
            &[
                observed(OLD, 500, 12, 500),
                observed(THREAD, 9000, 30, 9000)
            ]
        ),
        Err(Error::CutoffOutsideSource)
    );
    // Ordinal 6 cannot lie inside an ancestor holding 3 records.
    assert_eq!(
        resolve(
            &plan,
            &[
                observed(OLD, 4000, 3, 4000),
                observed(THREAD, 9000, 30, 9000)
            ]
        ),
        Err(Error::CutoffOutsideSource)
    );
}

#[test]
fn an_empty_inherited_source_cannot_satisfy_a_cut() {
    let plan = two_link_plan();
    assert_eq!(
        resolve(
            &plan,
            &[observed(OLD, 0, 0, 0), observed(THREAD, 9000, 30, 9000)]
        ),
        Err(Error::EmptySource)
    );
}

#[test]
fn observations_out_of_plan_order_or_for_another_rollout_are_refused() {
    let plan = two_link_plan();
    assert_eq!(
        resolve(
            &plan,
            &[
                observed(THREAD, 9000, 30, 9000),
                observed(OLD, 4000, 12, 4000)
            ]
        ),
        Err(Error::PlanMismatch)
    );
    assert_eq!(
        resolve(
            &plan,
            &[
                observed("00000000-0000-4000-8000-000000000000", 4000, 12, 4000),
                observed(THREAD, 9000, 30, 9000),
            ]
        ),
        Err(Error::PlanMismatch)
    );
}

#[test]
fn a_missing_or_extra_observation_is_refused() {
    let plan = two_link_plan();
    assert_eq!(
        resolve(&plan, &[observed(OLD, 4000, 12, 4000)]),
        Err(Error::IncompleteResolution)
    );
    assert_eq!(
        resolve(
            &plan,
            &[
                observed(OLD, 4000, 12, 4000),
                observed(THREAD, 9000, 30, 9000),
                observed(THREAD, 1, 1, 1),
            ]
        ),
        Err(Error::IncompleteResolution)
    );
}

#[test]
fn the_whole_chain_cannot_exceed_one_admission_budget() {
    let plan = two_link_plan();
    // Each source alone is within the single-source limit, yet together they
    // would read more than one admission is allowed to.
    assert_eq!(
        resolve(
            &plan,
            &[
                observed(OLD, 4000, 12, CHAIN_BYTES),
                observed(THREAD, 9000, 30, 1),
            ]
        ),
        Err(Error::ChainBytesExceeded)
    );
}
