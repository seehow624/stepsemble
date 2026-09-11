//! Bounded protocol adapter for Codex's separate paginated-history SQLite DB.
//!
//! This is an observation-only checkpoint read. It deliberately does not
//! combine the state and history databases or claim an atomic cross-database
//! snapshot; the Host must perform its own before/after version fence.
use crate::{Error, INPUT_LIMIT, RootIdentity, decimal};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;

const PROTOCOL_VERSION: u8 = 16;
const PAYLOAD_LIMIT: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    protocol_version: u8,
    nonce: String,
    native_version: String,
    source: Source,
    expected_root: RootIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    sqlite_root: String,
    thread_id: String,
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if request.protocol_version != PROTOCOL_VERSION
        || request.native_version
            != stepsemble_history_source_reader::sqlite_metadata::NATIVE_VERSION
        || request.nonce.len() != 64
        || !request
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || request.source.sqlite_root.is_empty()
        || request.source.sqlite_root.len() > 8192
        || request
            .source
            .sqlite_root
            .bytes()
            .any(|byte| byte < 32 || byte == 127 || b"*?[]{},".contains(&byte))
        || !crate::session_id(&request.source.thread_id)
        || !decimal(&request.expected_root.device, false)
        || !decimal(&request.expected_root.inode, true)
    {
        return Err(Error::Input);
    }
    Ok(request)
}

pub fn capture(request: &Request) -> Result<Vec<u8>, Error> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::sync::{Arc, atomic::AtomicBool};
        use stepsemble_history_source_reader::sqlite_source::{self, RootSelection};
        let selection = RootSelection {
            root_path: request.source.sqlite_root.clone(),
            expected_device: request
                .expected_root
                .device
                .parse()
                .map_err(|_| Error::Input)?,
            expected_inode: request
                .expected_root
                .inode
                .parse()
                .map_err(|_| Error::Input)?,
            native_version: request.native_version.clone(),
        };
        // SAFETY: the executable processes one request in a fresh process. The
        // history VFS owns all descriptors until the bounded checkpoint read
        // closes them; no fallback connection is permitted.
        let result =
            unsafe { sqlite_source::prepare_history(selection, Arc::new(AtomicBool::new(false))) }?
                .read_checkpoint(&request.source.thread_id)?
                .finish()?;
        let bytes = serde_json::to_vec(&result).map_err(|_| Error::Io)?;
        if bytes.len() > PAYLOAD_LIMIT {
            return Err(Error::TooLarge);
        }
        Ok(bytes)
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
    capture: Result<Vec<u8>, Error>,
) -> Result<(), Error> {
    let (result, payload) = match capture {
        Ok(payload) => {
            if payload.is_empty() || payload.len() > PAYLOAD_LIMIT {
                return Err(Error::TooLarge);
            }
            let result = serde_json::json!({
                "kind": "native_sqlite_paginated_checkpoint",
                "nativeVersion": request.native_version,
                "threadId": request.source.thread_id,
                "expectedRoot": {"device": request.expected_root.device, "inode": request.expected_root.inode},
                "byteLength": payload.len(),
                "sha256": format!("{:x}", Sha256::digest(&payload)),
                "sourceAuthenticated": false,
                "publishable": false,
            });
            (result, payload)
        }
        Err(error) => (
            serde_json::json!({"kind":"source_unavailable","code":error.code()}),
            Vec::new(),
        ),
    };
    let header = serde_json::to_vec(&serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "nonce": request.nonce,
        "result": result,
    }))
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

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "nonce": "a".repeat(64),
            "nativeVersion": "0.153.4",
            "source": {"sqliteRoot": "/owned/sqlite", "threadId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"},
            "expectedRoot": {"device": "1", "inode": "2"}
        })
    }

    #[test]
    fn strict_checkpoint_request_and_frame() {
        let base = request();
        let parsed = parse_request(&serde_json::to_vec(&base).unwrap()).unwrap();
        let mut output = Vec::new();
        write_frame(&mut output, &parsed, Ok(b"owned".to_vec())).unwrap();
        let size = u32::from_be_bytes(output[..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&output[4..4 + size]).unwrap();
        assert_eq!(header["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(
            header["result"]["kind"],
            "native_sqlite_paginated_checkpoint"
        );
        assert_eq!(&output[4 + size..], b"owned");
        let mut extra = base.clone();
        extra["source"]["unexpected"] = serde_json::json!(true);
        assert!(parse_request(&serde_json::to_vec(&extra).unwrap()).is_err());
        let mut wrong = base;
        wrong["protocolVersion"] = serde_json::json!(15);
        assert!(parse_request(&serde_json::to_vec(&wrong).unwrap()).is_err());
        assert!(write_frame(Vec::new(), &parsed, Ok(vec![0; PAYLOAD_LIMIT + 1])).is_err());
    }
}
