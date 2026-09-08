//! Private v3 selected Codex rollout + fixed name-index capture. No native CLI.
use crate::{Capture, Error, INPUT_LIMIT, RootIdentity, SOURCE_LIMIT, decimal, session_id};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;

pub const NATIVE_VERSION: &str = "0.153.4";
pub const INDEX_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    protocol_version: u8,
    nonce: String,
    pub native_version: String,
    pub source: Source,
    pub expected_root: RootIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub codex_root: String,
    pub rollout_path: String,
    pub thread_id: String,
}

pub struct Pair {
    pub rollout: Capture,
    pub name_index: Option<Capture>,
}

fn timestamp(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 19
        || b.iter().enumerate().any(|(i, v)| match i {
            4 | 7 | 13 | 16 => *v != b'-',
            10 => *v != b'T',
            _ => !v.is_ascii_digit(),
        })
    {
        return false;
    }
    let number = |s: &str| s.parse::<u32>().unwrap_or(u32::MAX);
    let year = number(&value[..4]);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match number(&value[5..7]) {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    (1..=days).contains(&number(&value[8..10]))
        && number(&value[11..13]) < 24
        && number(&value[14..16]) < 60
        && number(&value[17..19]) < 60
}

// Native reverted rollouts retain the thread UUID but add a distinct rollout UUID.
// A compressed locator is recognized, not silently changed to its plain sibling.
pub fn valid_locator(path: &str, thread: &str) -> bool {
    if path.len() > 160 || !session_id(thread) || thread != thread.to_ascii_lowercase() {
        return false;
    }
    let parts: Vec<_> = path.split('/').collect();
    let file = match parts.as_slice() {
        ["sessions", _, _, _, file] | ["archived_sessions", file] => *file,
        _ => return false,
    };
    let Some(core) = file
        .strip_suffix(".zst")
        .unwrap_or(file)
        .strip_prefix("rollout-")
        .and_then(|v| v.strip_suffix(".jsonl"))
    else {
        return false;
    };
    let Some(time) = core.get(..19) else {
        return false;
    };
    if !timestamp(time) || core.get(19..20) != Some("-") {
        return false;
    }
    let ids = &core[20..];
    let (id, rollout) = ids.split_once('_').unwrap_or((ids, ids));
    if id != thread || !session_id(rollout) || rollout != rollout.to_ascii_lowercase() {
        return false;
    }
    parts.len() == 2
        || (parts[1] == &time[..4] && parts[2] == &time[5..7] && parts[3] == &time[8..10])
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    let r: Request = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if r.protocol_version != 3
        || r.native_version != NATIVE_VERSION
        || r.nonce.len() != 64
        || !r
            .nonce
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || r.source.codex_root.is_empty()
        || r.source.codex_root.len() > 8192
        || r.source.codex_root.contains('\0')
        || r.source
            .codex_root
            .bytes()
            .any(|v| v < 32 || v == 127 || b"*?[]{},".contains(&v))
        || !valid_locator(&r.source.rollout_path, &r.source.thread_id)
        || !decimal(&r.expected_root.device, false)
        || !decimal(&r.expected_root.inode, true)
    {
        return Err(Error::Input);
    }
    Ok(r)
}

pub fn capture(request: &Request) -> Result<Pair, Error> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        crate::posix::codex::capture(request)
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
    let (result, rollout, index) = match pair {
        Ok(pair) => {
            if pair.rollout.bytes.is_empty()
                || pair.rollout.bytes.len() > SOURCE_LIMIT
                || pair
                    .name_index
                    .as_ref()
                    .is_some_and(|v| v.bytes.len() > INDEX_LIMIT)
            {
                return Err(Error::TooLarge);
            }
            let descriptor = |v: &Capture, offset| {
                serde_json::json!({"byteOffset":offset,"byteLength":v.bytes.len(),
                "sha256":format!("{:x}",Sha256::digest(&v.bytes)),"identity":v.identity})
            };
            let index = pair
                .name_index
                .as_ref()
                .map(|v| descriptor(v, pair.rollout.bytes.len()));
            let mut hash = Sha256::new();
            hash.update(&pair.rollout.bytes);
            if let Some(value) = &pair.name_index {
                hash.update(&value.bytes);
            }
            let length =
                pair.rollout.bytes.len() + pair.name_index.as_ref().map_or(0, |v| v.bytes.len());
            let result = serde_json::json!({"kind":"native_codex_source_bytes","nativeVersion":request.native_version,
                "threadId":request.source.thread_id,"rolloutPath":request.source.rollout_path,
                "rootIdentity":{"device":request.expected_root.device,"inode":request.expected_root.inode},
                "byteLength":length,"sha256":format!("{:x}",hash.finalize()),
                "rollout":descriptor(&pair.rollout,0),"nameIndex":index,
                "checks":{"owner":"posix_euid_and_mode","acl":"no_extended_acl",
                    "containment":"root_identity_and_openat_nofollow","reads":2,
                    "matchingBytes":true,"unchangedObservedIdentity":true,"nameIndexPresenceRechecked":true},
                "sourceAuthenticated":false,"publishable":false});
            (
                result,
                pair.rollout.bytes,
                pair.name_index.map_or_else(Vec::new, |v| v.bytes),
            )
        }
        Err(error) => (
            serde_json::json!({"kind":"source_unavailable","code":error.code()}),
            Vec::new(),
            Vec::new(),
        ),
    };
    let header = serde_json::to_vec(
        &serde_json::json!({"protocolVersion":3,"nonce":request.nonce,"result":result}),
    )
    .map_err(|_| Error::Io)?;
    if header.len() > 16 * 1024 {
        return Err(Error::TooLarge);
    }
    output
        .write_all(&(header.len() as u32).to_be_bytes())
        .map_err(|_| Error::Io)?;
    for bytes in [&header, &rollout, &index] {
        output.write_all(bytes).map_err(|_| Error::Io)?;
    }
    output.flush().map_err(|_| Error::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    pub fn input() -> serde_json::Value {
        serde_json::json!({"protocolVersion":3,"nonce":"a".repeat(64),"nativeVersion":NATIVE_VERSION,
            "source":{"codexRoot":"/owned/codex","threadId":ID,"rolloutPath":format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{ID}.jsonl")},
            "expectedRoot":{"device":"1","inode":"2"}})
    }
    #[test]
    fn exact_request_and_native_locator_scope() {
        let base = input();
        assert!(parse_request(&serde_json::to_vec(&base).unwrap()).is_ok());
        for prefix in ["sessions/2026/01/05/", "archived_sessions/"] {
            for suffix in [
                ".jsonl",
                "_22222222-2222-4222-8222-222222222222.jsonl",
                ".jsonl.zst",
            ] {
                assert!(valid_locator(
                    &format!("{prefix}rollout-2026-01-05T12-00-00-{ID}{suffix}"),
                    ID
                ));
            }
        }
        for (key, value) in [
            ("protocolVersion", serde_json::json!(2)),
            ("nativeVersion", serde_json::json!("0.153.3")),
            ("extra", serde_json::json!(true)),
        ] {
            let mut v = base.clone();
            v[key] = value;
            assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
        }
        for bad in [
            "../session_index.jsonl",
            "auth.json",
            "/sessions/2026/01/05/x",
            "sessions/2026/01/06/rollout-2026-01-05T12-00-00-ID.jsonl",
        ] {
            assert!(!valid_locator(&bad.replace("ID", ID), ID));
        }
        for time in [
            "2026-02-29T12-00-00",
            "2026-04-31T12-00-00",
            "2026-01-05T24-00-00",
            "2026-01-05T12-60-00",
            "2026-01-05T12-00-60",
            "２０２６-01-05T12-00-00",
        ] {
            assert!(!valid_locator(
                &format!("archived_sessions/rollout-{time}-{ID}.jsonl"),
                ID
            ));
        }
        assert!(valid_locator(
            &format!("sessions/2024/02/29/rollout-2024-02-29T12-00-00-{ID}.jsonl"),
            ID
        ));
        assert!(parse_request(format!("{} trailing", base).as_bytes()).is_err());
        assert!(parse_request(&vec![b' '; INPUT_LIMIT + 1]).is_err());
    }
    #[test]
    fn unavailable_frame_never_contains_source_or_payload() {
        let request = parse_request(&serde_json::to_vec(&input()).unwrap()).unwrap();
        let mut out = Vec::new();
        write_frame(&mut out, &request, Err(Error::AccessDenied)).unwrap();
        let size = u32::from_be_bytes(out[..4].try_into().unwrap()) as usize;
        assert_eq!(out.len(), 4 + size);
        let h: serde_json::Value = serde_json::from_slice(&out[4..]).unwrap();
        assert_eq!(h["protocolVersion"], 3);
        assert_eq!(
            h["result"],
            serde_json::json!({"kind":"source_unavailable","code":"source_access_denied"})
        );
    }
}
