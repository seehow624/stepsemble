//! Test-only pinned writer peer for Node gates. Creates its own temp directory;
//! no path/SQL input, native HOME, credentials or shipped reader write mode.
use rusqlite::{Connection, params};
use serde_json::json;
use std::io::{BufRead, Write};
use stepsemble_history_source_reader::sqlite_metadata::{THREADS_SCHEMA, engine_matches_pin};

const ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn rollout_bytes(mode: &str, changed: bool) -> String {
    format!(
        "{}\n{}\n",
        json!({"type":"session_meta","payload":{"id":ID,"history_mode":mode}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":if changed {"changed"} else {"first"}}})
    )
}
fn index_bytes(changed: bool) -> String {
    format!(
        "{}\n",
        json!({"id":ID,"thread_name":if changed {"  changed index  "} else {"  owned index 🐾  "},"updated_at":"x"})
    )
}
fn send(value: serde_json::Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}
fn main() {
    assert_eq!(std::env::args().count(), 1, "no caller paths or SQL");
    assert!(engine_matches_pin());
    let dir = tempfile::Builder::new()
        .prefix("stepsemble-node-sqlite-owned-")
        .tempdir()
        .unwrap();
    let base = dir.path().canonicalize().unwrap();
    let root = base.join("sqlite");
    let codex = base.join("codex");
    std::fs::create_dir(&root).unwrap();
    let locator = format!("sessions/2026/01/05/rollout-2026-01-05T12-00-00-{ID}.jsonl");
    let rollout = codex.join(&locator);
    std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
    std::fs::write(&rollout, rollout_bytes("legacy", false)).unwrap();
    std::fs::write(codex.join("session_index.jsonl"), index_bytes(false)).unwrap();
    let db = Connection::open(root.join("state_5.sqlite")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE thread_sections(id TEXT PRIMARY KEY);").unwrap();
    db.execute_batch(THREADS_SCHEMA).unwrap();
    db.execute("INSERT INTO threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,first_user_message,name) VALUES(?1,?2,0,0,'cli','owned','owned','base','owned','never','first',NULL)", params![ID, rollout.to_str().unwrap()]).unwrap();
    let busy: i32 = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .unwrap();
    assert_eq!(busy, 0);
    db.execute(
        "UPDATE threads SET title=?1 WHERE id=?2",
        params!["  最新 WAL 名稱 🐾  ", ID],
    )
    .unwrap();
    let root_text = root.to_str().unwrap();
    #[cfg(windows)]
    let root_text = root_text.strip_prefix(r"\\?\").unwrap_or(root_text);
    send(
        json!({"kind":"owned_writer_ready","sqliteRoot":root_text,"threadId":ID,"codexRoot":codex,"rolloutPath":locator}),
    );
    // Bound every line; a parent owns the total deadline and actual reaping.
    let mut input = std::io::stdin().lock();
    loop {
        let mut bytes = Vec::new();
        let read = std::io::Read::take(&mut input, 65)
            .read_until(b'\n', &mut bytes)
            .unwrap();
        if read == 0 || bytes == b"finish\n" {
            break;
        }
        assert!(read <= 64 && bytes.ends_with(b"\n"));
        match bytes.as_slice() {
            b"other\n" => {
                db.execute("INSERT INTO projects(id) VALUES('unrelated')", [])
                    .unwrap();
            }
            b"rename\n" => {
                db.execute("UPDATE threads SET title='renamed' WHERE id=?1", [ID])
                    .unwrap();
            }
            b"preview\n" => {
                db.execute(
                    "UPDATE threads SET preview='  preview 🐾  ' WHERE id=?1",
                    [ID],
                )
                .unwrap();
            }
            b"path\n" => {
                db.execute(
                    "UPDATE threads SET rollout_path='../never-open/auth.json' WHERE id=?1",
                    [ID],
                )
                .unwrap();
            }
            b"paginated\n" => {
                db.execute("UPDATE threads SET history_mode='paginated',name='  paginated name  ' WHERE id=?1", [ID]).unwrap();
                std::fs::write(&rollout, rollout_bytes("paginated", false)).unwrap();
            }
            b"reset\n" => {
                db.execute("UPDATE threads SET title='  最新 WAL 名稱 🐾  ',first_user_message='first',preview='',history_mode='legacy',name=NULL,rollout_path=?1 WHERE id=?2", params![rollout.to_str().unwrap(), ID]).unwrap();
                std::fs::write(&rollout, rollout_bytes("legacy", false)).unwrap();
                std::fs::write(codex.join("session_index.jsonl"), index_bytes(false)).unwrap();
            }
            b"index\n" => {
                std::fs::write(codex.join("session_index.jsonl"), index_bytes(true)).unwrap();
            }
            b"rollout\n" => {
                std::fs::write(&rollout, rollout_bytes("legacy", true)).unwrap();
            }
            b"fallback\n" => {
                db.execute(
                    "UPDATE threads SET title='first',preview='owned index 🐾' WHERE id=?1",
                    [ID],
                )
                .unwrap();
            }
            b"missing\n" => {
                db.execute("DELETE FROM threads WHERE id=?1", [ID]).unwrap();
            }
            _ => panic!("unknown owned fixture command"),
        }
        send(json!({"kind":"owned_writer_updated"}));
    }
    db.close().unwrap();
    dir.close().expect("owned fixture explicit cleanup");
    assert!(!base.try_exists().unwrap());
    send(json!({"kind":"owned_writer_closed","removedOwnedDirectories":1}));
}
