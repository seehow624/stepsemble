//! Standalone experiment, NOT a daemon or production history endpoint.
//! Explicit-root metadata inventory or one-file capture; no HOME discovery,
//! credentials, SDK, network, source writes or model calls.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
mod codex;
mod codex_catalog;
mod codex_paginated;
mod codex_scanned;
mod codex_sqlite;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod posix;
#[cfg(any(windows, test))]
mod windows;

const INPUT_LIMIT: usize = 12 * 1024;
pub const SOURCE_LIMIT: usize = 8 * 1024 * 1024;
pub const INVENTORY_LIMIT: usize = 1024 * 1024;
pub const INVENTORY_ENTRIES: usize = 2048;
pub const DIRECTORY_ENTRIES: usize = 10000;
pub const PROJECTS_LIMIT: usize = 512;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryRequest {
    protocol_version: u8,
    nonce: String,
    pub projects_root: String,
    pub expected_root: RootIdentity,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub project_key: String,
    pub session_id: String,
    pub identity: Identity,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Inventory {
    pub entries: Vec<InventoryEntry>,
    pub projects_scanned: usize,
    pub ignored_entries: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    protocol_version: u8,
    nonce: String,
    pub source: Source,
    pub expected_root: RootIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub projects_root: String,
    pub project_key: String,
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootIdentity {
    pub device: String,
    pub inode: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub device: String,
    pub inode: String,
    pub size: u64,
    pub mtime_ns: String,
    pub ctime_ns: String,
}

pub struct Capture {
    pub bytes: Vec<u8>,
    pub identity: Identity,
}

pub use stepsemble_history_source_reader::source_error::Error;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn project_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_')
}

fn session_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, v)| {
            if [8, 13, 18, 23].contains(&i) {
                v == b'-'
            } else {
                v.is_ascii_hexdigit()
            }
        })
}

fn parse_inventory_request(bytes: &[u8]) -> Result<InventoryRequest, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    let r: InventoryRequest = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if r.protocol_version != 2
        || r.nonce.len() != 64
        || !r
            .nonce
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || r.projects_root.is_empty()
        || r.projects_root.len() > 8192
        || r.projects_root.contains('\0')
        || !decimal(&r.expected_root.device, false)
        || !decimal(&r.expected_root.inode, true)
    {
        return Err(Error::Input);
    }
    Ok(r)
}

fn decimal(value: &str, positive: bool) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|v| v.is_ascii_digit())
        && value.parse::<u64>().is_ok_and(|v| !positive || v > 0)
}

fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    let source = &request.source;
    let id = source.session_id.as_bytes();
    if request.protocol_version != 1
        || request.nonce.len() != 64
        || !request
            .nonce
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || source.projects_root.is_empty()
        || source.projects_root.len() > 8192
        || source.projects_root.contains('\0')
        || source.project_key.is_empty()
        || source.project_key.len() > 255
        || !source
            .project_key
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_')
        || id.len() != 36
        || !id.iter().enumerate().all(|(i, v)| {
            if [8, 13, 18, 23].contains(&i) {
                *v == b'-'
            } else {
                v.is_ascii_hexdigit()
            }
        })
        || !decimal(&request.expected_root.device, false)
        || !decimal(&request.expected_root.inode, true)
    {
        return Err(Error::Input);
    }
    Ok(request)
}

fn capture(request: &Request) -> Result<Capture, Error> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return posix::capture(request);
    #[cfg(windows)]
    return windows::capture(request);
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = request;
        Err(Error::PlatformUnsupported)
    }
}

fn inventory(request: &InventoryRequest) -> Result<Inventory, Error> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return posix::inventory::inventory(request);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = request;
        Err(Error::PlatformUnsupported)
    }
}

fn write_inventory_frame(
    mut output: impl Write,
    request: &InventoryRequest,
    result: Result<Inventory, Error>,
) -> Result<(), Error> {
    let (result, payload) = match result {
        Ok(value) => {
            let payload = serde_json::to_vec(&value.entries).map_err(|_| Error::Io)?;
            if payload.len() > INVENTORY_LIMIT {
                return write_inventory_frame(output, request, Err(Error::InventoryLimit));
            }
            let result = serde_json::json!({"kind":"native_source_inventory", "byteLength":payload.len(),
                "sha256":format!("{:x}", Sha256::digest(&payload)), "entryCount":value.entries.len(),
                "projectsScanned":value.projects_scanned, "ignoredEntries":value.ignored_entries,
                "expectedRoot":{"device":request.expected_root.device,"inode":request.expected_root.inode},
                "checks":{"owner":"posix_euid_and_mode","acl":"no_extended_acl",
                    "containment":"root_identity_and_openat_nofollow","enumerations":2,"matchingInventory":true},
                "sourceAuthenticated":false,"publishable":false});
            (result, payload)
        }
        Err(e) => (
            serde_json::json!({"kind":"source_unavailable","code":e.code()}),
            Vec::new(),
        ),
    };
    let header = serde_json::to_vec(
        &serde_json::json!({"protocolVersion":2,"nonce":request.nonce,"result":result}),
    )
    .map_err(|_| Error::Io)?;
    if header.len() > 16 * 1024 {
        return Err(Error::TooLarge);
    }
    output
        .write_all(&(header.len() as u32).to_be_bytes())
        .map_err(|_| Error::Io)?;
    output.write_all(&header).map_err(|_| Error::Io)?;
    output.write_all(&payload).map_err(|_| Error::Io)?;
    output.flush().map_err(|_| Error::Io)
}

fn write_frame(
    mut output: impl Write,
    request: &Request,
    captured: Result<Capture, Error>,
) -> Result<(), Error> {
    let (result, bytes) = match captured {
        Ok(value) => {
            let result = serde_json::json!({
                "kind":"native_source_bytes", "sessionId":request.source.session_id,
                "byteLength":value.bytes.len(), "sha256":format!("{:x}", Sha256::digest(&value.bytes)),
                "identity":value.identity,
                "checks":{"owner":"posix_euid_and_mode","acl":"no_extended_acl",
                    "containment":"root_identity_and_openat_nofollow","reads":2,
                    "matchingBytes":true,"unchangedObservedIdentity":true},
                "sourceAuthenticated":false,"publishable":false
            });
            (result, value.bytes)
        }
        Err(error) => (
            serde_json::json!({"kind":"source_unavailable","code":error.code()}),
            Vec::new(),
        ),
    };
    let header = serde_json::to_vec(
        &serde_json::json!({"protocolVersion":1,"nonce":request.nonce,"result":result}),
    )
    .map_err(|_| Error::Io)?;
    if header.len() > 16 * 1024 || bytes.len() > SOURCE_LIMIT {
        return Err(Error::TooLarge);
    }
    output
        .write_all(&(header.len() as u32).to_be_bytes())
        .map_err(|_| Error::Io)?;
    output.write_all(&header).map_err(|_| Error::Io)?;
    output.write_all(&bytes).map_err(|_| Error::Io)?;
    output.flush().map_err(|_| Error::Io)
}

fn run() -> Result<(), Error> {
    // The owning parent enforces the process deadline, including a stalled stdin.
    if std::env::args_os().count() != 1 {
        return Err(Error::Input);
    }
    let mut input = Vec::new();
    // Protocol 15 carries one bounded first record per planned source and is
    // intentionally allowed a larger envelope than the legacy source readers.
    // Each parser still enforces its own exact limit after this shared read.
    let input_limit = INPUT_LIMIT.max(codex_paginated::INPUT_LIMIT);
    std::io::stdin()
        .take((input_limit + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| Error::Input)?;
    if let Ok(request) = parse_request(&input) {
        write_frame(std::io::stdout().lock(), &request, capture(&request))
    } else if let Ok(request) = parse_inventory_request(&input) {
        write_inventory_frame(std::io::stdout().lock(), &request, inventory(&request))
    } else if let Ok(request) = codex::parse_request(&input) {
        codex::write_frame(std::io::stdout().lock(), &request, codex::capture(&request))
    } else if let Ok(request) = codex_scanned::parse_request(&input) {
        codex_scanned::write_frame(
            std::io::stdout().lock(),
            &request,
            codex_scanned::capture(&request),
        )
    } else if let Ok(request) = codex_paginated::parse_request(&input) {
        codex_paginated::write_frame(
            std::io::stdout().lock(),
            &request,
            codex_paginated::capture(&request),
        )
    } else if let Ok(request) = codex_sqlite::parse_request(&input) {
        codex_sqlite::write_frame(
            std::io::stdout().lock(),
            &request,
            codex_sqlite::capture(&request),
        )
    } else {
        let request = codex_catalog::parse_request(&input)?;
        codex_catalog::write_frame(
            std::io::stdout().lock(),
            &request,
            codex_catalog::capture(&request),
        )
    }
}

fn main() {
    // Never expose request/source data, panic location or OS error text.
    std::panic::set_hook(Box::new(|_| {}));
    if run().is_err() {
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> serde_json::Value {
        serde_json::json!({"protocolVersion":1,"nonce":"a".repeat(64),"source":{
            "projectsRoot":"/owned/projects","projectKey":"test","sessionId":"11111111-1111-1111-1111-111111111111"},
            "expectedRoot":{"device":"0","inode":"1"}})
    }
    #[test]
    fn strict_input_contract() {
        let base = request();
        assert!(parse_request(&serde_json::to_vec(&base).expect("fixture")).is_ok());
        for bytes in [
            vec![b' '; INPUT_LIMIT + 1],
            b"{}{}".to_vec(),
            b"\xef\xbb\xbf{}".to_vec(),
            b"{}".to_vec(),
        ] {
            assert!(parse_request(&bytes).is_err());
        }
        for key in ["extra", "args", "env"] {
            let mut value = base.clone();
            value[key] = serde_json::json!(true);
            assert!(parse_request(&serde_json::to_vec(&value).expect("fixture")).is_err());
        }
        for value in ["../outside", "a/b", "", ".", "x\0x"] {
            let mut req = base.clone();
            req["source"]["projectKey"] = value.into();
            assert!(parse_request(&serde_json::to_vec(&req).expect("fixture")).is_err());
        }
        for value in ["0", "01", "18446744073709551616", "-1", "1\n"] {
            let mut req = base.clone();
            req["expectedRoot"]["inode"] = value.into();
            assert!(parse_request(&serde_json::to_vec(&req).expect("fixture")).is_err());
        }
        let duplicate =
            serde_json::to_string(&base)
                .expect("fixture")
                .replacen("{", "{\"nonce\":\"bad\",", 1);
        assert!(parse_request(duplicate.as_bytes()).is_err());
    }
    #[test]
    fn inventory_protocol_is_separate_and_strict() {
        let base = serde_json::json!({"protocolVersion":2,"nonce":"a".repeat(64),
            "projectsRoot":"/owned/projects","expectedRoot":{"device":"0","inode":"1"}});
        assert!(parse_inventory_request(&serde_json::to_vec(&base).expect("fixture")).is_ok());
        assert!(parse_request(&serde_json::to_vec(&base).expect("fixture")).is_err());
        assert!(
            parse_inventory_request(&serde_json::to_vec(&request()).expect("fixture")).is_err()
        );
        for (key, value) in [
            ("protocolVersion", serde_json::json!(1)),
            ("nonce", serde_json::json!("bad")),
            ("source", serde_json::json!({})),
            ("maxEntries", serde_json::json!(999999)),
        ] {
            let mut r = base.clone();
            r[key] = value;
            assert!(parse_inventory_request(&serde_json::to_vec(&r).expect("fixture")).is_err());
        }
        let r =
            parse_inventory_request(&serde_json::to_vec(&base).expect("fixture")).expect("request");
        let mut out = Vec::new();
        write_inventory_frame(
            &mut out,
            &r,
            Ok(Inventory {
                entries: vec![],
                projects_scanned: 0,
                ignored_entries: 0,
            }),
        )
        .expect("frame");
        let len = u32::from_be_bytes(out[..4].try_into().expect("size")) as usize;
        let header: serde_json::Value = serde_json::from_slice(&out[4..4 + len]).expect("header");
        assert_eq!(header["protocolVersion"], 2);
        assert_eq!(header["result"]["entryCount"], 0);
        assert_eq!(header["result"]["sourceAuthenticated"], false);
        assert_eq!(&out[4 + len..], b"[]");
    }
    #[test]
    fn frame_is_length_delimited_and_error_has_no_payload() {
        let request =
            parse_request(&serde_json::to_vec(&request()).expect("fixture")).expect("fixture");
        let mut out = Vec::new();
        write_frame(&mut out, &request, Err(Error::AccessDenied)).expect("frame");
        let size = u32::from_be_bytes(out[..4].try_into().expect("length")) as usize;
        assert_eq!(out.len(), size + 4);
        let header: serde_json::Value = serde_json::from_slice(&out[4..]).expect("json");
        assert_eq!(header["result"]["code"], "source_access_denied");
        assert!(
            !String::from_utf8(out[4..].to_vec())
                .expect("utf8")
                .contains("/owned")
        );
    }
}
