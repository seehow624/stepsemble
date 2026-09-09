//! Private v10, byte-framed selected page + full-source digest observation.
//! Not a JSON/native semantic validator, source grant or public history API.
use crate::{Capture, Error, INPUT_LIMIT, Identity, RootIdentity, codex};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use stepsemble_history_source_reader::jsonl_scan;

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
}
pub struct Pair {
    pub page: jsonl_scan::Page,
    pub rollout_identity: Identity,
    pub name_index: Option<Capture>,
    pub physical_path: String,
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    // Deserialize once into exact structs BEFORE rebuilding the common input:
    // duplicate/unknown/null/extra fields must not disappear in a Value map.
    let r: WireRequest = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if r.protocol_version != 10
        || r.page.offset > jsonl_scan::RECORDS
        || r.page.limit == 0
        || r.page.limit > jsonl_scan::PAGE_RECORDS
    {
        return Err(Error::Input);
    }
    // Reuse the legacy selected-locator/native-version/root/nonce validation.
    // The internal base requests stored selection; the output is ONLY v10.
    let base = serde_json::to_vec(&serde_json::json!({"protocolVersion":9,"nonce":r.nonce,
        "nativeVersion":r.native_version,"source":{"codexRoot":r.source.codex_root,
        "threadId":r.source.thread_id,"rolloutPath":r.source.rollout_path},
        "expectedRoot":{"device":r.expected_root.device,"inode":r.expected_root.inode}}))
    .map_err(|_| Error::Input)?;
    Ok(Request {
        base: codex::parse_request(&base)?,
        page: jsonl_scan::Selection {
            offset: r.page.offset,
            limit: r.page.limit,
        },
    })
}

pub fn capture(request: &Request) -> Result<Pair, Error> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        crate::posix::codex::capture_scanned(&request.base, request.page)
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
            let mut payload = Vec::new();
            let mut rows = Vec::new();
            if pair.page.records.len() > request.page.limit as usize
                || pair.page.offset != request.page.offset
                || pair.page.summary.byte_length != pair.rollout_identity.size
                || pair.rollout_identity.size == 0
                || pair.rollout_identity.size > jsonl_scan::SOURCE_BYTES
                || pair.page.summary.record_count == 0
                || pair.page.summary.record_count > jsonl_scan::RECORDS
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
            let source_sha: String = pair
                .page
                .summary
                .sha256
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            let result = serde_json::json!({"kind":"native_codex_source_page","nativeVersion":base.native_version,
                "threadId":base.source.thread_id,"rolloutPath":base.source.rollout_path,
                "rootIdentity":{"device":base.expected_root.device,"inode":base.expected_root.inode},
                "storage":{"encoding":"jsonl","rolloutPath":pair.physical_path},
                "byteLength":payload.len(),"sha256":format!("{:x}",Sha256::digest(&payload)),
                "rollout":{"sha256":source_sha,
                    "identity":pair.rollout_identity,"recordCount":pair.page.summary.record_count},
                "page":{"offset":pair.page.offset,"byteLength":page_length,"records":rows,"nextOffset":pair.page.next_offset},
                "nameIndex":name_index,
                "checks":{"owner":"posix_euid_and_mode","acl":"no_extended_acl",
                    "containment":"root_identity_and_openat_nofollow","reads":2,
                    "matchingRolloutDigests":true,"matchingNameIndexBytes":true,
                    "unchangedObservedIdentity":true,"nameIndexPresenceRechecked":true,"rolloutSelectionRechecked":true},
                "recordSemanticsValidated":false,"semanticHistoryComplete":false,"sourceAuthenticated":false,"publishable":false});
            (result, payload)
        }
        Err(error) => (
            serde_json::json!({"kind":"source_unavailable","code":error.code()}),
            Vec::new(),
        ),
    };
    let header = serde_json::to_vec(
        &serde_json::json!({"protocolVersion":10,"nonce":request.base.nonce,"result":result}),
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
