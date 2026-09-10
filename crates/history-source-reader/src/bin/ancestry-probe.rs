//! Owned differential probe: parse ancestry claims from records on stdin.
//!
//! Reads a bounded JSON array of {rolloutId, base64Record} and prints the
//! linked chain. It opens nothing and grants nothing; the caller supplies
//! bytes it already holds. Used by the native read oracle to prove this
//! parser agrees with what a real Codex binary wrote and inherited from.
use serde::Deserialize;
use std::io::Read;
use stepsemble_history_source_reader::codex_paginated_ancestry as ancestry;

const INPUT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    rollout_id: String,
    /// Standard base64 so the record's exact bytes survive transport.
    base64_record: String,
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
    let Ok(entries) = serde_json::from_slice::<Vec<Entry>>(&input) else {
        std::process::exit(2);
    };
    let mut claims = Vec::with_capacity(entries.len());
    for entry in &entries {
        let Some(bytes) = decode_base64(&entry.base64_record) else {
            std::process::exit(2);
        };
        match ancestry::read_claim(&entry.rollout_id, &bytes) {
            Ok(claim) => claims.push(claim),
            Err(error) => {
                println!("{}", serde_json::json!({"error": error.code()}));
                return;
            }
        }
    }
    match ancestry::link(claims) {
        Ok(chain) => println!("{}", serde_json::to_string(&chain).unwrap()),
        Err(error) => println!("{}", serde_json::json!({"error": error.code()})),
    }
}
