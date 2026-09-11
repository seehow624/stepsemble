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
    /// Decoded output across the whole chain would exceed one admission.
    DecodedChainBytesExceeded,
    /// An inherited cut point lies beyond the source that must contain it.
    CutoffOutsideSource,
    /// The caller did not provide a per-record ordinal/byte correspondence
    /// for a source that has an inherited cut point.
    CutoffUnverified,
    /// A planned cutoff is malformed or contains only one of ordinal/offset.
    InvalidCutoff,
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
            Self::DecodedChainBytesExceeded => "paginated_resolution_decoded_bytes_exceeded",
            Self::CutoffOutsideSource => "paginated_resolution_cutoff_outside_source",
            Self::CutoffUnverified => "paginated_resolution_cutoff_unverified",
            Self::InvalidCutoff => "paginated_resolution_invalid_cutoff",
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
    /// Complete records the caller validated in this source. These are local
    /// record positions; they cannot validate a global created ordinal.
    pub record_count: u32,
    /// Bytes actually read from storage, which for a compressed source is the
    /// stored size. Budget accounting uses this, not the decoded length.
    pub stored_bytes: u64,
    /// True only when the source scanner saw every record's ordinal and
    /// matched the requested exclusive ordinal to its exact line-end byte.
    pub ordinal_cutoff_verified: bool,
    /// Decoded byte offset immediately after the last complete LF record.
    /// Legacy callers may omit this evidence; the owned paginated opener
    /// always supplies it.
    pub complete_lf_end_byte_offset: Option<u64>,
    /// Global created ordinal immediately after the last observed record.
    /// This is deliberately separate from the local `record_count`.
    pub next_ordinal_exclusive: Option<u64>,
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
    /// Native complete-LF evidence, when supplied by the owned opener.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete_lf_end_byte_offset: Option<String>,
    /// Native global ordinal evidence, when supplied by the owned opener.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_ordinal_exclusive: Option<String>,
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
    /// Total decoded bytes observed across the whole chain, independently
    /// bounded from stored bytes so zstd expansion cannot bypass admission.
    pub chain_decoded_bytes: String,
    /// True only when every planned cutoff was matched by the source scanner's
    /// per-record global ordinal and exact decoded-byte line end. `record_count`
    /// is a local count and is never compared to a global created ordinal.
    pub ordinal_cutoffs_verified: bool,
    pub reached_root: bool,
    pub source_authenticated: bool,
    /// Always false. Resolving every planned source proves the pointers were
    /// followed, never that the underlying durable history is complete.
    pub history_complete: bool,
}

fn cutoff(planned: &PlannedSource) -> Result<Option<(u128, u128)>, Error> {
    match (
        planned.end_ordinal_exclusive.as_deref(),
        planned.end_byte_offset.as_deref(),
    ) {
        (None, None) => Ok(None),
        (Some(ordinal), Some(offset)) => Ok(Some((
            ordinal.parse().map_err(|_| Error::InvalidCutoff)?,
            offset.parse().map_err(|_| Error::InvalidCutoff)?,
        ))),
        _ => Err(Error::InvalidCutoff),
    }
}

/// Check the observations against the plan and account for the whole chain.
///
/// `observations` must be in plan order (oldest first) and cover every
/// planned source. Anything else is a mismatch rather than a partial result.
pub fn resolve(plan: &Plan, observations: &[Observed]) -> Result<Resolution, Error> {
    if observations.len() != plan.sources.len() {
        return Err(Error::IncompleteResolution);
    }
    for planned in &plan.sources {
        cutoff(planned)?;
    }
    let mut consumed = 0_u64;
    let mut decoded_consumed = 0_u64;
    let mut sources = Vec::with_capacity(plan.sources.len());
    for (planned, observed) in plan.sources.iter().zip(observations) {
        if planned.rollout_id != observed.rollout_id {
            return Err(Error::PlanMismatch);
        }
        consumed = chain_plan::accumulate(consumed, observed.stored_bytes)
            .map_err(|_| Error::ChainBytesExceeded)?;
        decoded_consumed = chain_plan::accumulate_decoded(decoded_consumed, observed.decoded_bytes)
            .map_err(|_| Error::DecodedChainBytesExceeded)?;
        check_cutoff(planned, observed)?;
        sources.push(resolved(planned, observed));
    }
    Ok(Resolution {
        profile: PROFILE,
        thread_id: plan.thread_id.clone(),
        sources,
        chain_stored_bytes: consumed.to_string(),
        chain_decoded_bytes: decoded_consumed.to_string(),
        ordinal_cutoffs_verified: plan.sources.iter().zip(observations).all(
            |(planned, observed)| {
                planned.end_ordinal_exclusive.is_none() || observed.ordinal_cutoff_verified
            },
        ),
        reached_root: plan.reached_root,
        source_authenticated: false,
        history_complete: false,
    })
}

/// A link that is inherited FROM must actually contain its cut point. A cut
/// past the end of the source would silently drop records the chain claims.
fn check_cutoff(planned: &PlannedSource, observed: &Observed) -> Result<(), Error> {
    let Some((_, offset)) = cutoff(planned)? else {
        return Ok(());
    };
    if !observed.ordinal_cutoff_verified {
        return Err(Error::CutoffUnverified);
    }
    if observed.decoded_bytes == 0 || observed.record_count == 0 {
        return Err(Error::EmptySource);
    }
    // `end_ordinal_exclusive` is a global created ordinal. The scanner has
    // already matched it to an exact record line-end; `record_count` remains a
    // local count and is not used as an ordinal proxy.
    if offset > u128::from(observed.decoded_bytes) {
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
        complete_lf_end_byte_offset: observed
            .complete_lf_end_byte_offset
            .map(|value| value.to_string()),
        next_ordinal_exclusive: observed
            .next_ordinal_exclusive
            .map(|value| value.to_string()),
        end_ordinal_exclusive: planned.end_ordinal_exclusive.clone(),
        end_byte_offset: planned.end_byte_offset.clone(),
    }
}

#[cfg(test)]
mod tests;
