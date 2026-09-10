//! Turn a chain plan into a verified, byte-accounted resolution result.
//!
//! [`codex_paginated_chain`] decides WHICH rollouts to read and in what
//! order. This module records what the caller actually observed for each one
//! and checks the chain as a whole: budget, plan agreement, and whether the
//! inherited cut points fall inside the source that is supposed to contain them.
//!
//! It opens nothing and parses no records. The caller reads each planned
//! source through the authenticated boundary and reports the observation here.
//! The result describes what these sources contain, never that the resulting
//! history is complete or publishable.
use crate::codex_paginated_chain::{self as chain_plan, Plan, PlannedSource};
use serde::Serialize;

pub const PROFILE: &str = "codex_paginated_resolution_v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// An observation arrived for a rollout the plan did not schedule, or in
    /// the wrong order.
    PlanMismatch,
    /// The whole chain would read more bytes than one admission allows.
    ChainBytesExceeded,
    /// An inherited cut point lies beyond the source that must contain it.
    CutoffOutsideSource,
    /// A source the plan scheduled was never observed.
    IncompleteResolution,
    /// A source was observed as empty, which cannot satisfy a cut point.
    EmptySource,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::PlanMismatch => "paginated_resolution_plan_mismatch",
            Self::ChainBytesExceeded => "paginated_resolution_bytes_exceeded",
            Self::CutoffOutsideSource => "paginated_resolution_cutoff_outside_source",
            Self::IncompleteResolution => "paginated_resolution_incomplete",
            Self::EmptySource => "paginated_resolution_empty_source",
        }
    }
}

/// What the caller actually observed after reading one planned source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    pub rollout_id: String,
    /// Decoded byte length. For a compressed source this is the decoded size,
    /// which is what ordinals and offsets refer to.
    pub decoded_bytes: u64,
    /// Complete records the caller validated in this source.
    pub record_count: u32,
    /// Bytes actually read from storage, which for a compressed source is the
    /// stored size. Budget accounting uses this, not the decoded length.
    pub stored_bytes: u64,
}

/// One resolved link, pairing the plan with the observation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSource {
    pub rollout_id: String,
    pub rollout_path: String,
    pub compressed: bool,
    pub archived: bool,
    pub decoded_bytes: String,
    pub stored_bytes: String,
    pub record_count: u32,
    /// The exclusive ordinal this link contributes up to, when it is inherited
    /// from. None means the link contributes through its end.
    pub end_ordinal_exclusive: Option<String>,
    pub end_byte_offset: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub profile: &'static str,
    pub thread_id: String,
    pub sources: Vec<ResolvedSource>,
    /// Total stored bytes read across the whole chain.
    pub chain_stored_bytes: String,
    pub reached_root: bool,
    pub source_authenticated: bool,
    /// Always false. Resolving every planned source proves the pointers were
    /// followed, never that the underlying durable history is complete.
    pub history_complete: bool,
}

fn exact(value: &Option<String>) -> Option<u128> {
    value.as_ref().and_then(|v| v.parse().ok())
}

/// Check the observations against the plan and account for the whole chain.
///
/// `observations` must be in plan order (oldest first) and cover every
/// planned source. Anything else is a mismatch rather than a partial result.
pub fn resolve(plan: &Plan, observations: &[Observed]) -> Result<Resolution, Error> {
    if observations.len() != plan.sources.len() {
        return Err(Error::IncompleteResolution);
    }
    let mut consumed = 0_u64;
    let mut sources = Vec::with_capacity(plan.sources.len());
    for (planned, observed) in plan.sources.iter().zip(observations) {
        if planned.rollout_id != observed.rollout_id {
            return Err(Error::PlanMismatch);
        }
        consumed = chain_plan::accumulate(consumed, observed.stored_bytes)
            .map_err(|_| Error::ChainBytesExceeded)?;
        check_cutoff(planned, observed)?;
        sources.push(resolved(planned, observed));
    }
    Ok(Resolution {
        profile: PROFILE,
        thread_id: plan.thread_id.clone(),
        sources,
        chain_stored_bytes: consumed.to_string(),
        reached_root: plan.reached_root,
        source_authenticated: false,
        history_complete: false,
    })
}

/// A link that is inherited FROM must actually contain its cut point. A cut
/// past the end of the source would silently drop records the chain claims.
fn check_cutoff(planned: &PlannedSource, observed: &Observed) -> Result<(), Error> {
    let (Some(ordinal), Some(offset)) = (
        exact(&planned.end_ordinal_exclusive),
        exact(&planned.end_byte_offset),
    ) else {
        return Ok(());
    };
    if observed.decoded_bytes == 0 || observed.record_count == 0 {
        return Err(Error::EmptySource);
    }
    if offset > u128::from(observed.decoded_bytes) || ordinal > u128::from(observed.record_count) {
        return Err(Error::CutoffOutsideSource);
    }
    Ok(())
}

fn resolved(planned: &PlannedSource, observed: &Observed) -> ResolvedSource {
    ResolvedSource {
        rollout_id: planned.rollout_id.clone(),
        rollout_path: planned.rollout_path.clone(),
        compressed: planned.compressed,
        archived: planned.archived,
        decoded_bytes: observed.decoded_bytes.to_string(),
        stored_bytes: observed.stored_bytes.to_string(),
        record_count: observed.record_count,
        end_ordinal_exclusive: planned.end_ordinal_exclusive.clone(),
        end_byte_offset: planned.end_byte_offset.clone(),
    }
}

#[cfg(test)]
mod tests;
