//! Composition boundary for one selected paginated thread.
//!
//! The ancestry resolver and the projection checkpoint reader deliberately
//! produce observations only.  This module is the next, still non-publishable
//! boundary: it ties the state-database selected row to the newest physical
//! rollout, checks every oldest-to-head source against durable complete-LF
//! evidence, and then checks the projection cursor against the durable head
//! prefix.  It does not open files or databases and it never grants source
//! authority.
//!
//! `DurableEvidence` is expected to be produced by the existing held-FD
//! rollout scanner.  Its complete-LF offset is compared with the decoded
//! source length, so an observed partial tail is rejected as inconsistent.
//! Keeping the observation as offsets and ordinals (rather than a
//! caller-supplied authority/completeness flag) lets this pure assembly step
//! reject shape mismatches without claiming that caller-provided bytes have
//! source provenance or an atomic snapshot.

use crate::codex_paginated_ancestry::MAX_DEPTH;
use crate::codex_paginated_chain::{self as chain_plan, Plan};
use crate::codex_paginated_resolution::Resolution;
use crate::sqlite_metadata::CatalogEntry;
use crate::sqlite_paginated::Observation as ProjectionObservation;
use serde::Serialize;

pub const PROFILE: &str = "codex_paginated_consistency_v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    EmptyPlan,
    PlanTooDeep,
    InvalidSelectedState,
    PlanResolutionMismatch,
    ResolutionUnverified,
    MissingDurableEvidence,
    DurableEvidenceMismatch,
    DuplicateSource,
    PartialTail,
    CutoffOutsideDurablePrefix,
    ProjectionMissing,
    ProjectionThreadMismatch,
    ProjectionLagging,
    ProjectionOutOfRange,
    ProjectionMismatch,
    OrdinalStartUnverified,
    InvalidNumber,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::EmptyPlan => "paginated_consistency_empty_plan",
            Self::PlanTooDeep => "paginated_consistency_plan_too_deep",
            Self::InvalidSelectedState => "paginated_consistency_selected_state_mismatch",
            Self::PlanResolutionMismatch => "paginated_consistency_plan_resolution_mismatch",
            Self::ResolutionUnverified => "paginated_consistency_resolution_unverified",
            Self::MissingDurableEvidence => "paginated_consistency_missing_durable_evidence",
            Self::DurableEvidenceMismatch => "paginated_consistency_durable_evidence_mismatch",
            Self::DuplicateSource => "paginated_consistency_duplicate_source",
            Self::PartialTail => "paginated_consistency_partial_tail",
            Self::CutoffOutsideDurablePrefix => {
                "paginated_consistency_cutoff_outside_durable_prefix"
            }
            Self::ProjectionMissing => "paginated_consistency_projection_missing",
            Self::ProjectionThreadMismatch => "paginated_consistency_projection_thread_mismatch",
            Self::ProjectionLagging => "paginated_consistency_projection_lagging",
            Self::ProjectionOutOfRange => "paginated_consistency_projection_out_of_range",
            Self::ProjectionMismatch => "paginated_consistency_projection_mismatch",
            Self::OrdinalStartUnverified => "paginated_consistency_ordinal_start_unverified",
            Self::InvalidNumber => "paginated_consistency_invalid_number",
        }
    }
}

/// Evidence for one decoded rollout as observed by the existing source
/// scanner.  Offsets are decoded-byte offsets, including the terminating LF.
/// `next_ordinal_exclusive` is the ordinal immediately after the complete LF
/// prefix, not a local record count.  All integers remain strings at this
/// boundary so a JS caller cannot lose precision.  A complete source must
/// have `complete_lf_end_byte_offset == decoded_bytes`; a smaller value is a
/// partial tail and a larger value is inconsistent evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableEvidence {
    pub rollout_id: String,
    pub decoded_bytes: String,
    pub complete_lf_end_byte_offset: String,
    pub next_ordinal_exclusive: String,
}

/// A bounded result of composing state, projection, resolution and durable
/// source evidence.  It is intentionally an observation rather than a grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Consistency {
    pub profile: &'static str,
    pub thread_id: String,
    pub selected_rollout_id: String,
    pub projection_thread_id: String,
    pub projection_next_rollout_byte_offset: String,
    pub projection_next_rollout_ordinal: String,
    pub durable_sources: Vec<DurableEvidence>,
    pub source_authenticated: bool,
    pub publishable: bool,
    pub history_complete: bool,
}

fn number(value: &str) -> Result<u64, Error> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(Error::InvalidNumber);
    }
    let parsed = value.parse::<u64>().map_err(|_| Error::InvalidNumber)?;
    (parsed.to_string() == value)
        .then_some(parsed)
        .ok_or(Error::InvalidNumber)
}

fn check_plan_resolution(plan: &Plan, resolution: &Resolution) -> Result<(), Error> {
    if plan.sources.is_empty() || resolution.sources.is_empty() {
        return Err(Error::EmptyPlan);
    }
    if plan.sources.len() > MAX_DEPTH || resolution.sources.len() > MAX_DEPTH {
        return Err(Error::PlanTooDeep);
    }
    if plan.thread_id != resolution.thread_id
        || plan.sources.len() != resolution.sources.len()
        || plan.profile != chain_plan::PROFILE
        || resolution.profile != crate::codex_paginated_resolution::PROFILE
        || plan.chain_byte_budget != chain_plan::CHAIN_BYTES
        || plan.chain_decoded_byte_budget != chain_plan::CHAIN_DECODED_BYTES
        || plan.reached_root != resolution.reached_root
        || plan.source_authenticated
        || plan.history_complete
        || resolution.source_authenticated
        || resolution.history_complete
        || !resolution.ordinal_cutoffs_verified
    {
        return Err(if !resolution.ordinal_cutoffs_verified {
            Error::ResolutionUnverified
        } else {
            Error::PlanResolutionMismatch
        });
    }
    if !plan.reached_root {
        // The metadata ordinal of the first source is not available in a
        // truncated ancestry plan. Do not call a caller-supplied next ordinal
        // a verified global value in that case.
        return Err(Error::OrdinalStartUnverified);
    }
    let mut seen_rollouts = std::collections::BTreeSet::new();
    let mut seen_paths = std::collections::BTreeSet::new();
    let mut stored_sum = 0_u64;
    let mut decoded_sum = 0_u64;
    let mut previous_cutoff = None;
    for (index, (planned, resolved)) in plan.sources.iter().zip(&resolution.sources).enumerate() {
        if planned.rollout_id != resolved.rollout_id
            || planned.rollout_path != resolved.rollout_path
            || planned.end_ordinal_exclusive != resolved.end_ordinal_exclusive
            || planned.end_byte_offset != resolved.end_byte_offset
            || planned.compressed != planned.rollout_path.ends_with(".zst")
            || planned.archived != planned.rollout_path.starts_with("archived_sessions/")
            || planned.compressed != resolved.compressed
            || planned.archived != resolved.archived
            || !crate::codex_locator::session_id(&planned.rollout_id)
        {
            return Err(Error::PlanResolutionMismatch);
        }
        if !seen_rollouts.insert(planned.rollout_id.clone())
            || !seen_paths.insert(planned.rollout_path.clone())
        {
            return Err(Error::DuplicateSource);
        }
        let source_thread = if index + 1 == plan.sources.len() {
            plan.thread_id.clone()
        } else {
            crate::codex_locator::stable_thread_id(&planned.rollout_path)
                .ok_or(Error::PlanResolutionMismatch)?
        };
        if crate::codex_locator::physical_rollout_id(&planned.rollout_path, &source_thread)
            .as_deref()
            != Some(planned.rollout_id.as_str())
        {
            return Err(Error::PlanResolutionMismatch);
        }
        if planned.end_ordinal_exclusive.is_some() != planned.end_byte_offset.is_some()
            || (index + 1 != plan.sources.len() && planned.end_ordinal_exclusive.is_none())
            || (index + 1 == plan.sources.len() && planned.end_ordinal_exclusive.is_some())
        {
            return Err(Error::PlanResolutionMismatch);
        }
        // Parse all resolution numbers before comparing source evidence.  A
        // malformed string must never be interpreted as a missing bound.
        let decoded_bytes = number(&resolved.decoded_bytes)?;
        decoded_sum = decoded_sum
            .checked_add(decoded_bytes)
            .ok_or(Error::PlanResolutionMismatch)?;
        let stored_bytes = number(&resolved.stored_bytes)?;
        if stored_bytes == 0 || resolved.record_count == 0 {
            return Err(Error::PlanResolutionMismatch);
        }
        stored_sum = stored_sum
            .checked_add(stored_bytes)
            .ok_or(Error::PlanResolutionMismatch)?;
        if let Some(offset) = resolved.end_byte_offset.as_deref() {
            number(offset)?;
        }
        if let Some(ordinal) = resolved.end_ordinal_exclusive.as_deref() {
            let cutoff = number(ordinal)?;
            if previous_cutoff.is_some_and(|previous| cutoff <= previous) {
                return Err(Error::PlanResolutionMismatch);
            }
            previous_cutoff = Some(cutoff);
        }
    }
    let chain_stored = number(&resolution.chain_stored_bytes)?;
    let chain_decoded = number(&resolution.chain_decoded_bytes)?;
    if chain_stored != stored_sum
        || chain_decoded != decoded_sum
        || chain_stored > plan.chain_byte_budget
        || chain_decoded > plan.chain_decoded_byte_budget
    {
        return Err(Error::PlanResolutionMismatch);
    }
    Ok(())
}

fn check_selected_state(
    selected: &CatalogEntry,
    plan: &Plan,
    resolution: &Resolution,
) -> Result<String, Error> {
    if selected.history_mode != "paginated"
        || !crate::codex_locator::session_id(&selected.id)
        || selected.id != plan.thread_id
        || selected.id != resolution.thread_id
    {
        return Err(Error::InvalidSelectedState);
    }
    let head = plan.sources.last().ok_or(Error::EmptyPlan)?;
    if selected.rollout_path != head.rollout_path {
        return Err(Error::InvalidSelectedState);
    }
    let physical = crate::codex_locator::physical_rollout_id(&selected.rollout_path, &selected.id)
        .ok_or(Error::InvalidSelectedState)?;
    if physical != head.rollout_id {
        return Err(Error::InvalidSelectedState);
    }
    Ok(physical)
}

fn check_durable_sources(
    plan: &Plan,
    resolution: &Resolution,
    evidence: &[DurableEvidence],
) -> Result<(), Error> {
    if evidence.len() != resolution.sources.len() {
        return Err(Error::MissingDurableEvidence);
    }
    for (index, (resolved, durable)) in resolution.sources.iter().zip(evidence).enumerate() {
        if durable.rollout_id != resolved.rollout_id
            || durable.decoded_bytes != resolved.decoded_bytes
        {
            return Err(Error::DurableEvidenceMismatch);
        }
        let decoded = number(&durable.decoded_bytes)?;
        let complete_offset = number(&durable.complete_lf_end_byte_offset)?;
        let next_ordinal = number(&durable.next_ordinal_exclusive)?;
        if decoded == 0 || complete_offset > decoded || next_ordinal == 0 {
            return Err(Error::DurableEvidenceMismatch);
        }
        if complete_offset < decoded {
            return Err(Error::PartialTail);
        }
        let metadata_ordinal = if index == 0 {
            0
        } else {
            number(
                plan.sources[index - 1]
                    .end_ordinal_exclusive
                    .as_deref()
                    .ok_or(Error::OrdinalStartUnverified)?,
            )?
        };
        let expected_next = metadata_ordinal
            .checked_add(u64::from(resolved.record_count))
            .ok_or(Error::DurableEvidenceMismatch)?;
        if expected_next != next_ordinal {
            return Err(Error::DurableEvidenceMismatch);
        }
        if let (Some(ordinal), Some(offset)) = (
            resolved.end_ordinal_exclusive.as_deref(),
            resolved.end_byte_offset.as_deref(),
        ) && {
            let cutoff_ordinal = number(ordinal)?;
            cutoff_ordinal <= metadata_ordinal
                || cutoff_ordinal > next_ordinal
                || number(offset)? > complete_offset
        } {
            return Err(Error::CutoffOutsideDurablePrefix);
        }
    }
    Ok(())
}

/// Compose one selected state row, the already-resolved oldest-to-head chain,
/// one selected physical head projection checkpoint, and per-source durable
/// complete-LF evidence.
///
/// The projection cursor must equal the durable complete prefix of the head.
/// A smaller cursor is a lagging projection; a larger cursor is outside the
/// durable prefix.  Both are rejected rather than being published as a
/// partial or empty history.
pub fn assemble(
    selected: &CatalogEntry,
    plan: &Plan,
    resolution: &Resolution,
    projection: &ProjectionObservation,
    evidence: &[DurableEvidence],
) -> Result<Consistency, Error> {
    check_plan_resolution(plan, resolution)?;
    let head_id = check_selected_state(selected, plan, resolution)?;
    check_durable_sources(plan, resolution, evidence)?;

    if projection.kind != "codex_paginated_projection_checkpoint"
        || projection.native_version != crate::sqlite_metadata::NATIVE_VERSION
        || !projection.connection_closed
        || projection.source_authenticated
        || projection.publishable
        || projection.history_complete
    {
        return Err(Error::ProjectionMismatch);
    }

    let checkpoint = projection
        .checkpoint
        .as_ref()
        .ok_or(Error::ProjectionMissing)?;
    if projection.thread_id != head_id {
        return Err(Error::ProjectionThreadMismatch);
    }
    let head_evidence = evidence.last().ok_or(Error::MissingDurableEvidence)?;
    let projection_offset = number(&checkpoint.next_rollout_byte_offset)?;
    let projection_ordinal = number(&checkpoint.next_rollout_ordinal)?;
    let durable_offset = number(&head_evidence.complete_lf_end_byte_offset)?;
    let durable_ordinal = number(&head_evidence.next_ordinal_exclusive)?;
    match (
        projection_offset.cmp(&durable_offset),
        projection_ordinal.cmp(&durable_ordinal),
    ) {
        (std::cmp::Ordering::Equal, std::cmp::Ordering::Equal) => {}
        (std::cmp::Ordering::Less, std::cmp::Ordering::Less)
        | (std::cmp::Ordering::Equal, std::cmp::Ordering::Less)
        | (std::cmp::Ordering::Less, std::cmp::Ordering::Equal) => {
            return Err(Error::ProjectionLagging);
        }
        (std::cmp::Ordering::Greater, std::cmp::Ordering::Greater)
        | (std::cmp::Ordering::Equal, std::cmp::Ordering::Greater)
        | (std::cmp::Ordering::Greater, std::cmp::Ordering::Equal) => {
            return Err(Error::ProjectionOutOfRange);
        }
        _ => return Err(Error::ProjectionMismatch),
    }

    Ok(Consistency {
        profile: PROFILE,
        thread_id: plan.thread_id.clone(),
        selected_rollout_id: head_id,
        projection_thread_id: projection.thread_id.clone(),
        projection_next_rollout_byte_offset: checkpoint.next_rollout_byte_offset.clone(),
        projection_next_rollout_ordinal: checkpoint.next_rollout_ordinal.clone(),
        durable_sources: evidence.to_vec(),
        source_authenticated: false,
        publishable: false,
        history_complete: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_paginated_ancestry::{self as ancestry, HistoryBase, RolloutClaim};
    use crate::codex_paginated_chain::{self as chain, Locator};
    use crate::codex_paginated_resolution::{self as resolution, Observed};
    use crate::sqlite_metadata::NATIVE_VERSION;
    use crate::sqlite_paginated::{Checkpoint, Observation};

    const THREAD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const MID: &str = "11111111-2222-4333-8444-555555555555";
    const OLD: &str = "99999999-8888-4777-8666-555555555555";

    fn path(id: &str) -> String {
        format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{id}.jsonl")
    }

    fn plan() -> Plan {
        let claims = vec![
            RolloutClaim {
                rollout_id: THREAD.into(),
                history_base: Some(HistoryBase {
                    thread_id: MID.into(),
                    end_ordinal_exclusive: "40".into(),
                    end_byte_offset: "400".into(),
                }),
            },
            RolloutClaim {
                rollout_id: MID.into(),
                history_base: Some(HistoryBase {
                    thread_id: OLD.into(),
                    end_ordinal_exclusive: "20".into(),
                    end_byte_offset: "200".into(),
                }),
            },
            RolloutClaim {
                rollout_id: OLD.into(),
                history_base: None,
            },
        ];
        let chain = ancestry::link(claims).expect("chain");
        let paths = [path(THREAD), path(MID), path(OLD)];
        let locators: Vec<_> = [THREAD, MID, OLD]
            .iter()
            .zip(&paths)
            .map(|(rollout_id, rollout_path)| Locator {
                rollout_id,
                rollout_path,
            })
            .collect();
        chain::plan(THREAD, THREAD, &chain, &locators).expect("plan")
    }

    fn resolution(plan: &Plan) -> Resolution {
        let observations = plan
            .sources
            .iter()
            .map(|source| Observed {
                rollout_id: source.rollout_id.clone(),
                decoded_bytes: 1_000,
                record_count: if source.rollout_id == THREAD { 40 } else { 20 },
                stored_bytes: 1_000,
                ordinal_cutoff_verified: source.end_ordinal_exclusive.is_some(),
            })
            .collect::<Vec<_>>();
        resolution::resolve(plan, &observations).expect("resolution")
    }

    fn selected() -> CatalogEntry {
        CatalogEntry {
            id: THREAD.into(),
            rollout_path: path(THREAD),
            source: "owned".into(),
            history_mode: "paginated".into(),
            archived: false,
            created_at: "1".into(),
            updated_at: "1".into(),
            created_at_ms: None,
            updated_at_ms: None,
        }
    }

    fn projection(thread_id: &str, ordinal: &str, offset: &str) -> Observation {
        Observation {
            kind: "codex_paginated_projection_checkpoint",
            native_version: NATIVE_VERSION,
            sqlite_version: crate::sqlite_metadata::SQLITE_VERSION,
            scope: "test",
            thread_id: thread_id.into(),
            checkpoint: Some(Checkpoint {
                next_rollout_byte_offset: offset.into(),
                next_rollout_ordinal: ordinal.into(),
            }),
            turns: Vec::new(),
            item_count: "0".into(),
            max_item_ordinal: None,
            source_authenticated: false,
            publishable: false,
            history_complete: false,
            connection_closed: true,
        }
    }

    fn evidence(plan: &Plan) -> Vec<DurableEvidence> {
        plan.sources
            .iter()
            .map(|source| DurableEvidence {
                rollout_id: source.rollout_id.clone(),
                decoded_bytes: "1000".into(),
                complete_lf_end_byte_offset: "1000".into(),
                next_ordinal_exclusive: if source.rollout_id == OLD {
                    "20".into()
                } else if source.rollout_id == MID {
                    "40".into()
                } else {
                    "80".into()
                },
            })
            .collect()
    }

    #[test]
    fn composes_selected_state_all_sources_and_head_projection() {
        let plan = plan();
        let resolution = resolution(&plan);
        let evidence = evidence(&plan);
        let result = assemble(
            &selected(),
            &plan,
            &resolution,
            &projection(THREAD, "80", "1000"),
            &evidence,
        )
        .expect("consistent");
        assert_eq!(result.profile, PROFILE);
        assert_eq!(result.selected_rollout_id, THREAD);
        assert!(!result.source_authenticated);
        assert!(!result.publishable);
        assert!(!result.history_complete);
        assert_eq!(result.durable_sources.len(), 3);
    }

    #[test]
    fn selected_row_must_match_stable_thread_and_head_locator() {
        let plan = plan();
        let resolution = resolution(&plan);
        let evidence = evidence(&plan);
        let mut row = selected();
        row.id = MID.into();
        assert_eq!(
            assemble(
                &row,
                &plan,
                &resolution,
                &projection(THREAD, "80", "1000"),
                &evidence,
            ),
            Err(Error::InvalidSelectedState)
        );
    }

    #[test]
    fn lagging_and_out_of_range_projection_are_distinct() {
        let plan = plan();
        let resolution = resolution(&plan);
        let evidence = evidence(&plan);
        for (ordinal, offset, expected) in [
            ("79", "999", Error::ProjectionLagging),
            ("81", "1000", Error::ProjectionOutOfRange),
            ("80", "1001", Error::ProjectionOutOfRange),
        ] {
            assert_eq!(
                assemble(
                    &selected(),
                    &plan,
                    &resolution,
                    &projection(THREAD, ordinal, offset),
                    &evidence,
                ),
                Err(expected)
            );
        }
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(THREAD, "79", "1001"),
                &evidence,
            ),
            Err(Error::ProjectionMismatch)
        );
    }

    #[test]
    fn partial_tail_and_bad_ordinal_evidence_are_rejected() {
        let plan = plan();
        let resolution = resolution(&plan);
        let mut durable = evidence(&plan);
        durable[1].complete_lf_end_byte_offset = "999".into();
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(THREAD, "80", "1000"),
                &durable,
            ),
            Err(Error::PartialTail)
        );
        let mut durable = evidence(&plan);
        durable[0].next_ordinal_exclusive = "19".into();
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(THREAD, "80", "1000"),
                &durable,
            ),
            Err(Error::DurableEvidenceMismatch)
        );
    }

    #[test]
    fn a_cutoff_past_the_complete_lf_prefix_is_rejected() {
        let mut plan = plan();
        let mut resolution = resolution(&plan);
        plan.sources[0].end_byte_offset = Some("1001".into());
        resolution.sources[0].end_byte_offset = Some("1001".into());
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(THREAD, "80", "1000"),
                &evidence(&plan),
            ),
            Err(Error::CutoffOutsideDurablePrefix)
        );
    }

    #[test]
    fn missing_checkpoint_or_evidence_never_means_empty_history() {
        let plan = plan();
        let resolution = resolution(&plan);
        let mut checkpoint_observation = projection(THREAD, "80", "1000");
        checkpoint_observation.checkpoint = None;
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &checkpoint_observation,
                &evidence(&plan)
            ),
            Err(Error::ProjectionMissing)
        );
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(THREAD, "80", "1000"),
                &[]
            ),
            Err(Error::MissingDurableEvidence)
        );
    }

    #[test]
    fn physical_projection_key_is_checked_after_revert() {
        let plan = plan();
        let resolution = resolution(&plan);
        let evidence = evidence(&plan);
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(MID, "80", "1000"),
                &evidence,
            ),
            Err(Error::ProjectionThreadMismatch)
        );
    }

    #[test]
    fn canonical_numbers_and_zero_extent_are_required() {
        let plan = plan();
        let resolution = resolution(&plan);
        let evidence = evidence(&plan);
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(THREAD, "080", "1000"),
                &evidence,
            ),
            Err(Error::InvalidNumber)
        );
        let mut resolution = resolution;
        let mut evidence = evidence;
        resolution.sources[2].decoded_bytes = "0".into();
        resolution.chain_decoded_bytes = "2000".into();
        evidence[2].decoded_bytes = "0".into();
        evidence[2].complete_lf_end_byte_offset = "0".into();
        assert_eq!(
            assemble(
                &selected(),
                &plan,
                &resolution,
                &projection(THREAD, "80", "1000"),
                &evidence,
            ),
            Err(Error::DurableEvidenceMismatch)
        );
    }

    #[test]
    fn forged_totals_and_empty_physical_sources_are_rejected() {
        let plan = plan();
        for variant in 0..3 {
            let mut resolved = resolution(&plan);
            match variant {
                0 => resolved.chain_stored_bytes = "1".into(),
                1 => {
                    resolved.sources[0].stored_bytes = "0".into();
                    resolved.chain_stored_bytes = "2000".into();
                }
                _ => resolved.sources[2].record_count = 0,
            }
            assert_eq!(
                assemble(
                    &selected(),
                    &plan,
                    &resolved,
                    &projection(THREAD, "80", "1000"),
                    &evidence(&plan)
                ),
                Err(Error::PlanResolutionMismatch)
            );
        }
    }

    #[test]
    fn duplicate_or_overdeep_plans_are_not_accepted() {
        let mut duplicate_plan = plan();
        let mut duplicate_resolution = resolution(&duplicate_plan);
        duplicate_plan.sources[1].rollout_id = duplicate_plan.sources[0].rollout_id.clone();
        duplicate_resolution.sources[1].rollout_id =
            duplicate_resolution.sources[0].rollout_id.clone();
        assert_eq!(
            assemble(
                &selected(),
                &duplicate_plan,
                &duplicate_resolution,
                &projection(THREAD, "80", "1000"),
                &evidence(&duplicate_plan),
            ),
            Err(Error::DuplicateSource)
        );

        let mut deep_plan = plan();
        let mut deep_resolution = resolution(&deep_plan);
        let source = deep_plan.sources[0].clone();
        let resolved = deep_resolution.sources[0].clone();
        while deep_plan.sources.len() <= MAX_DEPTH {
            deep_plan.sources.push(source.clone());
            deep_resolution.sources.push(resolved.clone());
        }
        assert_eq!(
            assemble(
                &selected(),
                &deep_plan,
                &deep_resolution,
                &projection(THREAD, "80", "1000"),
                &evidence(&plan()),
            ),
            Err(Error::PlanTooDeep)
        );
    }

    #[test]
    fn one_sided_cutoff_and_truncated_root_are_unverified() {
        let mut malformed_plan = plan();
        let mut malformed_resolution = resolution(&malformed_plan);
        malformed_plan.sources[0].end_byte_offset = None;
        malformed_resolution.sources[0].end_byte_offset = None;
        assert_eq!(
            assemble(
                &selected(),
                &malformed_plan,
                &malformed_resolution,
                &projection(THREAD, "80", "1000"),
                &evidence(&malformed_plan),
            ),
            Err(Error::PlanResolutionMismatch)
        );

        let mut truncated = plan();
        truncated.reached_root = false;
        let mut truncated_resolution = resolution(&truncated);
        truncated_resolution.reached_root = false;
        assert_eq!(
            assemble(
                &selected(),
                &truncated,
                &truncated_resolution,
                &projection(THREAD, "80", "1000"),
                &evidence(&plan()),
            ),
            Err(Error::OrdinalStartUnverified)
        );
    }
}
