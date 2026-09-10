//! Bounded ancestry for paginated Codex rollouts.
//!
//! A paginated thread can inherit a prefix of another rollout. The inheriting
//! rollout records that relationship in its own `session_meta` as
//! `history_base`, naming the source rollout plus the exclusive ordinal and
//! byte offset where inheritance stops.
//!
//! This module only PARSES and LINKS those pointers. It never opens a path,
//! follows a link, or decides a chain is complete: the caller resolves each
//! rollout through the authenticated source boundary and supplies the bytes.
//! A resolved chain describes what these records claim, not verified history.
use serde::Serialize;
use serde_json::Value;

pub const PROFILE: &str = "codex_paginated_ancestry_v1";
/// Native forks are shallow in practice. A finite depth keeps a malformed or
/// hostile chain from turning into unbounded resolution work.
pub const MAX_DEPTH: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidUtf8,
    InvalidRecord,
    InvalidMetadata,
    SelectedThreadMismatch,
    HistoryModeUnsupported,
    InvalidHistoryBase,
    ChainCycle,
    ChainTooDeep,
    ChainMismatch,
    RecordLimit,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidUtf8 => "paginated_invalid_utf8",
            Self::InvalidRecord => "paginated_invalid_record",
            Self::InvalidMetadata => "paginated_invalid_metadata",
            Self::SelectedThreadMismatch => "paginated_selected_thread_mismatch",
            Self::HistoryModeUnsupported => "paginated_history_mode_unsupported",
            Self::InvalidHistoryBase => "paginated_invalid_history_base",
            Self::ChainCycle => "paginated_chain_cycle",
            Self::ChainTooDeep => "paginated_chain_too_deep",
            Self::ChainMismatch => "paginated_chain_mismatch",
            Self::RecordLimit => "paginated_record_limit",
        }
    }
}

/// Where an inheriting rollout stops consuming its parent. Exclusive: the
/// record AT `end_ordinal_exclusive` belongs to the parent alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBase {
    pub thread_id: String,
    // Exact integers as strings; the bounded Host projection interprets them.
    pub end_ordinal_exclusive: String,
    pub end_byte_offset: String,
}

/// One rollout's own claim about itself, read from its first metadata record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutClaim {
    pub rollout_id: String,
    /// Absent for a root rollout that inherits nothing.
    pub history_base: Option<HistoryBase>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chain {
    pub profile: &'static str,
    /// Selected rollout first, then each ancestor it claims, in order.
    pub links: Vec<RolloutClaim>,
    /// True only when the last link claims no further ancestor. False means
    /// the caller stopped early; it is never a completeness proof either way.
    pub reached_root: bool,
    pub source_authenticated: bool,
    pub history_complete: bool,
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// Native writes these as JSON numbers. Accept only non-negative integers that
/// survive exactly, and keep them as strings so no precision is lost later.
fn exact_offset(value: Option<&Value>) -> Option<String> {
    let number = value?.as_u64()?;
    Some(number.to_string())
}

fn parse_history_base(value: &Value) -> Result<HistoryBase, Error> {
    let object = value.as_object().ok_or(Error::InvalidHistoryBase)?;
    // Exact shape only. An unknown field here would change what inheritance
    // means, so refuse rather than ignore it.
    if object.len() != 3 {
        return Err(Error::InvalidHistoryBase);
    }
    let thread_id = object
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|id| uuid(id))
        .ok_or(Error::InvalidHistoryBase)?;
    let end_ordinal_exclusive =
        exact_offset(object.get("end_ordinal_exclusive")).ok_or(Error::InvalidHistoryBase)?;
    let end_byte_offset =
        exact_offset(object.get("end_byte_offset")).ok_or(Error::InvalidHistoryBase)?;
    Ok(HistoryBase {
        thread_id: thread_id.to_string(),
        end_ordinal_exclusive,
        end_byte_offset,
    })
}

/// Read one paginated rollout's first `session_meta` record.
///
/// `bytes` must be exactly one complete JSONL record, supplied by the
/// authenticated source boundary. The record is not retained.
pub fn read_claim(expected_rollout_id: &str, bytes: &[u8]) -> Result<RolloutClaim, Error> {
    if !uuid(expected_rollout_id) {
        return Err(Error::SelectedThreadMismatch);
    }
    if bytes.is_empty() || bytes.len() > crate::jsonl_scan::RECORD_BYTES {
        return Err(Error::RecordLimit);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Error::InvalidUtf8)?;
    let value: Value =
        serde_json::from_str(text.trim_end_matches('\n')).map_err(|_| Error::InvalidRecord)?;
    if !value.is_object() || value["type"] != "session_meta" {
        return Err(Error::InvalidRecord);
    }
    let payload = value["payload"].as_object().ok_or(Error::InvalidMetadata)?;
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| uuid(id))
        .ok_or(Error::InvalidMetadata)?;
    if id != expected_rollout_id {
        return Err(Error::SelectedThreadMismatch);
    }
    // This module exists for paginated ancestry. A legacy rollout has no
    // history_base semantics and belongs to the separate legacy validator.
    match payload.get("history_mode") {
        Some(Value::String(mode)) if mode == "paginated" => {}
        _ => return Err(Error::HistoryModeUnsupported),
    }
    let history_base = match payload.get("history_base") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_history_base(value)?),
    };
    Ok(RolloutClaim {
        rollout_id: id.to_string(),
        history_base,
    })
}

/// Link already-parsed claims into one chain, newest first.
///
/// The caller resolves each ancestor through the authenticated source boundary
/// and appends its claim. This function enforces that every step actually
/// matches the ancestor the previous link named, and that the chain stays
/// finite and acyclic. It never proves the underlying history is complete.
pub fn link(claims: Vec<RolloutClaim>) -> Result<Chain, Error> {
    if claims.is_empty() {
        return Err(Error::ChainMismatch);
    }
    if claims.len() > MAX_DEPTH {
        return Err(Error::ChainTooDeep);
    }
    let mut seen = std::collections::BTreeSet::new();
    for (index, claim) in claims.iter().enumerate() {
        if !seen.insert(claim.rollout_id.as_str()) {
            return Err(Error::ChainCycle);
        }
        let Some(base) = &claim.history_base else {
            // A root must be the final link; anything after it was not named.
            if index + 1 != claims.len() {
                return Err(Error::ChainMismatch);
            }
            break;
        };
        // A self-referencing base is a cycle even at depth one.
        if base.thread_id == claim.rollout_id {
            return Err(Error::ChainCycle);
        }
        if claims
            .get(index + 1)
            .is_some_and(|next| next.rollout_id != base.thread_id)
        {
            return Err(Error::ChainMismatch);
        }
    }
    let reached_root = claims
        .last()
        .is_some_and(|claim| claim.history_base.is_none());
    Ok(Chain {
        profile: PROFILE,
        links: claims,
        reached_root,
        source_authenticated: false,
        history_complete: false,
    })
}

#[cfg(test)]
mod tests;
