use serde_json::{Value, json};
use std::{
    cell::Cell,
    io::{self, Cursor, Read, Seek, SeekFrom},
};
use stepsemble_history_source_reader::{
    codex_rollout_format as format, codex_rollout_structure as structure, jsonl_scan as scan,
};
const ID: &str = "01234567-89ab-4def-8123-456789abcdef";
const VERSION: &str = "0.153.4";
fn event(name: &str, data: Value) -> Value {
    let mut p = data.as_object().unwrap().clone();
    p.insert("type".into(), json!(name));
    json!({"type":"event_msg","payload":p})
}
fn start(id: &str) -> Value {
    event("task_started", json!({"turn_id":id}))
}
fn command(phase: &str, turn: &str, call: &str) -> Value {
    event(
        &format!("exec_command_{phase}"),
        json!({"turn_id":turn,"call_id":call}),
    )
}
fn bytes(rows: &[Value]) -> Vec<u8> {
    let mut s = serde_json::to_string(
        &json!({"type":"session_meta","payload":{"id":ID,"cli_version":VERSION}}),
    )
    .unwrap()
        + "\r\n";
    for row in rows {
        s.push_str(&serde_json::to_string(row).unwrap());
        s.push_str("\r\n");
    }
    s.into_bytes()
}
fn page(bytes: &[u8], offset: u32, limit: u32) -> Result<structure::Page, structure::Error> {
    structure::scan_page(
        &mut Cursor::new(bytes),
        bytes.len() as u64,
        scan::Selection { offset, limit },
        ID,
        VERSION,
        None,
        || Ok(()),
    )
}
#[test]
fn original_ids_and_late_tool_edges_are_identical_on_both_sides_of_a_page_boundary() {
    let b = bytes(&[
        start("A🐾"),
        command("begin", "A🐾", "call"),
        event("task_complete", json!({"turn_id":"A🐾"})),
        start("B"),
        command("end", "A🐾", "call"),
    ]);
    let p = page(&b, 2, 1).unwrap();
    let q = page(&b, 5, 1).unwrap();
    assert_eq!(
        p.structure.annotations[0]
            .tool
            .as_ref()
            .unwrap()
            .related_record_index,
        Some(5)
    );
    assert_eq!(
        q.structure.annotations[0]
            .tool
            .as_ref()
            .unwrap()
            .related_record_index,
        Some(2)
    );
    assert_eq!(p.structure.turns, q.structure.turns);
    assert_eq!(q.structure.turns[0].native_turn_id.as_deref(), Some("A🐾"));
    assert_eq!(p.structure.total_turns, 2);
    assert_eq!(p.structure.turns.len(), 1);
    assert_eq!(p.structure.turns[0].last_record_index, 5);
}
#[test]
fn duplicate_call_outside_selected_page_revokes_both_previous_edges() {
    let b = bytes(&[
        start("A"),
        command("begin", "A", "call"),
        command("end", "A", "call"),
        command("begin", "A", "call"),
    ]);
    for i in [2, 3, 4] {
        let p = page(&b, i, 1).unwrap();
        let a = &p.structure.annotations[0];
        assert_eq!(a.tool.as_ref().unwrap().related_record_index, None);
        assert!(a.warnings.contains(&"ambiguous_tool_reference"));
    }
}
#[test]
fn duplicate_native_membership_recovers_unique_survivor_then_allows_retired_id_reuse() {
    let b = bytes(&[
        start("A"),
        start("A"),
        command("begin", "A", "ambiguous"),
        event("thread_rolled_back", json!({"num_turns":1})),
        command("begin", "A", "survivor"),
        event("thread_rolled_back", json!({"num_turns":1})),
        start("A"),
        command("end", "A", "survivor"),
    ]);
    assert_eq!(
        page(&b, 3, 1).unwrap().structure.annotations[0].turn_key,
        None
    );
    assert_eq!(
        page(&b, 5, 1).unwrap().structure.annotations[0]
            .turn_key
            .as_deref(),
        Some("record-1")
    );
    let p = page(&b, 8, 1).unwrap();
    assert_eq!(
        p.structure.annotations[0].turn_key.as_deref(),
        Some("record-7")
    );
    assert_eq!(
        p.structure.annotations[0]
            .tool
            .as_ref()
            .unwrap()
            .related_record_index,
        None
    );
    assert_eq!(p.structure.total_turns, 3);
    assert_eq!(p.structure.retained_turns, 1);
    assert_eq!(
        page(&b, 1, 1).unwrap().structure.turns[0].rollback_record_index,
        Some(6)
    );
}
#[test]
fn malformed_off_page_record_prevents_any_structure_and_repair_recovers() {
    let mut b = bytes(&[
        start("A"),
        event("agent_message", json!({"message":"kept"})),
    ]);
    let valid = b.clone();
    b.extend_from_slice(b"!\n");
    assert!(matches!(
        page(&b, 1, 1),
        Err(structure::Error::Format(format::Error::InvalidRecord))
    ));
    assert!(page(&valid, 1, 1).is_ok());
}
#[test]
fn full_raw_bytes_and_metadata_unknown_rollback_survive_all_small_pages() {
    let b = bytes(&[
        start("A"),
        json!({"type":"future","payload":{"never":"execute"}}),
        event("thread_rolled_back", json!({"num_turns":1})),
    ]);
    let mut all = Vec::new();
    for i in 0..4 {
        let p = page(&b, i, 1).unwrap();
        all.extend_from_slice(&p.records.records[0].bytes);
        assert_eq!(p.validation.records_validated, 4);
        assert_eq!(p.structure.annotations.len(), 1);
    }
    assert_eq!(all, b);
    let p = page(&b, 2, 1).unwrap();
    assert_eq!(p.structure.turns[0].branch_state, "rolled_back");
    assert!(
        p.structure.annotations[0]
            .warnings
            .contains(&"unknown_record_preserved")
    );
}
#[test]
fn large_source_exceeds_old_byte_record_and_turn_limits_without_retaining_unselected_annotations() {
    let rows: Vec<_> = (0..16384)
        .map(|i| event("user_message", json!({"message":"owned".repeat(140),"i":i})))
        .collect();
    let b = bytes(&rows);
    assert!(b.len() > 8 * 1024 * 1024);
    let p = page(&b, 16380, 50).unwrap();
    assert_eq!(p.structure.total_turns, 16384);
    assert_eq!(p.structure.annotations.len(), 5);
    assert_eq!(p.structure.turns.len(), 5);
    assert_eq!(p.records.next_offset, None);
    assert_eq!(p.validation.records_validated, 16385);
}
#[test]
fn raw_byte_page_limit_also_trims_annotations_and_turns() {
    let rows: Vec<_> = (0..5)
        .map(|_| event("user_message", json!({"message":"x".repeat(120*1024)})))
        .collect();
    let p = page(&bytes(&rows), 1, 50).unwrap();
    assert_eq!(p.records.records.len(), 2);
    assert_eq!(p.structure.annotations.len(), 2);
    assert_eq!(p.structure.turns.len(), 2);
    assert_eq!(p.structure.total_turns, 5);
    assert_eq!(p.records.next_offset, Some(3));
}
#[test]
fn eof_has_global_counts_but_no_unselected_turn_disclosure() {
    let b = bytes(&[start("A")]);
    let p = page(&b, 2, 50).unwrap();
    assert_eq!(p.structure.total_turns, 1);
    assert!(p.structure.annotations.is_empty());
    assert!(p.structure.turns.is_empty());
    assert_eq!(p.records.next_offset, None);
    assert!(page(&b, 3, 1).is_err());
    assert!(page(&b, 0, 0).is_err());
    assert!(page(&b, 0, 51).is_err());
}
#[test]
fn cancellation_is_observed_during_both_passes() {
    let b = bytes(&[start("A")]);
    let steps = Cell::new(0);
    structure::scan_page(
        &mut Cursor::new(&b),
        b.len() as u64,
        scan::Selection {
            offset: 0,
            limit: 1,
        },
        ID,
        VERSION,
        None,
        || {
            steps.set(steps.get() + 1);
            Ok(())
        },
    )
    .unwrap();
    for stop in [1, steps.get() / 2, steps.get() - 1] {
        let mut n = 0;
        let p = structure::scan_page(
            &mut Cursor::new(&b),
            b.len() as u64,
            scan::Selection {
                offset: 0,
                limit: 1,
            },
            ID,
            VERSION,
            None,
            || {
                n += 1;
                if n == stop {
                    Err(scan::Error::Cancelled)
                } else {
                    Ok(())
                }
            },
        );
        assert!(matches!(
            p,
            Err(structure::Error::Scan(scan::Error::Cancelled))
        ));
    }
}
struct Changed {
    input: Cursor<Vec<u8>>,
    scans: u32,
    at: Option<usize>,
}
impl Read for Changed {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        self.input.read(b)
    }
}
impl Seek for Changed {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        if matches!(p, SeekFrom::Start(0)) {
            self.scans += 1;
            if self.scans == 2 {
                let b = self.input.get_mut();
                let last = self.at.unwrap_or(b.len() - 4);
                b[last] ^= 1;
            }
        }
        self.input.seek(p)
    }
}
#[test]
fn matching_scan_change_drops_complete_first_pass_structure() {
    let b = bytes(&[
        start("A"),
        event("agent_message", json!({"message":"unchanged first page"})),
    ]);
    let size = b.len() as u64;
    let p = structure::scan_page(
        &mut Changed {
            input: Cursor::new(b),
            scans: 0,
            at: None,
        },
        size,
        scan::Selection {
            offset: 1,
            limit: 1,
        },
        ID,
        VERSION,
        None,
        || Ok(()),
    );
    assert!(matches!(
        p,
        Err(structure::Error::Scan(scan::Error::Changed))
    ));
}
#[test]
fn matching_turn_start_mutation_is_source_changed_not_structure_invalid() {
    let b = bytes(&[start("A"), command("begin", "A", "call")]);
    let needle = b"\"turn_id\":\"A\"";
    let start = b.windows(needle.len()).position(|v| v == needle).unwrap();
    for at in [start + needle.len() - 2, start] {
        let result = structure::scan_page(
            &mut Changed {
                input: Cursor::new(b.clone()),
                scans: 0,
                at: Some(at),
            },
            b.len() as u64,
            scan::Selection {
                offset: 2,
                limit: 1,
            },
            ID,
            VERSION,
            None,
            || Ok(()),
        );
        assert!(matches!(
            result,
            Err(structure::Error::Scan(scan::Error::Changed))
        ));
    }
}
