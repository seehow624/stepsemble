//! Private v10 byte scan / v11 validated page / v12 selected global structure,
//! plus v13/v14 compressed equivalents with separate physical/decoded proofs.
//! None is native projection parity, a source grant or public history API.
use crate::{Capture, Error, INPUT_LIMIT, Identity, RootIdentity, codex};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use stepsemble_history_source_reader::{codex_rollout_structure, jsonl_scan};
const STRUCTURE_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRequest {
    protocol_version: u8,
    nonce: String,
    native_version: String,
    source: codex::Source,
    expected_root: RootIdentity,
    page: Selection,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    offset: u32,
    limit: u32,
}

pub struct Request {
    pub base: codex::Request,
    pub page: jsonl_scan::Selection,
    pub protocol_version: u8,
}
pub struct Pair {
    pub page: jsonl_scan::Page,
    pub rollout_identity: Identity,
    pub name_index: Option<Capture>,
    pub physical_path: String,
    pub validation: Option<stepsemble_history_source_reader::codex_rollout_format::Validation>,
    pub structure: Option<codex_rollout_structure::Structure>,
    pub physical_sha256: Option<[u8; 32]>,
    pub decoded_frames: Option<u32>,
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    // Deserialize once into exact structs BEFORE rebuilding the common input:
    // duplicate/unknown/null/extra fields must not disappear in a Value map.
    let r: WireRequest = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if ![10, 11, 12, 13, 14].contains(&r.protocol_version)
        || r.page.offset > jsonl_scan::RECORDS
        || r.page.limit == 0
        || r.page.limit > jsonl_scan::PAGE_RECORDS
    {
        return Err(Error::Input);
    }
    // Reuse the legacy selected-locator/native-version/root/nonce validation.
    // The internal base requests stored selection; output keeps its explicit version.
    let base = serde_json::to_vec(&serde_json::json!({"protocolVersion":9,"nonce":r.nonce,
        "nativeVersion":r.native_version,"source":{"codexRoot":r.source.codex_root,
        "threadId":r.source.thread_id,"rolloutPath":r.source.rollout_path},
        "expectedRoot":{"device":r.expected_root.device,"inode":r.expected_root.inode}}))
    .map_err(|_| Error::Input)?;
    Ok(Request {
        base: codex::parse_request(&base)?,
        protocol_version: r.protocol_version,
        page: jsonl_scan::Selection {
            offset: r.page.offset,
            limit: r.page.limit,
        },
    })
}

pub fn capture(request: &Request) -> Result<Pair, Error> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if request.protocol_version == 14 {
            crate::posix::codex::capture_compressed_structured(&request.base, request.page)
        } else if request.protocol_version == 13 {
            crate::posix::codex::capture_compressed_validated(&request.base, request.page)
        } else if request.protocol_version == 12 {
            crate::posix::codex::capture_structured(&request.base, request.page)
        } else if request.protocol_version == 11 {
            crate::posix::codex::capture_validated(&request.base, request.page)
        } else {
            crate::posix::codex::capture_scanned(&request.base, request.page)
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = request;
        Err(Error::PlatformUnsupported)
    }
}

pub fn write_frame(
    mut output: impl Write,
    request: &Request,
    pair: Result<Pair, Error>,
) -> Result<(), Error> {
    let (result, payload) = match pair {
        Ok(pair) => {
            let compressed = request.protocol_version >= 13;
            let mut payload = Vec::new();
            let mut rows = Vec::new();
            if pair.page.records.len() > request.page.limit as usize
                || pair.page.offset != request.page.offset
                || pair.rollout_identity.size == 0
                || pair.rollout_identity.size > jsonl_scan::SOURCE_BYTES
                || pair.page.summary.byte_length == 0
                || pair.page.summary.byte_length > jsonl_scan::SOURCE_BYTES
                || pair.page.summary.record_count == 0
                || pair.page.summary.record_count > jsonl_scan::RECORDS
                || (!compressed && pair.page.summary.byte_length != pair.rollout_identity.size)
                || pair.validation.is_some() != !matches!(request.protocol_version, 10)
                || pair.structure.is_some() != matches!(request.protocol_version, 12 | 14)
                || pair.physical_sha256.is_some() != compressed
                || pair.decoded_frames.is_some() != compressed
                || compressed != pair.physical_path.ends_with(".zst")
                || pair
                    .decoded_frames
                    .is_some_and(|frames| frames == 0 || frames > 256)
                || pair
                    .validation
                    .as_ref()
                    .is_some_and(|v| v.records_validated != pair.page.summary.record_count)
            {
                return Err(Error::Input);
            }
            for record in &pair.page.records {
                if payload.len() + record.bytes.len() > jsonl_scan::PAGE_BYTES {
                    return Err(Error::TooLarge);
                }
                rows.push(serde_json::json!({"recordIndex":record.record_index,"byteOffset":record.byte_offset,
                    "byteLength":record.bytes.len(),"payloadOffset":payload.len(),
                    "sha256":format!("{:x}",Sha256::digest(&record.bytes))}));
                payload.extend_from_slice(&record.bytes);
            }
            let page_length = payload.len();
            let name_index = if let Some(index) = pair.name_index {
                if index.bytes.len() > codex::INDEX_LIMIT {
                    return Err(Error::TooLarge);
                }
                let descriptor = serde_json::json!({"byteOffset":page_length,"byteLength":index.bytes.len(),
                    "sha256":format!("{:x}",Sha256::digest(&index.bytes)),"identity":index.identity});
                payload.extend_from_slice(&index.bytes);
                Some(descriptor)
            } else {
                None
            };
            let base = &request.base;
            let structure_frame = if let Some(structure) = pair.structure {
                if structure.structure_profile != codex_rollout_structure::PROFILE
                    || structure.total_turns > pair.page.summary.record_count
                    || structure.retained_turns > structure.total_turns
                    || structure.annotations.len() != pair.page.records.len()
                    || structure.turns.len() > structure.annotations.len()
                {
                    return Err(Error::RolloutStructure);
                }
                let bytes = serde_json::to_vec(&structure).map_err(|_| Error::Io)?;
                if bytes.len() > STRUCTURE_BYTES {
                    return Err(Error::TooLarge);
                }
                let descriptor = serde_json::json!({"profile":codex_rollout_structure::PROFILE,
                    "byteOffset":payload.len(),"byteLength":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))});
                payload.extend_from_slice(&bytes);
                Some(descriptor)
            } else {
                None
            };
            let decoded_sha: String = pair
                .page
                .summary
                .sha256
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            let kind = match request.protocol_version {
                14 => "native_codex_compressed_structured_source_page",
                13 => "native_codex_compressed_source_page",
                12 => "native_codex_structured_source_page",
                11 => "native_codex_validated_source_page",
                _ => "native_codex_source_page",
            };
            let storage = if compressed { "zstd" } else { "jsonl" };
            let mut result = serde_json::json!({"kind":kind,"nativeVersion":base.native_version,
                "threadId":base.source.thread_id,"rolloutPath":base.source.rollout_path,
                "rootIdentity":{"device":base.expected_root.device,"inode":base.expected_root.inode},
                "storage":{"encoding":storage,"rolloutPath":pair.physical_path},
                "byteLength":payload.len(),"sha256":format!("{:x}",Sha256::digest(&payload)),
                "page":{"offset":pair.page.offset,"byteLength":page_length,"records":rows,"nextOffset":pair.page.next_offset},
                "nameIndex":name_index,
                "recordSemanticsValidated":false,"semanticHistoryComplete":false,"sourceAuthenticated":false,"publishable":false});
            if compressed {
                let physical_sha: String = pair
                    .physical_sha256
                    .ok_or(Error::Input)?
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                result["physical"] = serde_json::json!({"identity":pair.rollout_identity,
                    "sha256":physical_sha});
                result["decoded"] = serde_json::json!({"byteLength":pair.page.summary.byte_length,
                    "sha256":decoded_sha,"recordCount":pair.page.summary.record_count,
                    "frames":pair.decoded_frames.ok_or(Error::Input)?});
                result["checks"] = serde_json::json!({"owner":"posix_euid_and_mode","acl":"no_extended_acl",
                    "containment":"root_identity_and_openat_nofollow","reads":2,
                    "matchingPhysicalDigests":true,"matchingDecodedDigests":true,"completeCompressedFrames":true,
                    "matchingNameIndexBytes":true,"unchangedObservedIdentity":true,
                    "nameIndexPresenceRechecked":true,"rolloutSelectionRechecked":true});
            } else {
                result["rollout"] = serde_json::json!({"sha256":decoded_sha,
                    "identity":pair.rollout_identity,"recordCount":pair.page.summary.record_count});
                result["checks"] = serde_json::json!({"owner":"posix_euid_and_mode","acl":"no_extended_acl",
                    "containment":"root_identity_and_openat_nofollow","reads":2,
                    "matchingRolloutDigests":true,"matchingNameIndexBytes":true,
                    "unchangedObservedIdentity":true,"nameIndexPresenceRechecked":true,"rolloutSelectionRechecked":true});
            }
            if let Some(validation) = pair.validation {
                result["validation"] = serde_json::to_value(validation).map_err(|_| Error::Io)?;
            }
            if let Some(structure_frame) = structure_frame {
                result["structureFrame"] = structure_frame;
            }
            (result, payload)
        }
        Err(error) => (
            serde_json::json!({"kind":"source_unavailable","code":error.code()}),
            Vec::new(),
        ),
    };
    let header = serde_json::to_vec(
        &serde_json::json!({"protocolVersion":request.protocol_version,"nonce":request.base.nonce,"result":result}),
    )
    .map_err(|_| Error::Io)?;
    if header.len() > 16 * 1024 {
        return Err(Error::TooLarge);
    }
    output
        .write_all(&(header.len() as u32).to_be_bytes())
        .map_err(|_| Error::Io)?;
    for bytes in [&header, &payload] {
        output.write_all(bytes).map_err(|_| Error::Io)?;
    }
    output.flush().map_err(|_| Error::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> serde_json::Value {
        let id = "11111111-1111-4111-8111-111111111111";
        serde_json::json!({"protocolVersion":10,"nonce":"a".repeat(64),"nativeVersion":codex::NATIVE_VERSION,
            "source":{"codexRoot":"/owned/source","threadId":id,
            "rolloutPath":format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{id}.jsonl")},
            "expectedRoot":{"device":"1","inode":"2"},"page":{"offset":0,"limit":50}})
    }
    #[test]
    fn validated_protocol_is_explicit_and_errors_do_not_claim_a_validation_receipt() {
        let mut value = input();
        value["protocolVersion"] = serde_json::json!(11);
        let request = parse_request(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(request.protocol_version, 11);
        let mut frame = Vec::new();
        write_frame(
            &mut frame,
            &request,
            Err(Error::RolloutFormat(
                stepsemble_history_source_reader::codex_rollout_format::Error::InvalidMetadata,
            )),
        )
        .unwrap();
        let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(length + 4, frame.len());
        let header: serde_json::Value = serde_json::from_slice(&frame[4..]).unwrap();
        assert_eq!(header["protocolVersion"], 11);
        assert_eq!(
            header["result"],
            serde_json::json!({"kind":"source_unavailable","code":"rollout_invalid_metadata"})
        );
        for version in [13, 14] {
            value["protocolVersion"] = serde_json::json!(version);
            assert_eq!(
                parse_request(&serde_json::to_vec(&value).unwrap())
                    .unwrap()
                    .protocol_version,
                version
            );
        }
        value["protocolVersion"] = serde_json::json!(15);
        assert!(parse_request(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    #[test]
    fn separate_exact_v10_request_reuses_the_existing_source_scope() {
        let base = input();
        let bytes = serde_json::to_vec(&base).unwrap();
        assert!(parse_request(&bytes).is_ok());
        assert!(codex::parse_request(&bytes).is_err());
        for (key, value) in [
            ("protocolVersion", serde_json::json!(9)),
            ("nativeVersion", serde_json::json!("latest")),
            ("nonce", serde_json::json!("bad")),
            ("page", serde_json::json!(null)),
            ("page", serde_json::json!({"offset":0,"limit":0})),
            ("page", serde_json::json!({"offset":0,"limit":51})),
            ("page", serde_json::json!({"offset":262145,"limit":1})),
            ("page", serde_json::json!({"offset":-1,"limit":1})),
            (
                "page",
                serde_json::json!({"offset":0,"limit":1,"extra":true}),
            ),
            ("args", serde_json::json!([])),
        ] {
            let mut v = base.clone();
            v[key] = value;
            assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
        }
        let json = serde_json::to_string(&base).unwrap();
        for bytes in [
            format!("\u{feff}{json}"),
            format!("{json}{{}}"),
            json.replacen("\"offset\":0", "\"offset\":0,\"offset\":1", 1),
            json.replacen("\"source\":{", "\"source\":{\"threadId\":\"bad\",", 1),
            json.replacen("\"nonce\":", "\"nonce\":\"bad\",\"nonce\":", 1),
        ] {
            assert!(parse_request(bytes.as_bytes()).is_err());
        }
    }
    #[test]
    fn unavailable_v10_frame_is_bounded_and_contains_no_source_or_page_bytes() {
        let r = parse_request(&serde_json::to_vec(&input()).unwrap()).unwrap();
        for error in [
            Error::Changed,
            Error::RecordLimit,
            Error::IncompleteTail,
            Error::CloseFailed,
            Error::PlatformUnsupported,
        ] {
            let mut frame = Vec::new();
            write_frame(&mut frame, &r, Err(error)).unwrap();
            let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
            assert_eq!(frame.len(), length + 4);
            let header: serde_json::Value = serde_json::from_slice(&frame[4..]).unwrap();
            assert_eq!(header["protocolVersion"], 10);
            assert_eq!(header["nonce"], "a".repeat(64));
            assert_eq!(
                header["result"],
                serde_json::json!({"kind":"source_unavailable","code":error.code()})
            );
        }
    }
}
