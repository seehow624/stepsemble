//! Synthetic native-shaped metadata fixtures; these do not prove native
//! materialization. The separate owned native oracle checks interoperability.
use serde_json::{Value, json};
use stepsemble_history_source_reader::codex_paginated_ancestry as ancestry;

const ROOT: &str = "0f1e2d3c-4b5a-4697-8899-aabbccddeeff";
const CHILD: &str = "11223344-5566-4778-899a-abbccddeeff0";

/// An inheriting rollout's metadata ordinal starts at its inherited cutoff.
fn session_meta(id: &str, history_base: Option<Value>) -> Vec<u8> {
    let ordinal = history_base
        .as_ref()
        .and_then(|base| base.get("end_ordinal_exclusive"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), json!(id));
    payload.insert("session_id".into(), json!(id));
    payload.insert("timestamp".into(), json!("2026-01-05T12:00:00Z"));
    payload.insert("cwd".into(), json!("/owned/never-open"));
    payload.insert("originator".into(), json!("codex"));
    payload.insert("cli_version".into(), json!("0.153.4"));
    payload.insert("source".into(), json!("cli"));
    payload.insert("model_provider".into(), json!("paginated_fixture"));
    payload.insert("history_mode".into(), json!("paginated"));
    if let Some(base) = history_base {
        payload.insert("history_base".into(), base);
    }
    let record = json!({
        "timestamp": "2026-01-05T12:00:00Z",
        "ordinal": ordinal,
        "type": "session_meta",
        "payload": payload,
    });
    format!("{record}\n").into_bytes()
}

#[test]
fn parses_native_shaped_metadata_with_an_inherited_ordinal() {
    // Synthetic cutoff: no file is opened or materialized by this test.
    let fork_cutoff = json!({
        "thread_id": ROOT,
        "end_ordinal_exclusive": 6,
        "end_byte_offset": 1042,
    });

    let child = ancestry::read_claim(CHILD, &session_meta(CHILD, Some(fork_cutoff))).unwrap();
    let root = ancestry::read_claim(ROOT, &session_meta(ROOT, None)).unwrap();

    let base = child.history_base.clone().unwrap();
    assert_eq!(base.thread_id, ROOT);
    assert_eq!(base.end_ordinal_exclusive, "6");
    assert_eq!(base.end_byte_offset, "1042");

    let chain = ancestry::link(vec![child, root]).unwrap();
    assert_eq!(chain.profile, ancestry::PROFILE);
    assert_eq!(chain.links.len(), 2);
    assert!(chain.reached_root);
    // Even a fully resolved chain stays inert and unproven.
    assert!(!chain.source_authenticated);
    assert!(!chain.history_complete);
}

#[test]
fn extra_records_after_the_metadata_are_not_consumed_by_this_parser() {
    // This parser reads exactly one metadata record. Feeding it a whole file
    // must fail rather than quietly parsing only the first line.
    let mut whole_file = session_meta(ROOT, None);
    whole_file.extend_from_slice(
        format!(
            "{}\n",
            json!({"timestamp":"2026-01-05T12:00:00Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"root-turn-1"}})
        )
        .as_bytes(),
    );
    assert_eq!(
        ancestry::read_claim(ROOT, &whole_file),
        Err(ancestry::Error::InvalidRecord)
    );
}

#[test]
fn a_windows_written_record_is_accepted_without_changing_meaning() {
    let posix = session_meta(ROOT, None);
    let text = String::from_utf8(posix).unwrap();
    let windows = text.replace('\n', "\r\n");
    let claim = ancestry::read_claim(ROOT, windows.as_bytes()).unwrap();
    assert_eq!(claim.rollout_id, ROOT);
    assert_eq!(claim.history_base, None);
}
