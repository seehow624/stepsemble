//! Full-source bounded structure for one selected legacy page. Not native
//! projection parity, a source grant, execution state or an approval receipt.
//! Caller still owns authentication, deadline and physical-close checks.
//! No full record text is retained. Global state has at most RECORDS compact
//! turns/calls; only PAGE_RECORDS annotations/display identifiers survive.
//! Lookup keys use complete SHA-256, never truncated or displayed as native IDs.
use crate::{codex_rollout_format as format, jsonl_scan as scan};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::HashMap,
    io::{Read, Seek},
};

pub const PROFILE: &str = "codex_legacy_selected_structure_v1";
pub const IDENTIFIER_UNITS: usize = 1024;
type Key = [u8; 32];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Format(format::Error),
    Scan(scan::Error),
    InvalidStructure,
    Allocation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub family: &'static str,
    pub phase: &'static str,
    pub native_call_id: String,
    pub related_record_index: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub record_index: u32,
    pub kind: &'static str,
    pub turn_key: Option<String>,
    pub tool: Option<Tool>,
    pub warnings: Vec<&'static str>,
    #[serde(skip)]
    turn: Option<u32>,
}
impl Annotation {
    fn warn(&mut self, code: &'static str) {
        if !self.warnings.contains(&code) {
            self.warnings.push(code);
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub turn_key: String,
    pub native_turn_id: Option<String>,
    pub boundary: &'static str,
    pub first_record_index: u32,
    pub last_record_index: u32,
    pub recorded_status: &'static str,
    pub status_record_index: Option<u32>,
    pub branch_state: &'static str,
    pub rollback_record_index: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Structure {
    pub structure_profile: &'static str,
    pub total_turns: u32,
    pub retained_turns: u32,
    pub turns: Vec<Turn>,
    pub annotations: Vec<Annotation>,
}
pub struct Page {
    pub records: scan::Page,
    pub validation: format::Validation,
    pub structure: Structure,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Unknown,
    Started,
    Completed,
    Failed,
    Interrupted,
}
impl Status {
    fn text(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }
}
struct CompactTurn {
    native: Option<Key>,
    first: u32,
    last: u32,
    status: Status,
    status_record: Option<u32>,
    rollback: Option<u32>,
    compacted_only: bool,
    has_content: bool,
    uncertain_error: bool,
}
#[derive(Default)]
struct NativeMembers {
    count: u32,
    xor: u32,
}
#[derive(Hash, PartialEq, Eq)]
struct CallKey {
    turn: u32,
    family: &'static str,
    id: Key,
}
#[derive(Default)]
struct Call {
    begin: Option<u32>,
    end: Option<u32>,
    ambiguous: bool,
}
struct Index {
    selection: scan::Selection,
    native_version: String,
    validator: format::Validator,
    turns: Vec<CompactTurn>,
    live: Vec<u32>,
    native: HashMap<Key, NativeMembers>,
    calls: HashMap<CallKey, Call>,
    annotations: Vec<Annotation>,
    current: Option<u32>,
    selected_starts: HashMap<u32, u32>,
    selected_ids: HashMap<u32, String>,
    matching_records: u32,
}
fn identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        !s.is_empty()
            && s.encode_utf16().count() <= IDENTIFIER_UNITS
            && !s
                .chars()
                .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
    })
}
fn key(s: &str) -> Key {
    Sha256::digest(s.as_bytes()).into()
}
fn safe_integer(v: &Value, maximum: f64) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= maximum && n.fract() == 0.0)
        .map(|n| n as u64)
}
fn event_kind(event: &str) -> &'static str {
    match event {
        "user_message" => "user",
        "agent_message" => "assistant",
        "agent_reasoning" | "agent_reasoning_raw_content" => "reasoning",
        "task_started" | "task_complete" | "turn_aborted" | "error" | "thread_rolled_back" => {
            "lifecycle"
        }
        "context_compacted" => "compaction",
        "token_count" => "metadata",
        "entered_review_mode" | "exited_review_mode" => "review",
        "guardian_assessment" => "assessment",
        "item_started" | "item_completed" => "item",
        "sub_agent_activity" => "subagent",
        "hook_started" | "hook_completed" => "hook",
        _ => "unknown",
    }
}
#[derive(Clone, Copy)]
enum Scope {
    Required,
    Optional,
    Current,
}
fn tool_spec(event: &str) -> Option<(&'static str, &'static str, Scope)> {
    use Scope::*;
    Some(match event {
        "exec_command_begin" => ("command", "begin", Required),
        "exec_command_end" => ("command", "end", Required),
        "patch_apply_begin" => ("patch", "begin", Optional),
        "patch_apply_end" => ("patch", "end", Optional),
        "apply_patch_approval_request" => ("patch", "request", Optional),
        "dynamic_tool_call_request" => ("dynamic", "begin", Optional),
        "dynamic_tool_call_response" => ("dynamic", "end", Optional),
        "mcp_tool_call_begin" => ("mcp", "begin", Current),
        "mcp_tool_call_end" => ("mcp", "end", Current),
        "web_search_begin" => ("web", "begin", Current),
        "web_search_end" => ("web", "end", Current),
        "image_generation_begin" => ("image_generation", "begin", Current),
        "image_generation_end" => ("image_generation", "end", Current),
        "view_image_tool_call" => ("image_view", "single", Current),
        "collab_agent_spawn_begin" => ("spawn_agent", "begin", Current),
        "collab_agent_spawn_end" => ("spawn_agent", "end", Current),
        "collab_agent_interaction_begin" => ("send_input", "begin", Current),
        "collab_agent_interaction_end" => ("send_input", "end", Current),
        "collab_waiting_begin" => ("wait_agents", "begin", Current),
        "collab_waiting_end" => ("wait_agents", "end", Current),
        "collab_close_begin" => ("close_agent", "begin", Current),
        "collab_close_end" => ("close_agent", "end", Current),
        "collab_resume_begin" => ("resume_agent", "begin", Current),
        "collab_resume_end" => ("resume_agent", "end", Current),
        _ => return None,
    })
}
fn affects_status(payload: &Value) -> Option<bool> {
    if !payload["message"].is_string() {
        return None;
    }
    let info = &payload["codex_error_info"];
    if info.is_null() {
        return Some(true);
    }
    if let Some(s) = info.as_str() {
        return match s {
            "thread_rollback_failed" => Some(false),
            "context_window_exceeded"
            | "session_budget_exceeded"
            | "usage_limit_exceeded"
            | "rate_limit_exceeded"
            | "server_overloaded"
            | "cyber_policy"
            | "misalignment_policy_violation"
            | "internal_server_error"
            | "unauthorized"
            | "bad_request"
            | "sandbox_error"
            | "other" => Some(true),
            _ => None,
        };
    }
    let entries = info.as_object()?;
    if entries.len() != 1 {
        return None;
    }
    let (name, value) = entries.iter().next()?;
    if name == "active_turn_not_steerable"
        && value.is_object()
        && matches!(value["turn_kind"].as_str(), Some("review" | "compact"))
    {
        return Some(false);
    }
    if matches!(
        name.as_str(),
        "http_connection_failed"
            | "response_stream_connection_failed"
            | "response_stream_disconnected"
            | "response_too_many_failed_attempts"
    ) && value.is_object()
        && (value["http_status_code"].is_null()
            || safe_integer(&value["http_status_code"], 65535.0).is_some())
    {
        return Some(true);
    }
    None
}
impl Index {
    fn new(
        selection: scan::Selection,
        thread_id: &str,
        native_version: &str,
    ) -> Result<Self, Error> {
        if selection.offset > scan::RECORDS
            || selection.limit == 0
            || selection.limit > scan::PAGE_RECORDS
            || native_version.is_empty()
            || native_version.len() > 128
        {
            return Err(Error::InvalidStructure);
        }
        Ok(Self {
            selection,
            native_version: native_version.into(),
            validator: format::Validator::new(thread_id).map_err(Error::Format)?,
            turns: Vec::new(),
            live: Vec::new(),
            native: HashMap::new(),
            calls: HashMap::new(),
            annotations: Vec::with_capacity(selection.limit as usize),
            current: None,
            selected_starts: HashMap::new(),
            selected_ids: HashMap::new(),
            matching_records: 0,
        })
    }
    fn selected(&self, i: u32) -> bool {
        i >= self.selection.offset && i - self.selection.offset < self.selection.limit
    }
    fn open(&mut self, record: u32, id: Option<&str>) -> Result<u32, Error> {
        if self.turns.len() >= scan::RECORDS as usize {
            return Err(Error::InvalidStructure);
        }
        self.turns.try_reserve(1).map_err(|_| Error::Allocation)?;
        self.live.try_reserve(1).map_err(|_| Error::Allocation)?;
        let turn = self.turns.len() as u32;
        let native = id.map(key);
        if let Some(key) = native {
            self.native.try_reserve(1).map_err(|_| Error::Allocation)?;
            let entry = self.native.entry(key).or_default();
            entry.count += 1;
            entry.xor ^= turn;
        }
        self.turns.push(CompactTurn {
            native,
            first: record,
            last: record,
            status: Status::Unknown,
            status_record: None,
            rollback: None,
            compacted_only: false,
            has_content: false,
            uncertain_error: false,
        });
        self.live.push(turn);
        self.current = Some(turn);
        Ok(turn)
    }
    fn target(&self, id: &Value, annotation: &mut Annotation) -> Option<u32> {
        let Some(id) = identifier(id) else {
            annotation.warn("invalid_turn_reference");
            return None;
        };
        match self.native.get(&key(id)) {
            Some(members) if members.count == 1 => Some(members.xor),
            Some(members) if members.count > 1 => {
                annotation.warn("ambiguous_turn_reference");
                None
            }
            _ => {
                annotation.warn("unmatched_turn_reference");
                None
            }
        }
    }
    fn attach(&mut self, a: &mut Annotation, turn: Option<u32>) {
        if let Some(t) = turn {
            a.turn = turn;
            self.turns[t as usize].last = a.record_index;
        }
    }
    fn content(&mut self, turn: u32) {
        let t = &mut self.turns[turn as usize];
        t.has_content = true;
        t.compacted_only = false;
    }
    fn active_or_open(&mut self, record: u32) -> Result<u32, Error> {
        match self.current {
            Some(t) => Ok(t),
            None => self.open(record, None),
        }
    }
    fn update_tool(&mut self, record: u32, related: Option<u32>, ambiguous: bool) {
        let Some(relative) = record.checked_sub(self.selection.offset) else {
            return;
        };
        if let Some(a) = self.annotations.get_mut(relative as usize) {
            if let Some(tool) = &mut a.tool {
                tool.related_record_index = related;
            }
            if ambiguous {
                a.warn("ambiguous_tool_reference");
            }
        }
    }
    fn tool(
        &mut self,
        a: &mut Annotation,
        payload: &Value,
        spec: (&'static str, &'static str, Scope),
    ) -> Result<(), Error> {
        let (family, phase, scope) = spec;
        let explicit = matches!(scope, Scope::Required)
            || matches!(scope, Scope::Optional)
                && !payload["turn_id"].is_null()
                && payload["turn_id"] != "";
        let turn = if explicit {
            self.target(&payload["turn_id"], a)
        } else {
            Some(self.active_or_open(a.record_index)?)
        };
        self.attach(a, turn);
        if let Some(t) = turn {
            self.content(t);
        }
        let Some(id) = identifier(&payload["call_id"]) else {
            a.warn("invalid_tool_reference");
            return Ok(());
        };
        a.tool = Some(Tool {
            family,
            phase,
            native_call_id: if self.selected(a.record_index) {
                id.into()
            } else {
                String::new()
            },
            related_record_index: None,
        });
        let Some(turn) = turn else {
            return Ok(());
        };
        if phase == "single" || phase == "request" {
            return Ok(());
        }
        self.calls.try_reserve(1).map_err(|_| Error::Allocation)?;
        let entry = self
            .calls
            .entry(CallKey {
                turn,
                family,
                id: key(id),
            })
            .or_default();
        let prior = if phase == "begin" {
            &mut entry.begin
        } else {
            &mut entry.end
        };
        if prior.is_some() {
            entry.ambiguous = true;
        } else {
            *prior = Some(a.record_index);
        }
        let (begin, end, ambiguous) = (entry.begin, entry.end, entry.ambiguous);
        if ambiguous {
            a.warn("ambiguous_tool_reference");
            for index in [begin, end].into_iter().flatten() {
                self.update_tool(index, None, true);
            }
        } else if let (Some(begin), Some(end)) = (begin, end) {
            self.update_tool(begin, Some(end), false);
            self.update_tool(end, Some(begin), false);
            if let Some(tool) = &mut a.tool {
                tool.related_record_index = Some(if phase == "begin" { end } else { begin });
            }
        }
        Ok(())
    }
    fn record(
        &mut self,
        index: u32,
        bytes: &[u8],
        checkpoint: &mut impl FnMut() -> Result<(), scan::Error>,
    ) -> Result<(), Error> {
        let record = self
            .validator
            .record_value(index, bytes)
            .map_err(Error::Format)?;
        let mut a = Annotation {
            record_index: index,
            kind: "unknown",
            turn_key: None,
            tool: None,
            warnings: Vec::new(),
            turn: None,
        };
        self.annotate(record.as_ref(), &mut a, checkpoint)?;
        if self.selected(index) {
            self.annotations.push(a);
        }
        Ok(())
    }
    fn annotate(
        &mut self,
        record: Option<&Value>,
        a: &mut Annotation,
        checkpoint: &mut impl FnMut() -> Result<(), scan::Error>,
    ) -> Result<(), Error> {
        let record_type = record.and_then(|r| r["type"].as_str()).unwrap_or("blank");
        let payload = record.map(|r| &r["payload"]).unwrap_or(&Value::Null);
        if record_type == "session_meta"
            && payload["cli_version"].as_str() != Some(self.native_version.as_str())
        {
            return Err(Error::InvalidStructure);
        }
        if matches!(
            record_type,
            "blank"
                | "session_meta"
                | "turn_context"
                | "token_usage_record"
                | "world_state"
                | "security_risk_score"
                | "inter_agent_communication"
                | "inter_agent_communication_metadata"
                | "realtime_item"
        ) {
            a.kind = "metadata";
            return Ok(());
        }
        if record_type == "response_item" {
            a.kind = "model_context";
            self.attach(a, self.current);
            return Ok(());
        }
        if record_type == "compacted" {
            a.kind = "compaction";
            let t = self.active_or_open(a.record_index)?;
            self.turns[t as usize].compacted_only = !self.turns[t as usize].has_content;
            self.attach(a, Some(t));
            return Ok(());
        }
        if record_type != "event_msg" || !payload.is_object() {
            a.warn("unknown_record_preserved");
            self.attach(a, self.current);
            return Ok(());
        }
        let event = payload["type"].as_str().unwrap_or("");
        if let Some(spec) = tool_spec(event) {
            a.kind = "tool";
            return self.tool(a, payload, spec);
        }
        a.kind = event_kind(event);
        if a.kind == "unknown" {
            a.warn("unknown_event_preserved");
            self.attach(a, self.current);
            return Ok(());
        }
        if a.kind == "assistant" && !payload["message"].is_string()
            || a.kind == "reasoning" && !payload["text"].is_string()
        {
            a.warn("invalid_message_preserved");
            self.attach(a, self.current);
            return Ok(());
        }
        match event {
            "task_started" => {
                let Some(id) = identifier(&payload["turn_id"]) else {
                    a.warn("invalid_turn_reference");
                    return Ok(());
                };
                let t = self.open(a.record_index, Some(id))?;
                self.turns[t as usize].status = Status::Started;
                self.turns[t as usize].status_record = Some(a.record_index);
                self.attach(a, Some(t));
                if self.native.get(&key(id)).is_some_and(|v| v.count > 1) {
                    a.warn("ambiguous_turn_reference");
                }
            }
            "task_complete" | "turn_aborted" => {
                let turn = if event == "turn_aborted" && payload["turn_id"].is_null() {
                    self.current
                } else {
                    self.target(&payload["turn_id"], a)
                };
                let Some(t) = turn else {
                    if payload["turn_id"].is_null() {
                        a.warn("unmatched_turn_reference");
                    }
                    return Ok(());
                };
                self.attach(a, Some(t));
                let turn = &mut self.turns[t as usize];
                if event == "turn_aborted" {
                    turn.status = Status::Interrupted;
                } else if !payload["error"].is_null() {
                    if !payload["error"].is_object() || !payload["error"]["message"].is_string() {
                        a.warn("invalid_terminal_error");
                        return Ok(());
                    }
                    turn.status = Status::Failed;
                } else if !matches!(turn.status, Status::Failed | Status::Interrupted) {
                    turn.status = if turn.uncertain_error {
                        a.warn("unclassified_error_preserved");
                        Status::Unknown
                    } else {
                        Status::Completed
                    };
                }
                turn.status_record = Some(a.record_index);
                if event == "task_complete" && self.current == Some(t) {
                    self.current = None;
                }
            }
            "thread_rolled_back" => {
                let Some(count) = safe_integer(&payload["num_turns"], 9_007_199_254_740_991.0)
                else {
                    a.warn("invalid_rollback_count");
                    return Ok(());
                };
                self.current = None;
                for removed in 0..count.min(self.live.len() as u64) {
                    // One rollback record may retire every preceding turn.
                    // Bound cancellation/deadline latency inside that work too.
                    if removed % 256 == 0 {
                        checkpoint().map_err(Error::Scan)?;
                    }
                    let Some(t) = self.live.pop() else {
                        return Err(Error::InvalidStructure);
                    };
                    let turn = &mut self.turns[t as usize];
                    turn.rollback = Some(a.record_index);
                    if let Some(key) = turn.native {
                        let Some(members) = self.native.get_mut(&key) else {
                            return Err(Error::InvalidStructure);
                        };
                        if members.count == 0 {
                            return Err(Error::InvalidStructure);
                        }
                        members.count -= 1;
                        members.xor ^= t;
                        if members.count == 0 {
                            self.native.remove(&key);
                        }
                    }
                }
            }
            "user_message" => {
                if !payload["message"].is_string() {
                    a.warn("invalid_message_preserved");
                    self.attach(a, self.current);
                    return Ok(());
                }
                if self.current.is_some_and(|t| {
                    let t = &self.turns[t as usize];
                    t.native.is_none() && !t.compacted_only
                }) {
                    self.current = None;
                }
                let t = self.active_or_open(a.record_index)?;
                self.content(t);
                self.attach(a, Some(t));
            }
            "error" => {
                self.attach(a, self.current);
                match affects_status(payload) {
                    None => {
                        a.warn("unclassified_error_preserved");
                        if let Some(t) = self.current {
                            self.turns[t as usize].uncertain_error = true;
                        }
                    }
                    Some(true) => {
                        if let Some(t) = self.current {
                            self.turns[t as usize].status = Status::Failed;
                            self.turns[t as usize].status_record = Some(a.record_index);
                        }
                    }
                    Some(false) => {}
                }
            }
            "item_started" | "item_completed" | "entered_review_mode" | "exited_review_mode"
                if !payload["turn_id"].is_null() =>
            {
                let t = self.target(&payload["turn_id"], a);
                self.attach(a, t);
            }
            _ if matches!(
                a.kind,
                "assistant" | "reasoning" | "compaction" | "review" | "item" | "subagent"
            ) =>
            {
                let t = self.active_or_open(a.record_index)?;
                self.content(t);
                self.attach(a, Some(t));
            }
            _ => self.attach(a, self.current),
        }
        Ok(())
    }
    fn matching(&mut self, index: u32, bytes: &[u8]) -> Result<(), Error> {
        if index != self.matching_records {
            return Err(Error::InvalidStructure);
        }
        if index == 0 {
            for t in self.annotations.iter().filter_map(|a| a.turn) {
                if self.turns[t as usize].native.is_some() {
                    self.selected_starts.insert(self.turns[t as usize].first, t);
                }
            }
        }
        // Recover exact display IDs from selected turns' original start records.
        // The scanner still hashes/checks every byte of this matching pass.
        // A changed start record can be malformed or carry a different ID.
        // Do not misclassify that race before the complete digest comparison:
        // collect only matching candidates; finish requires them AFTER the scan.
        if let Some(t) = self.selected_starts.get(&index).copied()
            && let Ok(value) = serde_json::from_slice::<Value>(bytes)
            && let Some(id) = identifier(&value["payload"]["turn_id"])
            && self.turns[t as usize].native == Some(key(id))
        {
            self.selected_ids.insert(t, id.into());
        }
        self.matching_records += 1;
        Ok(())
    }
    fn finish(mut self, records: scan::Page) -> Result<Page, Error> {
        let validation = self.validator.finish().map_err(Error::Format)?;
        if validation.records_validated != records.summary.record_count
            || self.matching_records != records.summary.record_count
            || records.offset != self.selection.offset
            || records.records.len() > self.annotations.len()
        {
            return Err(Error::InvalidStructure);
        }
        self.annotations.truncate(records.records.len());
        let mut selected: Vec<u32> = self.annotations.iter().filter_map(|a| a.turn).collect();
        selected.sort_unstable();
        selected.dedup();
        let mut turns = Vec::with_capacity(selected.len());
        for index in selected {
            let t = &self.turns[index as usize];
            let native_turn_id = if t.native.is_some() {
                Some(
                    self.selected_ids
                        .remove(&index)
                        .ok_or(Error::InvalidStructure)?,
                )
            } else {
                None
            };
            turns.push(Turn {
                turn_key: format!("record-{}", t.first),
                native_turn_id,
                boundary: if t.native.is_some() {
                    "explicit"
                } else {
                    "inferred"
                },
                first_record_index: t.first,
                last_record_index: t.last,
                recorded_status: t.status.text(),
                status_record_index: t.status_record,
                branch_state: if t.rollback.is_some() {
                    "rolled_back"
                } else {
                    "retained"
                },
                rollback_record_index: t.rollback,
            });
        }
        for a in &mut self.annotations {
            a.turn_key = a
                .turn
                .map(|t| format!("record-{}", self.turns[t as usize].first));
        }
        Ok(Page {
            records,
            validation,
            structure: Structure {
                structure_profile: PROFILE,
                total_turns: self.turns.len() as u32,
                retained_turns: self.live.len() as u32,
                turns,
                annotations: self.annotations,
            },
        })
    }
}

/// Uses the caller's existing held-source/checkpoint boundary. An error or
/// cancellation at any point drops all partial annotations and raw bytes.
pub fn scan_page(
    reader: &mut (impl Read + Seek),
    observed_size: u64,
    selection: scan::Selection,
    thread_id: &str,
    native_version: &str,
    expected: Option<scan::Summary>,
    checkpoint: impl FnMut() -> Result<(), scan::Error>,
) -> Result<Page, Error> {
    let mut index = Index::new(selection, thread_id, native_version)?;
    let mut failure = None;
    // Scan and observer callbacks run sequentially. Share the same caller
    // checkpoint rather than creating a second deadline or cancellation source.
    let checkpoint = RefCell::new(checkpoint);
    let result = scan::scan_matching_page_observed(
        reader,
        observed_size,
        selection,
        expected,
        || (checkpoint.borrow_mut())(),
        |pass, i, _, bytes| {
            let result = match pass {
                scan::ScanPass::First => index.record(i, bytes, &mut *checkpoint.borrow_mut()),
                scan::ScanPass::Matching => index.matching(i, bytes),
            };
            result.map_err(|e| {
                failure = Some(e);
                scan::Error::InvalidRecord
            })
        },
    );
    let records = result.map_err(|e| failure.unwrap_or(Error::Scan(e)))?;
    index.finish(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mass_rollback_checks_the_same_cancellation_inside_bounded_batches() {
        let mut index = Index::new(
            scan::Selection {
                offset: 0,
                limit: 1,
            },
            "01234567-89ab-4def-8123-456789abcdef",
            "0.153.4",
        )
        .unwrap();
        for i in 0..(scan::RECORDS - 2) {
            index.open(i + 1, None).unwrap();
        }
        let before = index.live.len();
        let mut a = Annotation {
            record_index: scan::RECORDS - 1,
            kind: "unknown",
            turn_key: None,
            tool: None,
            warnings: Vec::new(),
            turn: None,
        };
        let record = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":before}});
        let mut checks = 0;
        let result = index.annotate(Some(&record), &mut a, &mut || {
            checks += 1;
            if checks == 3 {
                Err(scan::Error::Cancelled)
            } else {
                Ok(())
            }
        });
        assert_eq!(result, Err(Error::Scan(scan::Error::Cancelled)));
        assert_eq!(checks, 3);
        assert_eq!(index.live.len(), before - 512);
        // Partial mutable state is local to a rejected scan, never a Page.
    }
}
