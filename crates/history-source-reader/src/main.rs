//! Standalone experiment, NOT a daemon or production history endpoint.
//! No discovery, credentials, SDK, network, source writes or model calls.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod posix;
#[cfg(any(windows, test))]
mod windows;

const INPUT_LIMIT: usize = 12 * 1024;
pub const SOURCE_LIMIT: usize = 8 * 1024 * 1024;

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

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Input,
    PlatformUnsupported,
    Missing,
    NotRegular,
    OwnerOrMode,
    Hardlinked,
    Empty,
    TooLarge,
    Changed,
    AccessDenied,
    Io,
    Budget,
    AclUnavailable,
    AclUnsupported,
    RootIdentityChanged,
    IdentityUnavailable,
    ContainmentUnavailable,
    CloseFailed,
}

impl Error {
    fn code(&self) -> &'static str {
        match self {
            Self::Input => "invalid_source_input",
            Self::PlatformUnsupported => "source_platform_unsupported",
            Self::Missing => "source_missing",
            Self::NotRegular => "source_not_regular_or_linked",
            Self::OwnerOrMode => "source_owner_or_mode",
            Self::Hardlinked => "source_hardlinked",
            Self::Empty => "source_empty",
            Self::TooLarge => "source_too_large",
            Self::Changed => "source_changed",
            Self::AccessDenied => "source_access_denied",
            Self::Io => "source_io_error",
            Self::Budget => "source_read_budget",
            Self::AclUnavailable => "source_acl_unavailable",
            Self::AclUnsupported => "source_acl_unsupported",
            Self::RootIdentityChanged => "source_root_identity_changed",
            Self::IdentityUnavailable => "source_identity_unavailable",
            Self::ContainmentUnavailable => "source_containment_unavailable",
            Self::CloseFailed => "source_close_failed",
        }
    }
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
    std::io::stdin()
        .take((INPUT_LIMIT + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| Error::Input)?;
    let request = parse_request(&input)?;
    write_frame(std::io::stdout().lock(), &request, capture(&request))
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
