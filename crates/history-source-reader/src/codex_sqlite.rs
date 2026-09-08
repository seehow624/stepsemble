//! Private v4 selected metadata capture. Distinct SQLite root, no native CLI.
use crate::{Error, INPUT_LIMIT, RootIdentity, decimal};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use stepsemble_history_source_reader::sqlite_metadata::{NATIVE_VERSION, OUTPUT_LIMIT};
pub const PAYLOAD_LIMIT: usize = OUTPUT_LIMIT + 16 * 1024;

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
    let r: Request = serde_json::from_slice(bytes).map_err(|_| Error::Input)?;
    if r.protocol_version != 4
        || r.native_version != NATIVE_VERSION
        || r.nonce.len() != 64
        || !r
            .nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || r.source.sqlite_root.is_empty()
        || r.source.sqlite_root.len() > 8192
        || r.source
            .sqlite_root
            .bytes()
            .any(|v| v < 32 || v == 127 || b"*?[]{},".contains(&v))
        || !crate::session_id(&r.source.thread_id)
        || r.source.thread_id != r.source.thread_id.to_ascii_lowercase()
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
        use stepsemble_history_source_reader::sqlite_source::{self, Selection};
        let selection = Selection {
            root_path: r.source.sqlite_root.clone(),
            expected_device: r.expected_root.device.parse().map_err(|_| Error::Input)?,
            expected_inode: r.expected_root.inode.parse().map_err(|_| Error::Input)?,
            native_version: r.native_version.clone(),
            thread_id: r.source.thread_id.clone(),
        };
        // SAFETY: main processes exactly one bounded request, has opened no
        // SQLite connections, and terminates after the single response. No other
        // connection, VFS replacement or source fallback exists in this branch.
        let prepared =
            unsafe { sqlite_source::prepare(selection, Arc::new(AtomicBool::new(false))) }?;
        let result = prepared.read()?.finish()?;
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
            let result = serde_json::json!({"kind":"native_sqlite_metadata","nativeVersion":r.native_version,
                "threadId":r.source.thread_id,"expectedRoot":{"device":r.expected_root.device,"inode":r.expected_root.inode},
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
        &serde_json::json!({"protocolVersion":4,"nonce":r.nonce,"result":result}),
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
        serde_json::json!({"protocolVersion":4,"nonce":"a".repeat(64),"nativeVersion":"0.153.4",
            "source":{"sqliteRoot":"/owned/sqlite","threadId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"},
            "expectedRoot":{"device":"1","inode":"2"}})
    }
    #[test]
    fn exact_sqlite_request_not_arbitrary_file_or_inherited_root() {
        let base = request();
        assert!(parse_request(&serde_json::to_vec(&base).unwrap()).is_ok());
        let mut windows = base.clone();
        windows["source"]["sqliteRoot"] = serde_json::json!(r"C:\owned sqlite 🐾 #%");
        assert!(parse_request(&serde_json::to_vec(&windows).unwrap()).is_ok());
        windows["source"]["sqliteRoot"] = serde_json::json!(r"\\?\C:\owned sqlite 🐾 #%");
        assert!(parse_request(&serde_json::to_vec(&windows).unwrap()).is_err());
        for (path, value) in [
            (vec!["protocolVersion"], serde_json::json!(3)),
            (vec!["nativeVersion"], serde_json::json!("unknown")),
            (vec!["nonce"], serde_json::json!("A".repeat(64))),
            (vec!["source", "sqliteRoot"], serde_json::json!("/owned/*")),
            (
                vec!["source", "sqliteRoot"],
                serde_json::json!("/owned/\nsecret"),
            ),
            (
                vec!["source", "threadId"],
                serde_json::json!("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"),
            ),
            (vec!["expectedRoot", "inode"], serde_json::json!("0")),
            (vec!["source", "codexRoot"], serde_json::json!("/inherited")),
            (
                vec!["source", "databaseName"],
                serde_json::json!("auth.json"),
            ),
            (vec!["env"], serde_json::json!({})),
        ] {
            let mut v = base.clone();
            let mut target = &mut v;
            for key in &path[..path.len() - 1] {
                target = &mut target[*key];
            }
            target[path[path.len() - 1]] = value;
            assert!(parse_request(&serde_json::to_vec(&v).unwrap()).is_err());
        }
        let duplicate =
            serde_json::to_string(&base)
                .unwrap()
                .replacen('{', "{\"nonce\":\"bad\",", 1);
        assert!(parse_request(duplicate.as_bytes()).is_err());
        assert!(parse_request(&vec![b' '; INPUT_LIMIT + 1]).is_err());
    }
    #[test]
    fn unavailable_sqlite_frame_has_no_fields_or_source_path() {
        let r = parse_request(&serde_json::to_vec(&request()).unwrap()).unwrap();
        let mut frame = Vec::new();
        write_frame(&mut frame, &r, Err(Error::OwnerOrMode)).unwrap();
        let n = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(frame.len(), n + 4);
        let header: serde_json::Value = serde_json::from_slice(&frame[4..]).unwrap();
        assert_eq!(
            header,
            serde_json::json!({"protocolVersion":4,"nonce":"a".repeat(64),
            "result":{"kind":"source_unavailable","code":"source_owner_or_mode"}})
        );
    }
}
