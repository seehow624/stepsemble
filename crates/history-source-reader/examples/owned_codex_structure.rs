//! Test-only stdin bridge for differential tests; never opens source paths.
use serde::Deserialize;
use std::io::{self, Cursor, Read};
use stepsemble_history_source_reader::{codex_rollout_structure, jsonl_scan};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    rollout: String,
    pages: Vec<Selection>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    offset: u32,
    limit: u32,
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("owned_input_limit".into());
    }
    let input: Input = serde_json::from_slice(&bytes)?;
    if input.pages.is_empty() || input.pages.len() > 64 {
        return Err("owned_selection_limit".into());
    }
    let mut output = Vec::new();
    for page in input.pages {
        let result = codex_rollout_structure::scan_page(
            &mut Cursor::new(input.rollout.as_bytes()),
            input.rollout.len() as u64,
            jsonl_scan::Selection {
                offset: page.offset,
                limit: page.limit,
            },
            "01234567-89ab-4def-8123-456789abcdef",
            "0.153.4",
            None,
            || Ok(()),
        );
        output.push(match result {
            Ok(page) => serde_json::json!({"structure":page.structure,"validation":page.validation,
                "offset":page.records.offset,"nextOffset":page.records.next_offset,
                "records":page.records.records.iter().map(|r| serde_json::json!({"recordIndex":r.record_index,"rawText":String::from_utf8_lossy(&r.bytes)})).collect::<Vec<_>>()}),
            Err(error) => serde_json::json!({"error":format!("{error:?}")}),
        });
    }
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
fn main() {
    // Error text cannot include malformed input, transcripts or source paths.
    if run().is_err() {
        eprintln!("owned_structure_probe_failed");
        std::process::exit(1);
    }
}
