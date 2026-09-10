//! Chain-level planning for resolving a paginated rollout's ancestry.
//!
//! [`codex_paginated_ancestry`] parses ONE rollout's inheritance pointer.
//! This module turns a selected rollout plus its ancestors into a bounded,
//! ordered resolution PLAN and validates the whole chain as a unit.
//!
//! It opens nothing. Each rollout is still fetched through the authenticated
//! source boundary, one at a time, under the shared reader admission. The plan
//! only says which locators to fetch, in what order, and how many bytes the
//! whole chain is allowed to consume before the caller must stop.
use crate::codex_paginated_ancestry::{Chain, HistoryBase, RolloutClaim};
use serde::Serialize;

pub const PROFILE: &str = "codex_paginated_chain_plan_v1";
/// One chain may not consume more than a single oversized source would.
/// Ancestry must not become a way to read unbounded bytes in one admission.
pub const CHAIN_BYTES: u64 = crate::jsonl_scan::SOURCE_BYTES;
/// Decoded bytes have an independent whole-chain budget. A compressed source
/// may be small on disk while expanding to the full per-source allowance, so
/// stored-byte accounting alone must not permit an unbounded chain expansion.
pub const CHAIN_DECODED_BYTES: u64 = crate::jsonl_scan::SOURCE_BYTES;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// A locator did not match the rollout it is supposed to hold.
    LocatorMismatch,
    /// Two links resolved to the same physical file.
    DuplicateLocator,
    /// The chain's cut points do not move strictly backwards.
    NonMonotonicCutoff,
    /// The selected rollout does not match the thread the caller asked for.
    SelectedMismatch,
    /// The chain would read more than one admission is allowed to.
    ChainBytesExceeded,
    /// Decoded output across the chain would exceed one admission's bound.
    DecodedChainBytesExceeded,
    /// A link the plan needs was not supplied.
    IncompleteChain,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::LocatorMismatch => "paginated_chain_locator_mismatch",
            Self::DuplicateLocator => "paginated_chain_duplicate_locator",
            Self::NonMonotonicCutoff => "paginated_chain_non_monotonic_cutoff",
            Self::SelectedMismatch => "paginated_chain_selected_mismatch",
            Self::ChainBytesExceeded => "paginated_chain_bytes_exceeded",
            Self::DecodedChainBytesExceeded => "paginated_chain_decoded_bytes_exceeded",
            Self::IncompleteChain => "paginated_chain_incomplete",
        }
    }
}

/// One rollout the caller must fetch, with the exact slice this chain uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSource {
    pub rollout_id: String,
    /// Repository-relative locator, already shape-checked for this rollout.
    pub rollout_path: String,
    /// True when the locator names a compressed sibling. The caller still
    /// decides how to decode it; nothing here rewrites a locator.
    pub compressed: bool,
    /// True when the locator lives under archived_sessions.
    pub archived: bool,
    /// Exclusive ordinal where THIS source stops contributing, set by whichever
    /// descendant inherited from it. None means the source contributes through
    /// its end, which is true for the newest rollout in the chain.
    pub end_ordinal_exclusive: Option<String>,
    pub end_byte_offset: Option<String>,
}

/// Ordered oldest-first: the caller reads ancestors before the newest rollout
/// so inherited records arrive in their original order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub profile: &'static str,
    /// The stable thread the caller asked about, which after a revert differs
    /// from the newest physical rollout ID.
    pub thread_id: String,
    pub sources: Vec<PlannedSource>,
    pub reached_root: bool,
    pub chain_byte_budget: u64,
    pub chain_decoded_byte_budget: u64,
    pub source_authenticated: bool,
    pub history_complete: bool,
}

/// A locator the caller resolved for one rollout in the chain.
pub struct Locator<'a> {
    pub rollout_id: &'a str,
    pub rollout_path: &'a str,
}

fn cut_ordinal(base: &HistoryBase) -> u128 {
    // Values were already validated as exact non-negative integers.
    base.end_ordinal_exclusive.parse().unwrap_or(u128::MAX)
}

/// Build the ordered plan.
///
/// `chain` is newest-first, as produced by ancestry linking. `locators`
/// must supply one entry per link. `thread_id` is the STABLE thread the caller
/// selected; the newest rollout may carry a different physical ID after a
/// revert, so it is matched against the chain head rather than assumed equal.
pub fn plan(
    thread_id: &str,
    selected_rollout_id: &str,
    chain: &Chain,
    locators: &[Locator<'_>],
) -> Result<Plan, Error> {
    if chain.links.is_empty() || locators.len() != chain.links.len() {
        return Err(Error::IncompleteChain);
    }
    if !crate::codex_locator::session_id(thread_id) {
        return Err(Error::SelectedMismatch);
    }
    let head = &chain.links[0];
    if head.rollout_id != selected_rollout_id {
        return Err(Error::SelectedMismatch);
    }

    let mut sources = Vec::with_capacity(chain.links.len());
    let mut previous_cut: Option<u128> = None;
    let mut seen_paths = std::collections::BTreeSet::new();
    for (index, (link, locator)) in chain.links.iter().zip(locators).enumerate() {
        if locator.rollout_id != link.rollout_id {
            return Err(Error::LocatorMismatch);
        }
        // The head is addressed by the selected stable thread ID. Ancestors
        // may themselves be reverted, so derive each locator's stable prefix
        // rather than assuming it equals the physical chain ID.
        let locator_thread = if index == 0 {
            thread_id.to_owned()
        } else {
            crate::codex_locator::stable_thread_id(locator.rollout_path)
                .ok_or(Error::LocatorMismatch)?
        };
        if !seen_paths.insert(locator.rollout_path) {
            return Err(Error::DuplicateLocator);
        }
        if !crate::codex_locator::valid_locator(locator.rollout_path, &locator_thread)
            || crate::codex_locator::physical_rollout_id(locator.rollout_path, &locator_thread)
                .as_deref()
                != Some(link.rollout_id.as_str())
        {
            return Err(Error::LocatorMismatch);
        }
        // Each ancestor must be cut strictly earlier than the link that named
        // the previous one; otherwise the chain claims overlapping history.
        let cut = link.history_base.as_ref().map(cut_ordinal);
        if let (Some(previous), Some(current)) = (previous_cut, cut)
            && current >= previous
        {
            return Err(Error::NonMonotonicCutoff);
        }
        if cut.is_some() {
            previous_cut = cut;
        }
        sources.push(planned(link, locator));
    }
    // A link's history_base describes how much of its ANCESTOR is used, so the
    // cut belongs to the source being inherited from, not to the inheritor.
    // Shift each cut one position deeper before ordering oldest-first.
    let cuts: Vec<_> = chain
        .links
        .iter()
        .map(|link| link.history_base.clone())
        .collect();
    for (index, source) in sources.iter_mut().enumerate() {
        let inherited_from_here = index
            .checked_sub(1)
            .and_then(|previous| cuts.get(previous))
            .and_then(Option::as_ref);
        source.end_ordinal_exclusive = inherited_from_here.map(|b| b.end_ordinal_exclusive.clone());
        source.end_byte_offset = inherited_from_here.map(|b| b.end_byte_offset.clone());
    }
    sources.reverse();
    Ok(Plan {
        profile: PROFILE,
        thread_id: thread_id.to_string(),
        sources,
        reached_root: chain.reached_root,
        chain_byte_budget: CHAIN_BYTES,
        chain_decoded_byte_budget: CHAIN_DECODED_BYTES,
        source_authenticated: false,
        history_complete: false,
    })
}

fn planned(link: &RolloutClaim, locator: &Locator<'_>) -> PlannedSource {
    PlannedSource {
        rollout_id: link.rollout_id.clone(),
        rollout_path: locator.rollout_path.to_string(),
        compressed: locator.rollout_path.ends_with(".zst"),
        archived: locator.rollout_path.starts_with("archived_sessions/"),
        // Filled in by plan(), which knows which descendant inherited from
        // this source and therefore where it stops contributing.
        end_ordinal_exclusive: None,
        end_byte_offset: None,
    }
}

/// Account for bytes as the caller resolves each planned source.
///
/// The caller adds each observed size before reading it. Exceeding the chain
/// budget stops resolution instead of silently returning a partial chain.
pub fn accumulate(consumed: u64, next_source_bytes: u64) -> Result<u64, Error> {
    consumed
        .checked_add(next_source_bytes)
        .filter(|total| *total <= CHAIN_BYTES)
        .ok_or(Error::ChainBytesExceeded)
}

/// Account for decoded bytes independently from physical stored bytes.
/// Compressed sources must not use their small on-disk size to bypass this
/// aggregate expansion bound.
pub fn accumulate_decoded(consumed: u64, next_source_bytes: u64) -> Result<u64, Error> {
    consumed
        .checked_add(next_source_bytes)
        .filter(|total| *total <= CHAIN_DECODED_BYTES)
        .ok_or(Error::DecodedChainBytesExceeded)
}

#[cfg(test)]
mod tests;
