#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Owned process gate for protocol 16's fixed `thread_history_1.sqlite`
//! boundary. It never discovers a native home or reads a real user database.
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use stepsemble_history_source_reader::sqlite_metadata::NATIVE_VERSION;
use stepsemble_history_source_reader::sqlite_paginated::{
    ITEMS_SCHEMA, PROJECTION_SCHEMA, TURNS_SCHEMA,
};

const THREAD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

fn fixture() -> (tempfile::TempDir, Connection, PathBuf) {
    let dir = tempfile::tempdir().expect("owned temp dir");
    let path = dir.path().join("thread_history_1.sqlite");
    let db = Connection::open(&path).expect("owned sqlite");
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .expect("wal");
    for schema in [TURNS_SCHEMA, ITEMS_SCHEMA, PROJECTION_SCHEMA] {
        db.execute_batch(schema).expect("schema");
    }
    db.execute("INSERT INTO thread_history_projection_state(thread_id,next_rollout_byte_offset,next_rollout_ordinal) VALUES(?1,42,3)", [THREAD]).expect("checkpoint");
    db.execute("INSERT INTO thread_turns(thread_id,turn_id,rollout_ordinal,status,first_user_item_id,final_agent_item_id) VALUES(?1,'turn-1',0,'completed','item-1','item-2')", [THREAD]).expect("turn");
    db.execute("INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type,updated_at_ordinal) VALUES(?1,'turn-1','item-1',0,0,'{}','userMessage',0)", [THREAD]).expect("item");
    (dir, db, path)
}

fn read_frame(mut bytes: Vec<u8>) -> (Value, Vec<u8>) {
    assert!(bytes.len() >= 4);
    let size = u32::from_be_bytes(bytes[..4].try_into().expect("length")) as usize;
    assert!(size > 0 && size <= 16 * 1024 && bytes.len() >= size + 4);
    let header: Value = serde_json::from_slice(&bytes[4..4 + size]).expect("header");
    bytes.drain(..4 + size);
    (header, bytes)
}

#[test]
fn protocol16_reads_only_owned_history_projection_and_closes_every_descriptor() {
    let (_dir, _db, path) = fixture();
    let root = path
        .parent()
        .expect("root")
        .canonicalize()
        .expect("canonical root");
    let metadata = std::fs::metadata(&root).expect("root metadata");
    let request = json!({"protocolVersion":16,"nonce":"a".repeat(64),"nativeVersion":NATIVE_VERSION,
        "source":{"sqliteRoot":root.to_str().expect("utf8"),"threadId":THREAD},
        "expectedRoot":{"device":metadata.dev().to_string(),"inode":metadata.ino().to_string()}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_stepsemble-history-source-reader"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("helper");
    let mut input = child.stdin.take().expect("stdin");
    input
        .write_all(serde_json::to_string(&request).expect("json").as_bytes())
        .expect("write");
    drop(input);
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_end(&mut stdout)
        .expect("stdout read");
    let mut stderr = Vec::new();
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_end(&mut stderr)
        .expect("stderr read");
    let status = child.wait().expect("wait");
    assert!(status.success(), "helper failed");
    assert!(stderr.is_empty());
    let (header, payload) = read_frame(stdout);
    assert_eq!(header["protocolVersion"], 16);
    assert_eq!(header["nonce"], "a".repeat(64));
    assert_eq!(
        header["result"]["kind"],
        "native_sqlite_paginated_checkpoint"
    );
    assert_eq!(header["result"]["sourceAuthenticated"], false);
    assert_eq!(header["result"]["publishable"], false);
    assert_eq!(
        header["result"]["byteLength"].as_u64(),
        Some(payload.len() as u64)
    );
    assert_eq!(
        header["result"]["sha256"],
        format!("{:x}", Sha256::digest(&payload))
    );
    let body: Value = serde_json::from_slice(&payload).expect("body");
    assert_eq!(body["observation"]["threadId"], THREAD);
    assert_eq!(body["observation"]["checkpoint"]["nextRolloutOrdinal"], "3");
    assert_eq!(body["observation"]["itemCount"], "1");
    assert_eq!(body["observation"]["historyComplete"], false);
    assert_eq!(body["sourceDescriptorsClosed"], 4);
    assert_eq!(body["sqliteDescriptorsOpened"], 3);
    assert_eq!(body["sqliteDescriptorsClosed"], 3);
    assert_eq!(body["sourceAuthenticated"], false);
    assert_eq!(body["publishable"], false);
    assert_eq!(
        std::fs::read_dir(root).expect("root list").count(),
        3,
        "database, WAL and SHM remain unchanged"
    );
}
