//! Root-only v6 state catalog. No sentinel thread ID, title or transcript read.
use crate::{Error, INPUT_LIMIT, RootIdentity, decimal};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use stepsemble_history_source_reader::sqlite_metadata::{CATALOG_OUTPUT_LIMIT, NATIVE_VERSION};

pub const PAYLOAD_LIMIT: usize = CATALOG_OUTPUT_LIMIT + 16 * 1024;

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
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(Error::Input);
    }
    let r: Request = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if r.protocol_version != 6
        || r.native_version != NATIVE_VERSION
        || r.nonce.len() != 64
        || !r
            .nonce
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || r.source.sqlite_root.is_empty()
        || r.source.sqlite_root.len() > 8192
        || r.source
            .sqlite_root
            .bytes()
            .any(|v| v < 32 || v == 127 || b"*?[]{},".contains(&v))
        || !decimal(&r.expected_root.device, false)
        || !decimal(&r.expected_root.inode, true)
    {
        return Err(Error::Input);
    }
    Ok(r)
}

pub fn capture(r: &Request) -> Result<Vec<u8>, Error> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::sync::{Arc, atomic::AtomicBool};
        use stepsemble_history_source_reader::sqlite_source::{self, RootSelection};
        let selection = RootSelection {
            root_path: r.source.sqlite_root.clone(),
            expected_device: r.expected_root.device.parse().map_err(|_| Error::Input)?,
            expected_inode: r.expected_root.inode.parse().map_err(|_| Error::Input)?,
            native_version: r.native_version.clone(),
        };
        // SAFETY: main executes one request in this fresh dedicated process,
        // with no prior SQLite connection or VFS and no fallback on any error.
        let result =
            unsafe { sqlite_source::prepare_catalog(selection, Arc::new(AtomicBool::new(false))) }?
                .read_catalog()?
                .finish()?;
        let bytes = serde_json::to_vec(&result).map_err(|_| Error::Io)?;
        if bytes.len() > PAYLOAD_LIMIT {
            return Err(Error::TooLarge);
        }
        Ok(bytes)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = r;
        Err(Error::PlatformUnsupported)
    }
}

pub fn write_frame(
    mut output: impl Write,
    r: &Request,
    capture: Result<Vec<u8>, Error>,
) -> Result<(), Error> {
    let (result, payload) = match capture {
        Ok(payload) => {
            if payload.is_empty() || payload.len() > PAYLOAD_LIMIT {
                return Err(Error::TooLarge);
            }
            let result = serde_json::json!({"kind":"native_sqlite_catalog","nativeVersion":r.native_version,
                "expectedRoot":{"device":r.expected_root.device,"inode":r.expected_root.inode},
                "byteLength":payload.len(),"sha256":format!("{:x}",Sha256::digest(&payload)),
                "sourceAuthenticated":false,"publishable":false});
            (result, payload)
        }
        Err(error) => (
            serde_json::json!({"kind":"source_unavailable","code":error.code()}),
            Vec::new(),
        ),
    };
    let header = serde_json::to_vec(
        &serde_json::json!({"protocolVersion":6,"nonce":r.nonce,"result":result}),
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

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> serde_json::Value {
        serde_json::json!({"protocolVersion":6,"nonce":"a".repeat(64),"nativeVersion":NATIVE_VERSION,
            "source":{"sqliteRoot":"/owned/sqlite"},"expectedRoot":{"device":"1","inode":"2"}})
    }
    #[test]
    fn exact_root_only_versioned_request_cannot_be_a_selected_read() {
        let base = request();
        assert!(parse_request(&serde_json::to_vec(&base).unwrap()).is_ok());
        for pointer in [
            "/source/threadId",
            "/source/sql",
            "/source/codexRoot",
            "/unexpected",
            "/expectedRoot/path",
        ] {
            let mut value = base.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            value.pointer_mut(parent).unwrap()[key] = serde_json::json!("untrusted");
            assert!(parse_request(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for (key, bad) in [
            ("protocolVersion", serde_json::json!(5)),
            ("nativeVersion", serde_json::json!("unknown")),
            ("nonce", serde_json::json!("A".repeat(64))),
        ] {
            let mut value = base.clone();
            value[key] = bad;
            assert!(parse_request(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        let mut root = base.clone();
        root["source"]["sqliteRoot"] = serde_json::json!("/owned/*");
        assert!(parse_request(&serde_json::to_vec(&root).unwrap()).is_err());
        assert!(parse_request(&vec![b' '; INPUT_LIMIT + 1]).is_err());
        assert!(crate::codex_sqlite::parse_request(&serde_json::to_vec(&base).unwrap()).is_err());
    }
    #[test]
    fn root_only_frame_has_nonce_digest_and_zero_payload_on_refusal() {
        let r = parse_request(&serde_json::to_vec(&request()).unwrap()).unwrap();
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &r, Ok(b"owned".to_vec())).unwrap();
        let size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        let h: serde_json::Value = serde_json::from_slice(&bytes[4..4 + size]).unwrap();
        assert_eq!(h["protocolVersion"], 6);
        assert_eq!(h["nonce"], "a".repeat(64));
        assert_eq!(h["result"]["kind"], "native_sqlite_catalog");
        assert!(h["result"].get("threadId").is_none());
        assert_eq!(
            h["result"]["sha256"],
            format!("{:x}", Sha256::digest(b"owned"))
        );
        assert_eq!(&bytes[4 + size..], b"owned");
        let mut denied = Vec::new();
        write_frame(&mut denied, &r, Err(Error::PlatformUnsupported)).unwrap();
        assert_eq!(
            denied.len(),
            4 + u32::from_be_bytes(denied[..4].try_into().unwrap()) as usize
        );
        assert!(write_frame(Vec::new(), &r, Ok(vec![0; PAYLOAD_LIMIT + 1])).is_err());
    }
}
