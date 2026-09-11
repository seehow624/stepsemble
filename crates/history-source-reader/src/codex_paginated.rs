//! Owned paginated ancestry resolution entry point.
//!
//! The library modules deliberately stop at a plan and an observation
//! contract. This binary module is the narrow adapter that turns an owned
//! request into that plan, opens every planned rollout through the existing
//! POSIX Codex boundary, and only then calls the library resolver. It is not a
//! HOME scanner, a native resume path, or a source-authentication grant.
use crate::{Error, RootIdentity, codex};
use serde::{Deserialize, Serialize};
use std::io::Write;
use stepsemble_history_source_reader::{
    codex_locator, codex_paginated_ancestry as ancestry, codex_paginated_chain as chain_plan,
    codex_paginated_chain::Plan, codex_paginated_resolution as resolution, jsonl_scan,
};

/// The request includes up to one bounded metadata record per planned source.
/// Keeping this separate from the legacy 12 KiB request limit prevents a
/// malformed chain from being silently truncated while still bounding input.
pub(crate) const INPUT_LIMIT: usize = 16 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 64 * 1024;
const PROTOCOL_VERSION: u8 = 15;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    protocol_version: u8,
    nonce: String,
    native_version: String,
    codex_root: String,
    expected_root: RootIdentity,
    thread_id: String,
    selected_rollout_id: String,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    rollout_id: String,
    base64_record: String,
    rollout_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Success {
    kind: &'static str,
    native_version: String,
    thread_id: String,
    expected_root: RootIdentity,
    plan: Plan,
    resolution: resolution::Resolution,
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

fn valid_root(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 8192
        && value
            .as_bytes()
            .iter()
            .all(|byte| *byte >= 32 && *byte != 127 && !b"*?[]{},".contains(byte))
}

fn valid_entry_shape(entry: &Entry) -> bool {
    !entry.rollout_id.is_empty()
        && codex_locator::session_id(&entry.rollout_id)
        && entry.base64_record.len() <= 4 * (jsonl_scan::RECORD_BYTES.div_ceil(3))
        && !entry.base64_record.is_empty()
        && entry
            .base64_record
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
        && !entry.rollout_path.is_empty()
        && entry.rollout_path.len() <= 160
}

/// Strict standard-base64 decoder. Padding is accepted only in the final
/// quartet and unused low bits must be zero, so two spellings cannot represent
/// different records in the chain input.
fn decode_base64(value: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    for (quartet_index, chunk) in bytes.chunks_exact(4).enumerate() {
        let final_quartet = quartet_index + 1 == bytes.len() / 4;
        let mut values = [0_u8; 4];
        let mut padding = 0_u8;
        for (index, byte) in chunk.iter().copied().enumerate() {
            if byte == b'=' {
                if index < 2 || !final_quartet {
                    return None;
                }
                padding += 1;
                values[index] = 0;
            } else {
                if padding != 0 {
                    return None;
                }
                values[index] = TABLE.iter().position(|candidate| *candidate == byte)? as u8;
            }
        }
        if padding > 2 || (padding == 1 && chunk[3] != b'=') {
            return None;
        }
        if padding == 2 && (chunk[2] != b'=' || values[1] & 0x0f != 0) {
            return None;
        }
        if padding == 1 && values[2] & 0x03 != 0 {
            return None;
        }
        output.push((values[0] << 2) | (values[1] >> 4));
        if padding < 2 {
            output.push((values[1] << 4) | (values[2] >> 2));
        }
        if padding == 0 {
            output.push((values[2] << 6) | values[3]);
        }
    }
    Some(output)
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if request.protocol_version != PROTOCOL_VERSION
        || !hex_nonce(&request.nonce)
        || request.native_version != codex::NATIVE_VERSION
        || !valid_root(&request.codex_root)
        || !crate::decimal(&request.expected_root.device, false)
        || !crate::decimal(&request.expected_root.inode, true)
        || !codex_locator::session_id(&request.thread_id)
        || !codex_locator::session_id(&request.selected_rollout_id)
        || request.entries.is_empty()
        || request.entries.len() > ancestry::MAX_DEPTH
        || request
            .entries
            .iter()
            .any(|entry| !valid_entry_shape(entry))
    {
        return Err(Error::Input);
    }
    Ok(request)
}

fn make_plan(request: &Request) -> Result<Plan, Error> {
    let mut claims = Vec::with_capacity(request.entries.len());
    for (index, entry) in request.entries.iter().enumerate() {
        let bytes = decode_base64(&entry.base64_record).ok_or(Error::Input)?;
        if bytes.is_empty() || bytes.len() > jsonl_scan::RECORD_BYTES {
            return Err(Error::Input);
        }
        // The newest entry is selected by the stable thread ID. Its physical
        // rollout ID may differ after a revert; ancestor metadata is keyed by
        // its own physical rollout ID.
        let metadata_id = if index == 0 {
            request.thread_id.clone()
        } else {
            codex_locator::stable_thread_id(&entry.rollout_path).ok_or(Error::Input)?
        };
        claims.push(
            ancestry::read_claim_with_metadata_id(&metadata_id, &entry.rollout_id, &bytes)
                .map_err(Error::PaginatedAncestry)?,
        );
    }
    let chain = ancestry::link(claims).map_err(Error::PaginatedAncestry)?;
    let locators: Vec<_> = request
        .entries
        .iter()
        .map(|entry| chain_plan::Locator {
            rollout_id: &entry.rollout_id,
            rollout_path: &entry.rollout_path,
        })
        .collect();
    chain_plan::plan(
        &request.thread_id,
        &request.selected_rollout_id,
        &chain,
        &locators,
    )
    .map_err(Error::PaginatedChain)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_and_resolve(request: &Request, plan: &Plan) -> Result<resolution::Resolution, Error> {
    let mut observations = Vec::with_capacity(plan.sources.len());
    let mut consumed_stored = 0_u64;
    let mut consumed_decoded = 0_u64;
    for (index, source) in plan.sources.iter().enumerate() {
        let remaining_stored = chain_plan::CHAIN_BYTES
            .checked_sub(consumed_stored)
            .ok_or(Error::PaginatedChainBytesExceeded)?;
        let remaining_decoded = chain_plan::CHAIN_DECODED_BYTES
            .checked_sub(consumed_decoded)
            .ok_or(Error::PaginatedChainDecodedBytesExceeded)?;
        if remaining_stored == 0 {
            return Err(Error::PaginatedChainBytesExceeded);
        }
        if remaining_decoded == 0 {
            return Err(Error::PaginatedChainDecodedBytesExceeded);
        }
        // Every source is parsed by native using the stable thread prefix in
        // its locator. A reverted source can therefore differ from its
        // physical chain ID whether it is the head or an ancestor.
        let source_thread = if index + 1 == plan.sources.len() {
            plan.thread_id.clone()
        } else {
            codex_locator::stable_thread_id(&source.rollout_path).ok_or(Error::Input)?
        };
        let expected_entry = request
            .entries
            .iter()
            .find(|entry| entry.rollout_id == source.rollout_id)
            .ok_or(Error::Input)?;
        let expected_first = decode_base64(&expected_entry.base64_record).ok_or(Error::Input)?;
        let native_request = codex::Request {
            protocol_version: 9,
            nonce: request.nonce.clone(),
            native_version: request.native_version.clone(),
            source: codex::Source {
                codex_root: request.codex_root.clone(),
                rollout_path: source.rollout_path.clone(),
                thread_id: source_thread,
            },
            expected_root: RootIdentity {
                device: request.expected_root.device.clone(),
                inode: request.expected_root.inode.clone(),
            },
        };
        let observed = crate::posix::codex::capture_paginated_source_checked(
            &native_request,
            &source.rollout_id,
            Some(&expected_first),
            source.compressed,
            remaining_stored,
            Some(remaining_decoded),
            source
                .end_ordinal_exclusive
                .as_deref()
                .zip(source.end_byte_offset.as_deref()),
        )?;
        consumed_stored = chain_plan::accumulate(consumed_stored, observed.stored_bytes)
            .map_err(|_| Error::PaginatedChainBytesExceeded)?;
        consumed_decoded = chain_plan::accumulate_decoded(consumed_decoded, observed.decoded_bytes)
            .map_err(|_| Error::PaginatedChainDecodedBytesExceeded)?;
        observations.push(observed);
    }
    resolution::resolve(plan, &observations).map_err(Error::PaginatedResolution)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_and_resolve(_request: &Request, _plan: &Plan) -> Result<resolution::Resolution, Error> {
    Err(Error::PlatformUnsupported)
}

pub fn capture(request: &Request) -> Result<Success, Error> {
    let plan = make_plan(request)?;
    let resolved = open_and_resolve(request, &plan)?;
    Ok(Success {
        kind: "native_codex_paginated_resolution",
        native_version: request.native_version.clone(),
        thread_id: request.thread_id.clone(),
        expected_root: RootIdentity {
            device: request.expected_root.device.clone(),
            inode: request.expected_root.inode.clone(),
        },
        plan,
        resolution: resolved,
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::fs;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::path::Path;

    const ID: &str = "11111111-1111-4111-8111-111111111111";

    fn request() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "nonce": "a".repeat(64),
            "nativeVersion": codex::NATIVE_VERSION,
            "codexRoot": "/owned/codex",
            "expectedRoot": {"device":"1", "inode":"2"},
            "threadId": ID,
            "selectedRolloutId": ID,
            "entries": [{
                "rolloutId": ID,
                "base64Record": "eyJ0eXBlIjoic2Vzc2lvbl9tZXRhIiwicGF5bG9hZCI6eyJpZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsImhpc3RvcnlfbW9kZSI6InBhZ2luYXRlZCJ9fQo=",
                "rolloutPath": format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{ID}.jsonl")
            }]
        })
    }

    #[test]
    fn request_shape_is_strict_and_base64_is_canonical() {
        let value = request();
        let bytes = serde_json::to_vec(&value).expect("fixture");
        assert!(parse_request(&bytes).is_ok());
        assert_eq!(decode_base64("Zg=="), Some(b"f".to_vec()));
        assert_eq!(decode_base64("Zh=="), None);
        assert_eq!(decode_base64("Zm8="), Some(b"fo".to_vec()));
        assert_eq!(decode_base64("Zm9v"), Some(b"foo".to_vec()));
        for (key, invalid) in [
            ("protocolVersion", serde_json::json!(14)),
            ("nativeVersion", serde_json::json!("latest")),
            ("entries", serde_json::json!([])),
            ("extra", serde_json::json!(true)),
        ] {
            let mut changed = value.clone();
            changed[key] = invalid;
            assert!(parse_request(&serde_json::to_vec(&changed).expect("fixture")).is_err());
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn base64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut output = String::new();
        for chunk in bytes.chunks(3) {
            let a = chunk[0];
            let b = chunk.get(1).copied().unwrap_or(0);
            let c = chunk.get(2).copied().unwrap_or(0);
            output.push(TABLE[(a >> 2) as usize] as char);
            output.push(TABLE[((a & 0x03) << 4 | b >> 4) as usize] as char);
            output.push(if chunk.len() > 1 {
                TABLE[((b & 0x0f) << 2 | c >> 6) as usize] as char
            } else {
                '='
            });
            output.push(if chunk.len() > 2 {
                TABLE[(c & 0x3f) as usize] as char
            } else {
                '='
            });
        }
        output
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn metadata_record(id: &str, base: Option<(&str, usize, usize)>) -> Vec<u8> {
        metadata_record_with_id(id, base)
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn metadata_record_with_id(metadata_id: &str, base: Option<(&str, usize, usize)>) -> Vec<u8> {
        let history_base = base.map(|(thread_id, ordinal, offset)| {
            serde_json::json!({
                "thread_id": thread_id,
                "end_ordinal_exclusive": ordinal,
                "end_byte_offset": offset,
            })
        });
        let mut payload = serde_json::json!({
            "id": metadata_id,
            "history_mode": "paginated",
        });
        if let Some(history_base) = history_base {
            payload["history_base"] = history_base;
        }
        format!(
            "{}\n",
            serde_json::json!({
                "ordinal": base.map_or(0, |(_, ordinal, _)| ordinal),
                "type":"session_meta",
                "payload":payload
            })
        )
        .into_bytes()
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn event_record(ordinal: usize, kind: &str) -> Vec<u8> {
        format!(
            "{{\"ordinal\":{ordinal},\"type\":\"event_msg\",\"payload\":{{\"type\":\"{kind}\"}}}}\n"
        )
        .into_bytes()
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn set_owned(path: &Path, directory: bool) {
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )
        .expect("owned fixture mode");
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn opens_every_planned_source_plain_and_compressed_before_resolving() {
        const CHILD: &str = "22222222-2222-4222-8222-222222222222";
        const OLD: &str = "99999999-9999-4999-8999-999999999999";
        let temp = tempfile::tempdir().expect("owned temp");
        let root = fs::canonicalize(temp.path())
            .expect("canonical temp")
            .join("codex");
        let active = root.join("sessions/2026/01/05");
        let archive = root.join("archived_sessions");
        fs::create_dir_all(&active).expect("active dirs");
        fs::create_dir_all(&archive).expect("archive dir");
        for directory in [root.as_path(), root.join("sessions").as_path()] {
            set_owned(directory, true);
        }
        for directory in [
            root.join("sessions/2026").as_path(),
            root.join("sessions/2026/01").as_path(),
            active.as_path(),
            archive.as_path(),
        ] {
            set_owned(directory, true);
        }
        let old_prefix = metadata_record(OLD, None);
        let old_event = event_record(1, "user_message");
        let old_event_2 = event_record(2, "user_message");
        let old_raw = [
            old_prefix.as_slice(),
            old_event.as_slice(),
            old_event_2.as_slice(),
        ]
        .concat();
        let cutoff = old_prefix.len() + old_event.len();
        let child_meta = metadata_record(CHILD, Some((OLD, 2, cutoff)));
        let child_event = event_record(3, "agent_message");
        let child_raw = [child_meta.as_slice(), child_event.as_slice()].concat();
        let child_path = active.join(format!("rollout-2026-01-05T12-00-00-{CHILD}.jsonl"));
        let old_path = archive.join(format!("rollout-2026-01-05T11-00-00-{OLD}.jsonl"));
        fs::write(&child_path, &child_raw).expect("child source");
        // The plan intentionally points at the compressed archived sibling;
        // no plain file with this rollout name exists.
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).expect("zstd");
        use std::io::Write;
        encoder.write_all(&old_raw).expect("zstd source");
        let old_compressed = encoder.finish().expect("zstd finish");
        let old_compressed_path = old_path.with_extension("jsonl.zst");
        fs::write(&old_compressed_path, &old_compressed).expect("compressed source");
        set_owned(&child_path, false);
        set_owned(&old_compressed_path, false);

        let root_info = fs::metadata(&root).expect("root metadata");
        let child_locator =
            format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{CHILD}.jsonl");
        let old_locator = format!("archived_sessions/rollout-2026-01-05T11-00-00-{OLD}.jsonl.zst");
        let mut request = Request {
            protocol_version: PROTOCOL_VERSION,
            nonce: "a".repeat(64),
            native_version: codex::NATIVE_VERSION.into(),
            codex_root: root.to_str().expect("utf8 root").into(),
            expected_root: RootIdentity {
                device: root_info.dev().to_string(),
                inode: root_info.ino().to_string(),
            },
            thread_id: CHILD.into(),
            selected_rollout_id: CHILD.into(),
            entries: vec![
                Entry {
                    rollout_id: CHILD.into(),
                    base64_record: base64(&child_meta),
                    rollout_path: child_locator,
                },
                Entry {
                    rollout_id: OLD.into(),
                    base64_record: base64(&old_prefix),
                    rollout_path: old_locator,
                },
            ],
        };
        let plan = make_plan(&request).expect("owned paginated plan");
        let resolved = open_and_resolve(&request, &plan).expect("all sources opened");
        assert_eq!(resolved.sources.len(), 2);
        assert_eq!(resolved.sources[0].rollout_id, OLD);
        assert!(resolved.sources[0].compressed);
        assert!(resolved.sources[0].archived);
        assert_eq!(resolved.sources[0].decoded_bytes, old_raw.len().to_string());
        let old_decoded = old_raw.len().to_string();
        assert_eq!(
            resolved.sources[0].complete_lf_end_byte_offset.as_deref(),
            Some(old_decoded.as_str())
        );
        assert_eq!(
            resolved.sources[0].next_ordinal_exclusive.as_deref(),
            Some("3")
        );
        assert_eq!(
            resolved.sources[0].stored_bytes,
            old_compressed.len().to_string()
        );
        assert_eq!(resolved.sources[0].record_count, 3);
        assert_eq!(
            resolved.sources[0].end_ordinal_exclusive.as_deref(),
            Some("2")
        );
        assert_eq!(resolved.sources[1].rollout_id, CHILD);
        assert!(!resolved.sources[1].compressed);
        assert_eq!(
            resolved.sources[1].decoded_bytes,
            child_raw.len().to_string()
        );
        let child_decoded = child_raw.len().to_string();
        assert_eq!(
            resolved.sources[1].complete_lf_end_byte_offset.as_deref(),
            Some(child_decoded.as_str())
        );
        assert_eq!(
            resolved.sources[1].next_ordinal_exclusive.as_deref(),
            Some("4")
        );
        assert_eq!(
            resolved.chain_stored_bytes,
            (old_compressed.len() + child_raw.len()).to_string()
        );
        assert!(!resolved.source_authenticated);
        assert!(!resolved.history_complete);

        // A stale caller record must not be accepted merely because the
        // physical file still passes the opaque byte scanner. The semantic
        // claim is equivalent, but its bytes intentionally differ.
        let value: serde_json::Value = serde_json::from_slice(&child_meta).expect("metadata");
        let equivalent = format!(
            "{}\n",
            serde_json::to_string_pretty(&value).expect("pretty metadata")
        );
        request.entries[0].base64_record = base64(equivalent.as_bytes());
        assert_eq!(open_and_resolve(&request, &plan), Err(Error::Changed));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn opens_a_reverted_head_using_stable_metadata_and_physical_locator_id() {
        const STABLE: &str = "33333333-3333-4333-8333-333333333333";
        const PHYSICAL: &str = "44444444-4444-4444-8444-444444444444";
        const OLD: &str = "99999999-9999-4999-8999-999999999999";
        let temp = tempfile::tempdir().expect("owned temp");
        let root = fs::canonicalize(temp.path())
            .expect("canonical temp")
            .join("codex");
        let active = root.join("sessions/2026/01/05");
        let archive = root.join("archived_sessions");
        fs::create_dir_all(&active).expect("active dirs");
        fs::create_dir_all(&archive).expect("archive dir");
        for directory in [
            root.as_path(),
            root.join("sessions").as_path(),
            root.join("sessions/2026").as_path(),
            root.join("sessions/2026/01").as_path(),
            active.as_path(),
            archive.as_path(),
        ] {
            set_owned(directory, true);
        }
        let old_meta = metadata_record(OLD, None);
        let old_event = event_record(1, "root");
        let old_raw = [old_meta.as_slice(), old_event.as_slice()].concat();
        let head_meta = metadata_record_with_id(STABLE, Some((OLD, 2, old_raw.len())));
        let head_event = event_record(3, "reverted");
        let head_raw = [head_meta.as_slice(), head_event.as_slice()].concat();
        let old_path = active.join(format!("rollout-2026-01-05T11-00-00-{OLD}.jsonl"));
        let head_path = archive.join(format!(
            "rollout-2026-01-05T12-00-00-{STABLE}_{PHYSICAL}.jsonl"
        ));
        fs::write(&old_path, &old_raw).expect("old source");
        fs::write(&head_path, &head_raw).expect("reverted source");
        set_owned(&old_path, false);
        set_owned(&head_path, false);

        let root_info = fs::metadata(&root).expect("root metadata");
        let old_locator = format!("sessions/2026/01/05/rollout-2026-01-05T11-00-00-{OLD}.jsonl");
        let head_locator =
            format!("archived_sessions/rollout-2026-01-05T12-00-00-{STABLE}_{PHYSICAL}.jsonl");
        let request = Request {
            protocol_version: PROTOCOL_VERSION,
            nonce: "a".repeat(64),
            native_version: codex::NATIVE_VERSION.into(),
            codex_root: root.to_str().expect("utf8 root").into(),
            expected_root: RootIdentity {
                device: root_info.dev().to_string(),
                inode: root_info.ino().to_string(),
            },
            thread_id: STABLE.into(),
            selected_rollout_id: PHYSICAL.into(),
            entries: vec![
                Entry {
                    rollout_id: PHYSICAL.into(),
                    base64_record: base64(&head_meta),
                    rollout_path: head_locator,
                },
                Entry {
                    rollout_id: OLD.into(),
                    base64_record: base64(&old_meta),
                    rollout_path: old_locator,
                },
            ],
        };
        let plan = make_plan(&request).expect("reverted plan");
        assert_eq!(plan.sources[0].rollout_id, OLD);
        assert_eq!(plan.sources[1].rollout_id, PHYSICAL);
        assert!(plan.sources[1].archived);
        assert_eq!(
            plan.sources[1].rollout_path,
            format!("archived_sessions/rollout-2026-01-05T12-00-00-{STABLE}_{PHYSICAL}.jsonl")
        );
        let resolved = open_and_resolve(&request, &plan).expect("reverted source opened");
        assert_eq!(resolved.sources[1].rollout_id, PHYSICAL);
        assert_eq!(resolved.thread_id, STABLE);
        assert!(!resolved.source_authenticated);
        assert!(!resolved.history_complete);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn opens_an_ancestor_revert_with_its_stable_locator_prefix() {
        const HEAD: &str = "11111111-1111-4111-8111-111111111111";
        const ANCESTOR_STABLE: &str = "22222222-2222-4222-8222-222222222222";
        const ANCESTOR_PHYSICAL: &str = "33333333-3333-4333-8333-333333333333";
        const ROOT: &str = "99999999-9999-4999-8999-999999999999";
        let temp = tempfile::tempdir().expect("owned temp");
        let root = fs::canonicalize(temp.path())
            .expect("canonical temp")
            .join("codex");
        let active = root.join("sessions/2026/01/05");
        let archive = root.join("archived_sessions");
        fs::create_dir_all(&active).expect("active dirs");
        fs::create_dir_all(&archive).expect("archive dir");
        for directory in [
            root.as_path(),
            root.join("sessions").as_path(),
            root.join("sessions/2026").as_path(),
            root.join("sessions/2026/01").as_path(),
            active.as_path(),
            archive.as_path(),
        ] {
            set_owned(directory, true);
        }

        // Root contributes ordinals [0, 3); the reverted ancestor starts at
        // ordinal 3 and contributes [3, 5); the selected head starts at 5.
        let root_meta = metadata_record(ROOT, None);
        let root_event = event_record(1, "root");
        let root_event_2 = event_record(2, "root_more");
        let root_raw = [
            root_meta.as_slice(),
            root_event.as_slice(),
            root_event_2.as_slice(),
        ]
        .concat();
        let ancestor_meta =
            metadata_record_with_id(ANCESTOR_STABLE, Some((ROOT, 3, root_raw.len())));
        let ancestor_event = event_record(4, "ancestor");
        let ancestor_prefix = [ancestor_meta.as_slice(), ancestor_event.as_slice()].concat();
        let head_meta =
            metadata_record_with_id(HEAD, Some((ANCESTOR_PHYSICAL, 5, ancestor_prefix.len())));
        let head_event = event_record(6, "head");
        let head_raw = [head_meta.as_slice(), head_event.as_slice()].concat();

        let root_path = active.join(format!("rollout-2026-01-05T10-00-00-{ROOT}.jsonl"));
        let ancestor_path = archive.join(format!(
            "rollout-2026-01-05T11-00-00-{ANCESTOR_STABLE}_{ANCESTOR_PHYSICAL}.jsonl"
        ));
        let head_path = active.join(format!("rollout-2026-01-05T12-00-00-{HEAD}.jsonl"));
        fs::write(&root_path, &root_raw).expect("root source");
        fs::write(&ancestor_path, &ancestor_prefix).expect("ancestor source");
        fs::write(&head_path, &head_raw).expect("head source");
        for file in [&root_path, &ancestor_path, &head_path] {
            set_owned(file, false);
        }

        let root_info = fs::metadata(&root).expect("root metadata");
        let root_locator = format!("sessions/2026/01/05/rollout-2026-01-05T10-00-00-{ROOT}.jsonl");
        let ancestor_locator = format!(
            "archived_sessions/rollout-2026-01-05T11-00-00-{ANCESTOR_STABLE}_{ANCESTOR_PHYSICAL}.jsonl"
        );
        let head_locator = format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{HEAD}.jsonl");
        let request = Request {
            protocol_version: PROTOCOL_VERSION,
            nonce: "a".repeat(64),
            native_version: codex::NATIVE_VERSION.into(),
            codex_root: root.to_str().expect("utf8 root").into(),
            expected_root: RootIdentity {
                device: root_info.dev().to_string(),
                inode: root_info.ino().to_string(),
            },
            thread_id: HEAD.into(),
            selected_rollout_id: HEAD.into(),
            entries: vec![
                Entry {
                    rollout_id: HEAD.into(),
                    base64_record: base64(&head_meta),
                    rollout_path: head_locator,
                },
                Entry {
                    rollout_id: ANCESTOR_PHYSICAL.into(),
                    base64_record: base64(&ancestor_meta),
                    rollout_path: ancestor_locator,
                },
                Entry {
                    rollout_id: ROOT.into(),
                    base64_record: base64(&root_meta),
                    rollout_path: root_locator,
                },
            ],
        };
        let plan = make_plan(&request).expect("ancestor revert plan");
        assert_eq!(
            plan.sources
                .iter()
                .map(|source| source.rollout_id.as_str())
                .collect::<Vec<_>>(),
            vec![ROOT, ANCESTOR_PHYSICAL, HEAD]
        );
        assert!(plan.sources[1].archived);
        let resolved = open_and_resolve(&request, &plan).expect("ancestor revert opened");
        assert_eq!(
            resolved
                .sources
                .iter()
                .map(|source| source.rollout_id.as_str())
                .collect::<Vec<_>>(),
            vec![ROOT, ANCESTOR_PHYSICAL, HEAD]
        );
        assert!(resolved.sources[1].archived);
        assert!(resolved.ordinal_cutoffs_verified);
        assert_eq!(resolved.thread_id, HEAD);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn missing_planned_rollout_is_an_explicit_source_error() {
        const CHILD: &str = "22222222-2222-4222-8222-222222222222";
        let temp = tempfile::tempdir().expect("owned temp");
        let root = fs::canonicalize(temp.path())
            .expect("canonical temp")
            .join("codex");
        let directory = root.join("sessions/2026/01/05");
        fs::create_dir_all(&directory).expect("owned dirs");
        let record = metadata_record(CHILD, None);
        let info = fs::metadata(&root).expect("root metadata");
        let path = "sessions/2026/01/05/rollout-2026-01-05T12-00-00-22222222-2222-4222-8222-222222222222.jsonl";
        let request = Request {
            protocol_version: PROTOCOL_VERSION,
            nonce: "a".repeat(64),
            native_version: codex::NATIVE_VERSION.into(),
            codex_root: root.to_str().expect("utf8 root").into(),
            expected_root: RootIdentity {
                device: info.dev().to_string(),
                inode: info.ino().to_string(),
            },
            thread_id: CHILD.into(),
            selected_rollout_id: CHILD.into(),
            entries: vec![Entry {
                rollout_id: CHILD.into(),
                base64_record: base64(&record),
                rollout_path: path.into(),
            }],
        };
        let plan = make_plan(&request).expect("plan");
        assert_eq!(open_and_resolve(&request, &plan), Err(Error::Missing));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn protocol15_rejects_matching_source_and_metadata_with_wrong_root_ordinal() {
        const ID: &str = "55555555-5555-4555-8555-555555555555";
        let temp = tempfile::tempdir().expect("owned temp");
        let root = fs::canonicalize(temp.path())
            .expect("canonical temp")
            .join("codex");
        let directory = root.join("sessions/2026/01/05");
        fs::create_dir_all(&directory).expect("owned dirs");
        for directory in [
            root.as_path(),
            root.join("sessions").as_path(),
            root.join("sessions/2026").as_path(),
            root.join("sessions/2026/01").as_path(),
            directory.as_path(),
        ] {
            set_owned(directory, true);
        }
        let wrong = serde_json::json!({
            "ordinal": 100,
            "type": "session_meta",
            "payload": {"id": ID, "history_mode": "paginated"},
        });
        let raw = format!("{wrong}\n").into_bytes();
        let path = format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{ID}.jsonl");
        let file = root.join(&path);
        fs::write(&file, &raw).expect("matching owned source");
        set_owned(&file, false);
        let root_info = fs::metadata(&root).expect("root metadata");
        let input = serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "nonce": "a".repeat(64),
            "nativeVersion": codex::NATIVE_VERSION,
            "codexRoot": root,
            "expectedRoot": {"device": root_info.dev().to_string(), "inode": root_info.ino().to_string()},
            "threadId": ID,
            "selectedRolloutId": ID,
            "entries": [{
                "rolloutId": ID,
                "base64Record": base64(&raw),
                "rolloutPath": path,
            }],
        });
        let request = parse_request(&serde_json::to_vec(&input).expect("protocol15 request"))
            .expect("request shape");
        assert!(matches!(
            capture(&request),
            Err(Error::PaginatedAncestry(ancestry::Error::InvalidOrdinal))
        ));
    }
}
