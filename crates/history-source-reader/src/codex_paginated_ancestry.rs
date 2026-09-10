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
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;

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
    InvalidOrdinal,
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
            Self::InvalidOrdinal => "paginated_invalid_ordinal",
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
    if end_ordinal_exclusive == "0" {
        return Err(Error::InvalidHistoryBase);
    }
    let end_byte_offset =
        exact_offset(object.get("end_byte_offset")).ok_or(Error::InvalidHistoryBase)?;
    Ok(HistoryBase {
        thread_id: thread_id.to_string(),
        end_ordinal_exclusive,
        end_byte_offset,
    })
}

/// Reject duplicate JSON object keys before parsing the permissive metadata
/// envelope into `Value`. The envelope intentionally accepts unknown native
/// metadata fields, but keys that control ancestry must not be silently
/// replaced by serde_json's last-key-wins map behavior. A recursive visitor
/// keeps that compatibility while making duplicate `id`, `history_mode`,
/// `history_base`, and cutoff fields fail closed.
fn reject_duplicate_keys(bytes: &[u8]) -> Result<(), Error> {
    struct Seed;
    struct Keys;

    impl<'de> DeserializeSeed<'de> for Seed {
        type Value = ();

        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserializer.deserialize_any(Keys)
        }
    }

    impl<'de> Visitor<'de> for Keys {
        type Value = ();

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON value with unique object keys")
        }

        fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(())
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            while sequence.next_element_seed(Seed)?.is_some() {}
            Ok(())
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut keys = std::collections::BTreeSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !keys.insert(key) {
                    return Err(serde::de::Error::custom("duplicate JSON object key"));
                }
                map.next_value_seed(Seed)?;
            }
            Ok(())
        }
    }

    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    serde::Deserializer::deserialize_any(&mut deserializer, Keys)
        .map_err(|_| Error::InvalidRecord)?;
    deserializer.end().map_err(|_| Error::InvalidRecord)
}

/// Read one paginated rollout's first `session_meta` record.
///
/// The metadata ID and the physical rollout ID are usually equal. After a
/// native revert, however, the selected file keeps the stable thread ID in
/// `payload.id` while its locator carries a distinct physical rollout UUID.
/// Callers must provide both identities explicitly; the returned claim keeps
/// the physical ID used for ancestry linking.
pub fn read_claim_with_metadata_id(
    expected_metadata_id: &str,
    expected_rollout_id: &str,
    bytes: &[u8],
) -> Result<RolloutClaim, Error> {
    if !uuid(expected_metadata_id) || !uuid(expected_rollout_id) {
        return Err(Error::SelectedThreadMismatch);
    }
    if bytes.is_empty() || bytes.len() > crate::jsonl_scan::RECORD_BYTES {
        return Err(Error::RecordLimit);
    }
    // The ancestry claim is the first metadata record, not a best-effort JSON
    // prefix. Require exactly one terminating LF so a missing tail or an
    // appended second record cannot be silently accepted as this claim.
    if bytes.last() != Some(&b'\n') || bytes.iter().filter(|byte| **byte == b'\n').count() != 1 {
        return Err(Error::InvalidRecord);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Error::InvalidUtf8)?;
    reject_duplicate_keys(text.trim_end_matches('\n').as_bytes())?;
    let value: Value =
        serde_json::from_str(text.trim_end_matches('\n')).map_err(|_| Error::InvalidRecord)?;
    if !value.is_object() || value["type"] != "session_meta" {
        return Err(Error::InvalidRecord);
    }
    let ordinal = value
        .get("ordinal")
        .and_then(Value::as_u64)
        .ok_or(Error::InvalidOrdinal)?;
    let payload = value["payload"].as_object().ok_or(Error::InvalidMetadata)?;
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| uuid(id))
        .ok_or(Error::InvalidMetadata)?;
    if id != expected_metadata_id {
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
    let expected_ordinal = history_base
        .as_ref()
        .map_or(Some(0), |base| base.end_ordinal_exclusive.parse().ok());
    if expected_ordinal != Some(ordinal) {
        return Err(Error::InvalidOrdinal);
    }
    Ok(RolloutClaim {
        rollout_id: expected_rollout_id.to_string(),
        history_base,
    })
}

/// Compatibility helper for non-reverted sources where metadata and physical
/// rollout IDs are the same.
pub fn read_claim(expected_rollout_id: &str, bytes: &[u8]) -> Result<RolloutClaim, Error> {
    read_claim_with_metadata_id(expected_rollout_id, expected_rollout_id, bytes)
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
