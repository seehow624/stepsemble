//! Protocol 17 adapter for the pure Codex paginated consistency gate.
//!
//! This process intentionally does not open a source path or a SQLite file.
//! It accepts only the detached observations produced by the already bounded
//! protocol 15/16 readers, converts them into the canonical Rust types, and
//! runs `codex_paginated_consistency::assemble()`.  The result remains an
//! observation: all authority, provenance and atomic-snapshot flags stay
//! false.

use crate::Error;
use serde::{Deserialize, Serialize};
use std::io::Write;
use stepsemble_history_source_reader::{
    codex_paginated_ancestry::MAX_DEPTH,
    codex_paginated_chain::{self as chain, Plan, PlannedSource},
    codex_paginated_consistency::{self as consistency, Consistency, DurableEvidence},
    codex_paginated_resolution::{self as resolution, Resolution, ResolvedSource},
    sqlite_metadata::{self, CatalogEntry},
    sqlite_paginated::{Checkpoint, Observation},
};

pub const INPUT_LIMIT: usize = 512 * 1024;
const OUTPUT_LIMIT: usize = 256 * 1024;
const PROTOCOL_VERSION: u8 = 17;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    protocol_version: u8,
    nonce: String,
    native_version: String,
    selected: Selected,
    plan: PlanWire,
    resolution: ResolutionWire,
    projection: ProjectionWire,
    evidence: Vec<EvidenceWire>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selected {
    id: String,
    rollout_path: String,
    source: String,
    history_mode: String,
    archived: bool,
    created_at: String,
    updated_at: String,
    created_at_ms: Option<String>,
    updated_at_ms: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanWire {
    profile: String,
    thread_id: String,
    sources: Vec<PlannedSourceWire>,
    reached_root: bool,
    chain_byte_budget: u64,
    chain_decoded_byte_budget: u64,
    source_authenticated: bool,
    history_complete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlannedSourceWire {
    rollout_id: String,
    rollout_path: String,
    compressed: bool,
    archived: bool,
    end_ordinal_exclusive: Option<String>,
    end_byte_offset: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolutionWire {
    profile: String,
    thread_id: String,
    sources: Vec<ResolvedSourceWire>,
    chain_stored_bytes: String,
    chain_decoded_bytes: String,
    ordinal_cutoffs_verified: bool,
    reached_root: bool,
    source_authenticated: bool,
    history_complete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolvedSourceWire {
    rollout_id: String,
    rollout_path: String,
    compressed: bool,
    archived: bool,
    decoded_bytes: String,
    stored_bytes: String,
    record_count: u32,
    end_ordinal_exclusive: Option<String>,
    end_byte_offset: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectionWire {
    kind: String,
    native_version: String,
    thread_id: String,
    checkpoint: Option<CheckpointWire>,
    source_authenticated: bool,
    publishable: bool,
    history_complete: bool,
    connection_closed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointWire {
    next_rollout_byte_offset: String,
    next_rollout_ordinal: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceWire {
    rollout_id: String,
    decoded_bytes: String,
    complete_lf_end_byte_offset: String,
    next_ordinal_exclusive: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Success {
    kind: &'static str,
    native_version: String,
    thread_id: String,
    consistency: Consistency,
    source_authenticated: bool,
    publishable: bool,
    history_complete: bool,
}

fn hex_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn convert_selected(value: Selected) -> CatalogEntry {
    CatalogEntry {
        id: value.id,
        rollout_path: value.rollout_path,
        source: value.source,
        history_mode: value.history_mode,
        archived: value.archived,
        created_at: value.created_at,
        updated_at: value.updated_at,
        created_at_ms: value.created_at_ms,
        updated_at_ms: value.updated_at_ms,
    }
}

fn convert_plan(value: PlanWire) -> Result<Plan, Error> {
    if value.profile != chain::PROFILE {
        return Err(Error::Input);
    }
    Ok(Plan {
        profile: chain::PROFILE,
        thread_id: value.thread_id,
        sources: value
            .sources
            .into_iter()
            .map(|source| PlannedSource {
                rollout_id: source.rollout_id,
                rollout_path: source.rollout_path,
                compressed: source.compressed,
                archived: source.archived,
                end_ordinal_exclusive: source.end_ordinal_exclusive,
                end_byte_offset: source.end_byte_offset,
            })
            .collect(),
        reached_root: value.reached_root,
        chain_byte_budget: value.chain_byte_budget,
        chain_decoded_byte_budget: value.chain_decoded_byte_budget,
        source_authenticated: value.source_authenticated,
        history_complete: value.history_complete,
    })
}

fn convert_resolution(value: ResolutionWire) -> Result<Resolution, Error> {
    if value.profile != resolution::PROFILE {
        return Err(Error::Input);
    }
    Ok(Resolution {
        profile: resolution::PROFILE,
        thread_id: value.thread_id,
        sources: value
            .sources
            .into_iter()
            .map(|source| ResolvedSource {
                rollout_id: source.rollout_id,
                rollout_path: source.rollout_path,
                compressed: source.compressed,
                archived: source.archived,
                decoded_bytes: source.decoded_bytes,
                stored_bytes: source.stored_bytes,
                record_count: source.record_count,
                end_ordinal_exclusive: source.end_ordinal_exclusive,
                end_byte_offset: source.end_byte_offset,
            })
            .collect(),
        chain_stored_bytes: value.chain_stored_bytes,
        chain_decoded_bytes: value.chain_decoded_bytes,
        ordinal_cutoffs_verified: value.ordinal_cutoffs_verified,
        reached_root: value.reached_root,
        source_authenticated: value.source_authenticated,
        history_complete: value.history_complete,
    })
}

fn convert_projection(value: ProjectionWire) -> Result<Observation, Error> {
    if value.kind != "codex_paginated_projection_checkpoint"
        || value.native_version != sqlite_metadata::NATIVE_VERSION
    {
        return Err(Error::Input);
    }
    let checkpoint = value.checkpoint.map(|checkpoint| Checkpoint {
        next_rollout_byte_offset: checkpoint.next_rollout_byte_offset,
        next_rollout_ordinal: checkpoint.next_rollout_ordinal,
    });
    Ok(Observation {
        kind: "codex_paginated_projection_checkpoint",
        native_version: sqlite_metadata::NATIVE_VERSION,
        sqlite_version: sqlite_metadata::SQLITE_VERSION,
        scope: "provided_history_database_selected_thread_projection_only",
        thread_id: value.thread_id,
        checkpoint,
        turns: Vec::new(),
        item_count: "0".to_string(),
        max_item_ordinal: None,
        source_authenticated: value.source_authenticated,
        publishable: value.publishable,
        history_complete: value.history_complete,
        connection_closed: value.connection_closed,
    })
}

fn convert_evidence(values: Vec<EvidenceWire>) -> Vec<DurableEvidence> {
    values
        .into_iter()
        .map(|value| DurableEvidence {
            rollout_id: value.rollout_id,
            decoded_bytes: value.decoded_bytes,
            complete_lf_end_byte_offset: value.complete_lf_end_byte_offset,
            next_ordinal_exclusive: value.next_ordinal_exclusive,
        })
        .collect()
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if request.protocol_version != PROTOCOL_VERSION
        || !hex_nonce(&request.nonce)
        || request.native_version != sqlite_metadata::NATIVE_VERSION
        || request.plan.sources.is_empty()
        || request.plan.sources.len() > MAX_DEPTH
        || request.resolution.sources.len() != request.plan.sources.len()
        || request.evidence.len() != request.plan.sources.len()
        || request.projection.thread_id.is_empty()
    {
        return Err(Error::Input);
    }
    Ok(request)
}

pub fn capture(request: Request) -> Result<Success, Error> {
    let selected = convert_selected(request.selected);
    let plan = convert_plan(request.plan)?;
    let resolution = convert_resolution(request.resolution)?;
    let projection = convert_projection(request.projection)?;
    let evidence = convert_evidence(request.evidence);
    let result = consistency::assemble(&selected, &plan, &resolution, &projection, &evidence)
        .map_err(Error::PaginatedConsistency)?;
    Ok(Success {
        kind: "native_codex_paginated_consistency",
        native_version: request.native_version,
        thread_id: result.thread_id.clone(),
        consistency: result,
        source_authenticated: false,
        publishable: false,
        history_complete: false,
    })
}

pub fn write_frame(
    mut output: impl Write,
    request: &Request,
    result: Result<Success, Error>,
) -> Result<(), Error> {
    let result = match result {
        Ok(success) => serde_json::to_value(success).map_err(|_| Error::Io)?,
        Err(error) => serde_json::json!({"kind":"source_unavailable","code":error.code()}),
    };
    let header = serde_json::to_vec(&serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "nonce": request.nonce,
        "result": result,
    }))
    .map_err(|_| Error::Io)?;
    if header.len() > OUTPUT_LIMIT {
        return Err(Error::TooLarge);
    }
    output
        .write_all(&(header.len() as u32).to_be_bytes())
        .map_err(|_| Error::Io)?;
    output.write_all(&header).map_err(|_| Error::Io)?;
    output.flush().map_err(|_| Error::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const PATH: &str = "sessions/2026/01/05/rollout-2026-01-05T12-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl";

    fn request() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "nonce": "a".repeat(64),
            "nativeVersion": sqlite_metadata::NATIVE_VERSION,
            "selected": {"id": THREAD, "rolloutPath": PATH, "source": "owned", "historyMode": "paginated", "archived": false,
                "createdAt": "1", "updatedAt": "1", "createdAtMs": null, "updatedAtMs": null},
            "plan": {"profile": chain::PROFILE, "threadId": THREAD, "sources": [{"rolloutId": THREAD, "rolloutPath": PATH,
                "compressed": false, "archived": false, "endOrdinalExclusive": null, "endByteOffset": null}], "reachedRoot": true,
                "chainByteBudget": chain::CHAIN_BYTES, "chainDecodedByteBudget": chain::CHAIN_DECODED_BYTES,
                "sourceAuthenticated": false, "historyComplete": false},
            "resolution": {"profile": resolution::PROFILE, "threadId": THREAD, "sources": [{"rolloutId": THREAD, "rolloutPath": PATH,
                "compressed": false, "archived": false, "decodedBytes": "5", "storedBytes": "5", "recordCount": 1,
                "endOrdinalExclusive": null, "endByteOffset": null}], "chainStoredBytes": "5", "chainDecodedBytes": "5",
                "ordinalCutoffsVerified": true, "reachedRoot": true, "sourceAuthenticated": false, "historyComplete": false},
            "projection": {"kind": "codex_paginated_projection_checkpoint", "nativeVersion": sqlite_metadata::NATIVE_VERSION,
                "threadId": THREAD, "checkpoint": {"nextRolloutByteOffset": "5", "nextRolloutOrdinal": "1"},
                "sourceAuthenticated": false, "publishable": false, "historyComplete": false, "connectionClosed": true},
            "evidence": [{"rolloutId": THREAD, "decodedBytes": "5", "completeLfEndByteOffset": "5", "nextOrdinalExclusive": "1"}]
        })
    }

    #[test]
    fn strict_protocol_composes_one_selected_source() {
        let bytes = serde_json::to_vec(&request()).expect("request");
        let parsed = parse_request(&bytes).expect("parse");
        let result = capture(parsed).expect("consistent");
        assert_eq!(result.kind, "native_codex_paginated_consistency");
        assert_eq!(result.consistency.selected_rollout_id, THREAD);
        assert!(!result.source_authenticated);
        let mut output = Vec::new();
        let parsed = parse_request(&bytes).expect("parse");
        write_frame(&mut output, &parsed, Ok(result)).expect("frame");
        let size = u32::from_be_bytes(output[..4].try_into().expect("length")) as usize;
        let frame: serde_json::Value = serde_json::from_slice(&output[4..4 + size]).expect("json");
        assert_eq!(frame["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(
            frame["result"]["kind"],
            "native_codex_paginated_consistency"
        );
    }

    #[test]
    fn unknown_fields_and_projection_lag_fail_closed() {
        let mut value = request();
        value["extra"] = serde_json::json!(true);
        assert!(parse_request(&serde_json::to_vec(&value).expect("json")).is_err());
        let mut value = request();
        value["projection"]["checkpoint"]["nextRolloutOrdinal"] = serde_json::json!("0");
        let parsed = parse_request(&serde_json::to_vec(&value).expect("json")).expect("parse");
        assert_eq!(
            capture(parsed),
            Err(Error::PaginatedConsistency(
                consistency::Error::ProjectionLagging
            ))
        );
    }
}
