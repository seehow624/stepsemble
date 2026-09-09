use std::io::Cursor;
use stepsemble_history_source_reader::{
    codex_rollout_format::{Error, PROFILE, Validator},
    jsonl_scan,
};
const ID: &str = "11111111-1111-4111-8111-111111111111";
fn meta() -> Vec<u8> {
    format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\",\"cli_version\":\"0.153.4\",\"history_mode\":\"legacy\"}}}}\n").into_bytes()
}
fn validate(
    records: &[Vec<u8>],
) -> Result<stepsemble_history_source_reader::codex_rollout_format::Validation, Error> {
    let mut v = Validator::new(ID)?;
    for (i, bytes) in records.iter().enumerate() {
        v.record(i as u32, bytes)?;
    }
    v.finish()
}
#[test]
fn selected_metadata_fork_unknown_records_and_blank_lines_are_preserved() {
    let fork = String::from_utf8(meta())
        .unwrap()
        .replace(ID, "22222222-2222-4222-8222-222222222222")
        .into_bytes();
    let v = validate(&[
        b"\r\n".to_vec(),
        meta(),
        b"{\"type\":\"future\",\"payload\":{\"execute\":\"never\",\"path\":\"/never/read\"}}\n"
            .to_vec(),
        fork,
    ])
    .unwrap();
    assert_eq!(v.profile, PROFILE);
    assert_eq!(v.records_validated, 4);
    assert_eq!(v.selected_metadata_record, 1);
    assert_eq!(v.metadata_records, 2);
    assert_eq!(v.history_mode, "legacy");
}
#[test]
fn native_writer_version_is_not_the_reader_version_or_a_capability() {
    let old = String::from_utf8(meta())
        .unwrap()
        .replace("0.153.4", "0.99.0")
        .replace(",\"history_mode\":\"legacy\"", "");
    assert!(validate(&[old.into_bytes()]).is_ok());
}
#[test]
fn first_nonblank_record_must_match_selected_thread_exactly() {
    for raw in [
        b"{\"type\":\"event_msg\"}\n".to_vec(),
        String::from_utf8(meta())
            .unwrap()
            .replace(ID, "22222222-2222-4222-8222-222222222222")
            .into_bytes(),
    ] {
        assert_eq!(
            validate(&[b"\n".to_vec(), raw]).unwrap_err(),
            Error::SelectedThreadMismatch
        );
    }
    assert_eq!(
        validate(&[b"\n".to_vec()]).unwrap_err(),
        Error::InvalidMetadata
    );
    assert!(Validator::new("not-uuid").is_err());
}
#[test]
fn later_metadata_cannot_hide_paginated_or_unknown_mode() {
    for (mode, error) in [
        ("\"paginated\"", Error::PaginatedUnsupported),
        ("\"future\"", Error::HistoryModeUnknown),
        ("null", Error::HistoryModeUnknown),
        ("3", Error::HistoryModeUnknown),
    ] {
        let row = String::from_utf8(meta())
            .unwrap()
            .replace("\"legacy\"", mode)
            .into_bytes();
        assert_eq!(validate(std::slice::from_ref(&row)).unwrap_err(), error);
        assert_eq!(validate(&[meta(), row]).unwrap_err(), error);
    }
    for raw in [
        "{\"type\":\"session_meta\"}\n",
        "{\"type\":\"session_meta\",\"payload\":{\"id\":null}}\n",
    ] {
        assert_eq!(
            validate(&[meta(), raw.as_bytes().to_vec()]).unwrap_err(),
            Error::InvalidMetadata
        );
    }
}
#[test]
fn invalid_utf8_json_unicode_numbers_and_record_envelopes_are_rejected() {
    assert_eq!(
        validate(&[meta(), vec![255, 10]]).unwrap_err(),
        Error::InvalidUtf8
    );
    for raw in [
        "{}\n",
        "[]\n",
        "null\n",
        "{\"type\":\"future\",\"x\":1e400}\n",
        "{\"type\":\"future\",\"x\":\"\\ud800\"}\n",
        "{\"type\":\"future\",\"\\ud800\":0}\n",
        "{\"type\":\"a\\u0000\"}\n",
        "{\"type\":\"future\"}{}\n",
        "\u{feff}{\"type\":\"future\"}\n",
    ] {
        assert_eq!(
            validate(&[meta(), raw.as_bytes().to_vec()]).unwrap_err(),
            Error::InvalidRecord,
            "case {raw:?}"
        );
    }
}
#[test]
fn whitespace_matches_ecmascript_and_crlf_survives() {
    for c in [
        '\t', '\u{b}', '\u{c}', '\r', '\u{a0}', '\u{1680}', '\u{200a}', '\u{2028}', '\u{2029}',
        '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
    ] {
        let raw = format!("{c}\n").into_bytes();
        assert_eq!(
            validate(&[raw, meta()]).unwrap().selected_metadata_record,
            1
        );
    }
    for c in ['\u{85}', '\u{180e}', '\u{200b}'] {
        assert_eq!(
            validate(&[meta(), format!("{c}\n").into_bytes()]).unwrap_err(),
            Error::InvalidRecord
        );
    }
}
#[test]
fn depth_and_utf16_type_limits_match_existing_raw_contract() {
    for (n, expected) in [(63, true), (64, false)] {
        let raw = format!(
            "{{\"type\":\"future\",\"payload\":{}null{}}}\n",
            "[".repeat(n),
            "]".repeat(n)
        )
        .into_bytes();
        assert_eq!(validate(&[meta(), raw]).is_ok(), expected);
    }
    for (name, expected) in [
        ("a".repeat(128), true),
        ("a".repeat(129), false),
        ("🐾".repeat(64), true),
        ("🐾".repeat(65), false),
    ] {
        assert_eq!(
            validate(&[meta(), format!("{{\"type\":\"{name}\"}}\n").into_bytes()]).is_ok(),
            expected
        );
    }
}
#[test]
fn errors_poison_the_validator_and_noncontiguous_or_incomplete_rows_fail() {
    for bad in [b"{\"type\":\"x\"}".to_vec(), b"\n\n".to_vec(), vec![]] {
        let mut v = Validator::new(ID).unwrap();
        v.record(0, &meta()).unwrap();
        assert_eq!(v.record(1, &bad), Err(Error::InvalidRecord));
        assert_eq!(v.record(1, b"\n"), Err(Error::InvalidRecord));
        assert_eq!(v.finish().unwrap_err(), Error::InvalidRecord);
    }
    let mut v = Validator::new(ID).unwrap();
    assert_eq!(v.record(1, &meta()), Err(Error::RecordLimit));
    let mut large = vec![b' '; jsonl_scan::RECORD_BYTES + 1];
    *large.last_mut().unwrap() = b'\n';
    assert_eq!(validate(&[meta(), large]).unwrap_err(), Error::RecordLimit);
}
#[test]
fn invalid_unselected_record_prevents_any_page_and_validation_receipt() {
    let mut raw = meta();
    for _ in 0..1000 {
        raw.extend_from_slice(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"raw\"}}\n");
    }
    raw.extend_from_slice(b"{\"type\":\"PRIVATE_BAD_TAIL\",\"payload\":\n");
    let mut v = Validator::new(ID).unwrap();
    let result = jsonl_scan::scan_matching_page(
        &mut Cursor::new(&raw),
        raw.len() as u64,
        jsonl_scan::Selection {
            offset: 0,
            limit: 1,
        },
        None,
        || Ok(()),
        |i, _, b| v.record(i, b).map_err(|_| jsonl_scan::Error::InvalidRecord),
    );
    assert_eq!(result.unwrap_err(), jsonl_scan::Error::InvalidRecord);
    assert_eq!(v.finish().unwrap_err(), Error::InvalidRecord);
}
#[test]
fn selected_page_and_complete_validation_keep_distinct_counts() {
    let mut raw = meta();
    for _ in 0..1000 {
        raw.extend_from_slice(b"\n");
    }
    let mut v = Validator::new(ID).unwrap();
    let page = jsonl_scan::scan_matching_page(
        &mut Cursor::new(&raw),
        raw.len() as u64,
        jsonl_scan::Selection {
            offset: 999,
            limit: 50,
        },
        None,
        || Ok(()),
        |i, _, b| v.record(i, b).map_err(|_| jsonl_scan::Error::InvalidRecord),
    )
    .unwrap();
    let proof = v.finish().unwrap();
    assert_eq!(proof.records_validated, page.summary.record_count);
    assert_eq!(proof.records_validated, 1001);
    assert_eq!(page.records.len(), 2);
    assert_eq!(proof.selected_metadata_record, 0);
}
