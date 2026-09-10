use super::*;
use serde_json::json;

const ROOT: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CHILD: &str = "11111111-2222-4333-8444-555555555555";
const GRANDCHILD: &str = "99999999-8888-4777-8666-555555555555";

fn meta(id: &str, history_base: Option<serde_json::Value>) -> Vec<u8> {
    let ordinal = history_base
        .as_ref()
        .and_then(|value| value.get("end_ordinal_exclusive"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), json!(id));
    payload.insert("session_id".into(), json!(id));
    payload.insert("history_mode".into(), json!("paginated"));
    payload.insert("cwd".into(), json!("/owned"));
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

fn base(thread_id: &str, ordinal: u64, offset: u64) -> serde_json::Value {
    json!({
        "thread_id": thread_id,
        "end_ordinal_exclusive": ordinal,
        "end_byte_offset": offset,
    })
}

#[test]
fn reads_a_root_rollout_that_inherits_nothing() {
    let claim = read_claim(ROOT, &meta(ROOT, None)).unwrap();
    assert_eq!(claim.rollout_id, ROOT);
    assert_eq!(claim.history_base, None);
}

#[test]
fn reads_an_inheriting_rollout_and_keeps_offsets_exact() {
    let claim = read_claim(CHILD, &meta(CHILD, Some(base(ROOT, 7, 1234)))).unwrap();
    assert_eq!(
        claim.history_base,
        Some(HistoryBase {
            thread_id: ROOT.into(),
            end_ordinal_exclusive: "7".into(),
            end_byte_offset: "1234".into(),
        })
    );
}

#[test]
fn offsets_beyond_double_precision_survive_exactly() {
    let large = 9_007_199_254_740_993_u64;
    let claim = read_claim(CHILD, &meta(CHILD, Some(base(ROOT, large, large)))).unwrap();
    let history_base = claim.history_base.unwrap();
    assert_eq!(history_base.end_ordinal_exclusive, large.to_string());
    assert_eq!(history_base.end_byte_offset, large.to_string());
}

#[test]
fn a_record_for_another_rollout_is_refused() {
    assert_eq!(
        read_claim(CHILD, &meta(ROOT, None)),
        Err(Error::SelectedThreadMismatch)
    );
}

#[test]
fn a_reverted_head_keeps_stable_metadata_id_but_links_physical_rollout_id() {
    let physical = "0f0f0f0f-1e1e-4d4d-8c8c-3b3b3b3b3b3b";
    let claim = read_claim_with_metadata_id(ROOT, physical, &meta(ROOT, Some(base(ROOT, 7, 1234))))
        .expect("reverted metadata uses stable ID");
    assert_eq!(claim.rollout_id, physical);
    assert_eq!(claim.history_base.as_ref().unwrap().thread_id, ROOT);
    // The compatibility helper remains strict for ordinary sources and does
    // not accidentally accept the stable/physical split.
    assert_eq!(
        read_claim(physical, &meta(ROOT, None)),
        Err(Error::SelectedThreadMismatch)
    );
}

#[test]
fn metadata_ordinal_must_start_at_zero_or_its_history_base_cutoff() {
    let root = format!(
        r#"{{"ordinal":100,"type":"session_meta","payload":{{"id":"{ROOT}","history_mode":"paginated"}}}}
"#
    );
    assert_eq!(
        read_claim(ROOT, root.as_bytes()),
        Err(Error::InvalidOrdinal)
    );

    let child = format!(
        r#"{{"ordinal":6,"type":"session_meta","payload":{{"id":"{CHILD}","history_mode":"paginated","history_base":{{"thread_id":"{ROOT}","end_ordinal_exclusive":7,"end_byte_offset":123}}}}}}
"#
    );
    assert_eq!(
        read_claim(CHILD, child.as_bytes()),
        Err(Error::InvalidOrdinal)
    );
}

#[test]
fn a_legacy_or_missing_history_mode_belongs_to_the_other_validator() {
    let mut record = String::from_utf8(meta(ROOT, None)).unwrap();
    record = record.replace("\"paginated\"", "\"legacy\"");
    assert_eq!(
        read_claim(ROOT, record.as_bytes()),
        Err(Error::HistoryModeUnsupported)
    );
    let without = json!({
        "timestamp": "2026-01-05T12:00:00Z",
        "ordinal": 0,
        "type": "session_meta",
        "payload": { "id": ROOT, "cwd": "/owned" },
    });
    assert_eq!(
        read_claim(ROOT, format!("{without}\n").as_bytes()),
        Err(Error::HistoryModeUnsupported)
    );
}

#[test]
fn a_malformed_history_base_is_refused_rather_than_partially_trusted() {
    let cases = [
        json!({"thread_id": ROOT, "end_ordinal_exclusive": 7}),
        json!({"thread_id": ROOT, "end_ordinal_exclusive": 7, "end_byte_offset": 1, "extra": 1}),
        json!({"thread_id": "not-a-uuid", "end_ordinal_exclusive": 7, "end_byte_offset": 1}),
        json!({"thread_id": ROOT, "end_ordinal_exclusive": -1, "end_byte_offset": 1}),
        json!({"thread_id": ROOT, "end_ordinal_exclusive": 1.5, "end_byte_offset": 1}),
        json!({"thread_id": ROOT, "end_ordinal_exclusive": 0, "end_byte_offset": 1}),
        json!({"thread_id": ROOT, "end_ordinal_exclusive": "7", "end_byte_offset": 1}),
        json!([ROOT, 7, 1]),
    ];
    for case in cases {
        assert_eq!(
            read_claim(CHILD, &meta(CHILD, Some(case.clone()))),
            Err(Error::InvalidHistoryBase),
            "must refuse: {case}"
        );
    }
}

#[test]
fn duplicate_ancestry_keys_are_refused_instead_of_last_key_wins() {
    let records = [
        format!(
            r#"{{"type":"session_meta","payload":{{"id":"{ROOT}","id":"{ROOT}","history_mode":"paginated"}}}}"#
        ),
        format!(
            r#"{{"type":"session_meta","payload":{{"id":"{ROOT}","history_mode":"paginated","history_mode":"paginated"}}}}"#
        ),
        format!(
            r#"{{"type":"session_meta","payload":{{"id":"{CHILD}","history_mode":"paginated","history_base":{{"thread_id":"{ROOT}","end_ordinal_exclusive":7,"end_byte_offset":10}},"history_base":{{"thread_id":"{ROOT}","end_ordinal_exclusive":7,"end_byte_offset":10}}}}}}"#
        ),
        format!(
            r#"{{"type":"session_meta","payload":{{"id":"{CHILD}","history_mode":"paginated","history_base":{{"thread_id":"{ROOT}","thread_id":"{ROOT}","end_ordinal_exclusive":7,"end_byte_offset":10}}}}}}"#
        ),
        format!(
            r#"{{"type":"session_meta","payload":{{"id":"{CHILD}","history_mode":"paginated","history_base":{{"thread_id":"{ROOT}","end_ordinal_exclusive":7,"end_ordinal_exclusive":7,"end_byte_offset":10}}}}}}"#
        ),
        format!(
            r#"{{"type":"session_meta","payload":{{"id":"{CHILD}","history_mode":"paginated","history_base":{{"thread_id":"{ROOT}","end_ordinal_exclusive":7,"end_byte_offset":10,"end_byte_offset":10}}}}}}"#
        ),
    ];
    for record in records {
        assert_eq!(
            read_claim(CHILD, format!("{record}\n").as_bytes()),
            Err(Error::InvalidRecord),
            "duplicate ancestry key must fail closed: {record}"
        );
    }
}

#[test]
fn a_non_metadata_or_unparseable_record_is_refused() {
    assert_eq!(read_claim(ROOT, b"not json\n"), Err(Error::InvalidRecord));
    assert_eq!(
        read_claim(ROOT, b"{\"type\":\"event_msg\",\"payload\":{}}\n"),
        Err(Error::InvalidRecord)
    );
    assert_eq!(read_claim(ROOT, b""), Err(Error::RecordLimit));
    assert_eq!(read_claim(ROOT, &[0xff, b'\n']), Err(Error::InvalidUtf8));
}

#[test]
fn the_claim_must_be_one_complete_lf_record() {
    let record = meta(ROOT, None);
    assert_eq!(
        read_claim(ROOT, &record[..record.len() - 1]),
        Err(Error::InvalidRecord)
    );
    let mut two = record.clone();
    two.extend_from_slice(&record);
    assert_eq!(read_claim(ROOT, &two), Err(Error::InvalidRecord));
    let crlf = record
        .strip_suffix(b"\n")
        .map(|line| [line, b"\r\n"].concat())
        .expect("fixture LF");
    assert!(read_claim(ROOT, &crlf).is_ok());
}

#[test]
fn links_a_chain_from_selected_rollout_to_root() {
    let chain = link(vec![
        read_claim(GRANDCHILD, &meta(GRANDCHILD, Some(base(CHILD, 20, 900)))).unwrap(),
        read_claim(CHILD, &meta(CHILD, Some(base(ROOT, 7, 300)))).unwrap(),
        read_claim(ROOT, &meta(ROOT, None)).unwrap(),
    ])
    .unwrap();
    assert_eq!(
        chain
            .links
            .iter()
            .map(|link| link.rollout_id.as_str())
            .collect::<Vec<_>>(),
        [GRANDCHILD, CHILD, ROOT]
    );
    assert!(chain.reached_root);
    assert!(!chain.source_authenticated);
    // Reaching a root proves the pointers end, never that history is complete.
    assert!(!chain.history_complete);
}

#[test]
fn a_chain_the_caller_stopped_early_is_not_reported_as_rooted() {
    let chain = link(vec![
        read_claim(CHILD, &meta(CHILD, Some(base(ROOT, 7, 300)))).unwrap(),
    ])
    .unwrap();
    assert!(!chain.reached_root);
    assert!(!chain.history_complete);
}

#[test]
fn a_link_that_does_not_match_the_named_ancestor_is_refused() {
    let mismatch = link(vec![
        read_claim(CHILD, &meta(CHILD, Some(base(ROOT, 7, 300)))).unwrap(),
        read_claim(GRANDCHILD, &meta(GRANDCHILD, None)).unwrap(),
    ]);
    assert_eq!(mismatch, Err(Error::ChainMismatch));
}

#[test]
fn a_root_followed_by_more_links_is_refused() {
    let extra = link(vec![
        read_claim(CHILD, &meta(CHILD, None)).unwrap(),
        read_claim(ROOT, &meta(ROOT, None)).unwrap(),
    ]);
    assert_eq!(extra, Err(Error::ChainMismatch));
}

#[test]
fn cycles_are_refused_including_self_reference() {
    let direct = link(vec![
        read_claim(CHILD, &meta(CHILD, Some(base(CHILD, 7, 300)))).unwrap(),
    ]);
    assert_eq!(direct, Err(Error::ChainCycle));

    let indirect = link(vec![
        read_claim(CHILD, &meta(CHILD, Some(base(ROOT, 7, 300)))).unwrap(),
        read_claim(ROOT, &meta(ROOT, Some(base(CHILD, 3, 100)))).unwrap(),
        read_claim(CHILD, &meta(CHILD, Some(base(ROOT, 7, 300)))).unwrap(),
    ]);
    assert_eq!(indirect, Err(Error::ChainCycle));
}

#[test]
fn an_empty_or_over_deep_chain_is_refused() {
    assert_eq!(link(Vec::new()), Err(Error::ChainMismatch));
    let claims = (0..=MAX_DEPTH)
        .map(|_| read_claim(ROOT, &meta(ROOT, None)).unwrap())
        .collect();
    assert_eq!(link(claims), Err(Error::ChainTooDeep));
}
