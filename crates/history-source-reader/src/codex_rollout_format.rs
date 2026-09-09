//! Streaming legacy rollout ENVELOPE validation, not native projection parity.
//! Every record (including outside the selected page) is checked. Only counters
//! and the selected ID survive a call; unknown records/fields remain raw bytes.
use serde::Serialize;
use serde_json::Value;

pub const PROFILE: &str = "codex_legacy_envelope_v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidUtf8,
    InvalidRecord,
    InvalidMetadata,
    SelectedThreadMismatch,
    PaginatedUnsupported,
    HistoryModeUnknown,
    RecordLimit,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidUtf8 => "rollout_invalid_utf8",
            Self::InvalidRecord => "rollout_invalid_record",
            Self::InvalidMetadata => "rollout_invalid_metadata",
            Self::SelectedThreadMismatch => "rollout_selected_thread_mismatch",
            Self::PaginatedUnsupported => "native_paginated_history_unsupported",
            Self::HistoryModeUnknown => "native_history_mode_unknown",
            Self::RecordLimit => "rollout_record_limit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub profile: &'static str,
    pub records_validated: u32,
    pub selected_metadata_record: u32,
    pub metadata_records: u32,
    pub history_mode: &'static str,
}

pub struct Validator {
    thread_id: String,
    records: u32,
    selected: Option<u32>,
    metadata: u32,
    failed: Option<Error>,
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
// ECMAScript trim, not Rust's broader Unicode White_Space (e.g. U+0085).
fn whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn label(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.encode_utf16().count() <= 128
            && !s
                .chars()
                .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
    })
}
fn tree(value: &Value, depth: u32) -> bool {
    if depth > 64 {
        return false;
    }
    match value {
        Value::Array(values) => values.iter().all(|v| tree(v, depth + 1)),
        Value::Object(values) => values.values().all(|v| tree(v, depth + 1)),
        // serde_json already rejects invalid Unicode scalar strings/keys and
        // non-finite numbers. JSON numbers/duplicate fields remain raw in output.
        _ => true,
    }
}
impl Validator {
    pub fn new(thread_id: &str) -> Result<Self, Error> {
        if !uuid(thread_id) {
            return Err(Error::SelectedThreadMismatch);
        }
        Ok(Self {
            thread_id: thread_id.into(),
            records: 0,
            selected: None,
            metadata: 0,
            failed: None,
        })
    }
    pub fn record(&mut self, index: u32, bytes: &[u8]) -> Result<(), Error> {
        self.record_value(index, bytes).map(|_| ())
    }
    /// A bounded observer can use the transient validated value without parsing
    /// twice. It must not retain full records or publish a partial scan.
    pub fn record_value(&mut self, index: u32, bytes: &[u8]) -> Result<Option<Value>, Error> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        let result = self.check_record(index, bytes);
        if let Err(error) = result {
            self.failed = Some(error);
        }
        result
    }
    fn check_record(&mut self, index: u32, bytes: &[u8]) -> Result<Option<Value>, Error> {
        if index != self.records
            || index >= crate::jsonl_scan::RECORDS
            || bytes.len() > crate::jsonl_scan::RECORD_BYTES
        {
            return Err(Error::RecordLimit);
        }
        if bytes.last() != Some(&b'\n') || bytes.iter().filter(|b| **b == b'\n').count() != 1 {
            return Err(Error::InvalidRecord);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| Error::InvalidUtf8)?;
        let mut parsed = None;
        if !text.chars().all(whitespace) {
            let value: Value = serde_json::from_str(text).map_err(|_| Error::InvalidRecord)?;
            if !value.is_object() || !label(&value["type"]) || !tree(&value, 0) {
                return Err(Error::InvalidRecord);
            }
            let is_metadata = value["type"] == "session_meta";
            if self.selected.is_none() && !is_metadata {
                return Err(Error::SelectedThreadMismatch);
            }
            if is_metadata {
                let payload = value["payload"].as_object().ok_or(Error::InvalidMetadata)?;
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| uuid(id))
                    .ok_or(Error::InvalidMetadata)?;
                match payload.get("history_mode") {
                    None => {}
                    Some(Value::String(mode)) if mode == "legacy" => {}
                    Some(Value::String(mode)) if mode == "paginated" => {
                        return Err(Error::PaginatedUnsupported);
                    }
                    _ => return Err(Error::HistoryModeUnknown),
                }
                if self.selected.is_none() {
                    if id != self.thread_id {
                        return Err(Error::SelectedThreadMismatch);
                    }
                    self.selected = Some(index);
                }
                // Later fork metadata may name another thread. Validate it, but
                // NEVER replace selected ownership or infer a live session ID.
                // cli_version is the historical writer version, not permission
                // to run it and not the fixed parser version in the request.
                self.metadata += 1;
            }
            parsed = Some(value);
        }
        self.records += 1;
        Ok(parsed)
    }
    pub fn finish(self) -> Result<Validation, Error> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        Ok(Validation {
            profile: PROFILE,
            records_validated: self.records,
            selected_metadata_record: self.selected.ok_or(Error::InvalidMetadata)?,
            metadata_records: self.metadata,
            history_mode: "legacy",
        })
    }
}
