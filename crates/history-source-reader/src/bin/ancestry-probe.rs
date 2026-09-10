//! Owned differential probe: parse ancestry claims from records on stdin.
//!
//! Reads a bounded JSON array of {rolloutId, base64Record} and prints the
//! linked chain. It opens nothing and grants nothing; the caller supplies
//! bytes it already holds. Used by the native read oracle to prove this
//! parser agrees with what a real Codex binary wrote and inherited from.
use serde::Deserialize;
use std::io::Read;
use stepsemble_history_source_reader::codex_paginated_ancestry as ancestry;
use stepsemble_history_source_reader::codex_paginated_chain as chain_plan;

const INPUT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    rollout_id: String,
    /// Standard base64 so the record's exact bytes survive transport.
    base64_record: String,
    /// Repository-relative locator for this rollout, when the caller also
    /// wants the chain resolution plan validated.
    rollout_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    entries: Vec<Entry>,
    /// Stable thread ID, which differs from the head rollout after a revert.
    thread_id: Option<String>,
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let mut buffer = 0_u32;
        let mut padding = 0;
        for &byte in chunk {
            buffer <<= 6;
            if byte == b'=' {
                padding += 1;
            } else {
                let index = TABLE.iter().position(|&c| c == byte)?;
                buffer |= index as u32;
            }
        }
        let decoded = buffer.to_be_bytes();
        out.push(decoded[1]);
        if padding < 2 {
            out.push(decoded[2]);
        }
        if padding < 1 {
            out.push(decoded[3]);
        }
    }
    Some(out)
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut input = Vec::new();
    if std::env::args_os().count() != 1
        || std::io::stdin()
            .take((INPUT_LIMIT + 1) as u64)
            .read_to_end(&mut input)
            .is_err()
        || input.len() > INPUT_LIMIT
    {
        std::process::exit(2);
    }
    // Accept the original array form and the richer object form that also
    // asks for a chain plan, so existing callers keep working unchanged.
    let parsed = serde_json::from_slice::<Input>(&input).or_else(|_| {
        serde_json::from_slice::<Vec<Entry>>(&input).map(|entries| Input {
            entries,
            thread_id: None,
        })
    });
    let Ok(Input { entries, thread_id }) = parsed else {
        std::process::exit(2);
    };
    let mut claims = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let Some(bytes) = decode_base64(&entry.base64_record) else {
            std::process::exit(2);
        };
        // The selected head can be a reverted file: native metadata keeps the
        // stable thread ID while its locator carries a distinct physical ID.
        // Ancestors continue to use their own physical IDs for both fields.
        let metadata_id = if index == 0 {
            thread_id
                .clone()
                .unwrap_or_else(|| entry.rollout_id.clone())
        } else {
            entry
                .rollout_path
                .as_deref()
                .and_then(stepsemble_history_source_reader::codex_locator::stable_thread_id)
                .unwrap_or_else(|| entry.rollout_id.clone())
        };
        match ancestry::read_claim_with_metadata_id(&metadata_id, &entry.rollout_id, &bytes) {
            Ok(claim) => claims.push(claim),
            Err(error) => {
                println!("{}", serde_json::json!({"error": error.code()}));
                return;
            }
        }
    }
    let chain = match ancestry::link(claims) {
        Ok(chain) => chain,
        Err(error) => {
            println!("{}", serde_json::json!({"error": error.code()}));
            return;
        }
    };
    let mut output = serde_json::to_value(&chain).unwrap();
    // A plan is only produced when the caller supplied every locator.
    if let Some(thread_id) = thread_id.as_deref()
        && entries.iter().all(|entry| entry.rollout_path.is_some())
    {
        let locators: Vec<_> = entries
            .iter()
            .map(|entry| chain_plan::Locator {
                rollout_id: &entry.rollout_id,
                rollout_path: entry.rollout_path.as_deref().unwrap(),
            })
            .collect();
        match chain_plan::plan(thread_id, &entries[0].rollout_id, &chain, &locators) {
            Ok(plan) => output["plan"] = serde_json::to_value(&plan).unwrap(),
            Err(error) => {
                println!("{}", serde_json::json!({"error": error.code()}));
                return;
            }
        }
    }
    println!("{}", serde_json::to_string(&output).unwrap());
}
