use super::*;
use rusqlite::{OpenFlags, params};
use std::path::{Path, PathBuf};

const THREAD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MISSING: &str = "00000000-0000-4000-8000-000000000000";

struct Fixture {
    path: PathBuf,
    writer: Connection,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .canonicalize()
            .unwrap()
            .join("owned-history.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        for schema in [TURNS_SCHEMA, ITEMS_SCHEMA, PROJECTION_SCHEMA] {
            writer.execute_batch(schema).unwrap();
        }
        Self {
            path,
            writer,
            _dir: dir,
        }
    }
    fn seed_turn(&self, turn: &str, ordinal: i64, end_ordinal: i64) {
        self.writer.execute(
            "INSERT INTO thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,duration_ms,first_user_item_id,final_agent_item_id,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset) \
             VALUES(?1,?2,?3,'completed',10,20,10000,'user-1','agent-1',?4,?5,?6)",
            params![THREAD, turn, ordinal, ordinal * 100, end_ordinal, end_ordinal * 100],
        ).unwrap();
    }
    fn seed_item(&self, turn: &str, item: &str, ordinal: i64) {
        self.writer.execute(
            "INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type,updated_at_ordinal) \
             VALUES(?1,?2,?3,?4,10000,'{\"secret\":\"payload\"}','userMessage',?4)",
            params![THREAD, turn, item, ordinal],
        ).unwrap();
    }
    fn seed_checkpoint(&self, byte_offset: i64, ordinal: i64) {
        self.writer
            .execute(
                "INSERT INTO thread_history_projection_state(thread_id,next_rollout_byte_offset,next_rollout_ordinal) VALUES(?1,?2,?3)",
                params![THREAD, byte_offset, ordinal],
            )
            .unwrap();
    }
    fn reader(&self) -> Connection {
        open_reader(&self.path)
    }
}
fn open_reader(path: &Path) -> Connection {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap()
}
fn capture(fixture: &Fixture, thread_id: &str) -> Result<Observation, Error> {
    capture_checkpoint(
        fixture.reader(),
        NATIVE_VERSION,
        thread_id,
        Arc::new(AtomicBool::new(false)),
    )
}

#[test]
fn reads_projection_checkpoint_and_turn_boundaries_in_ordinal_order() {
    let fixture = Fixture::new();
    fixture.seed_turn("turn-2", 40, 79);
    fixture.seed_turn("turn-1", 0, 39);
    fixture.seed_item("turn-1", "user-1", 1);
    fixture.seed_item("turn-1", "agent-1", 2);
    fixture.seed_item("turn-2", "user-1", 41);
    fixture.seed_checkpoint(8000, 80);

    let observation = capture(&fixture, THREAD).unwrap();
    assert_eq!(observation.kind, "codex_paginated_projection_checkpoint");
    assert_eq!(
        observation.checkpoint,
        Some(Checkpoint {
            next_rollout_byte_offset: "8000".into(),
            next_rollout_ordinal: "80".into(),
        })
    );
    assert_eq!(
        observation
            .turns
            .iter()
            .map(|turn| turn.turn_id.as_str())
            .collect::<Vec<_>>(),
        ["turn-1", "turn-2"]
    );
    assert_eq!(observation.turns[0].rollout_ordinal, "0");
    assert_eq!(
        observation.turns[1].rollout_end_ordinal.as_deref(),
        Some("79")
    );
    // The same item ID in a different turn is a distinct native row.
    assert_eq!(observation.item_count, "3");
    assert_eq!(observation.max_item_ordinal.as_deref(), Some("41"));
    assert!(!observation.source_authenticated);
    assert!(!observation.publishable);
    assert!(!observation.history_complete);
    assert!(observation.connection_closed);
}

#[test]
fn a_lagging_projection_is_reported_as_is_and_never_as_complete() {
    let fixture = Fixture::new();
    fixture.seed_turn("turn-1", 0, 39);
    fixture.seed_item("turn-1", "user-1", 1);
    // The durable rollout continued well past what this projection consumed.
    fixture.seed_checkpoint(200, 2);

    let observation = capture(&fixture, THREAD).unwrap();
    assert_eq!(
        observation
            .checkpoint
            .as_ref()
            .unwrap()
            .next_rollout_ordinal,
        "2"
    );
    assert_eq!(observation.max_item_ordinal.as_deref(), Some("1"));
    // Nothing in a checkpoint may claim the durable history is complete.
    assert!(!observation.history_complete);
    assert!(!observation.publishable);
}

#[test]
fn a_thread_without_projection_rows_is_an_observation_not_empty_history() {
    let fixture = Fixture::new();
    fixture.seed_turn("turn-1", 0, 39);
    fixture.seed_item("turn-1", "user-1", 1);
    fixture.seed_checkpoint(8000, 80);

    let observation = capture(&fixture, MISSING).unwrap();
    assert_eq!(observation.checkpoint, None);
    assert!(observation.turns.is_empty());
    assert_eq!(observation.item_count, "0");
    assert_eq!(observation.max_item_ordinal, None);
    assert!(!observation.history_complete);
}

#[test]
fn item_payload_json_is_not_readable_on_this_connection() {
    let fixture = Fixture::new();
    fixture.seed_item("turn-1", "user-1", 1);
    let db = fixture.reader();
    let guard = Guard {
        started: Instant::now(),
        cancelled: Arc::new(AtomicBool::new(false)),
        steps: Arc::new(AtomicUsize::new(0)),
    };
    configure(&db, &guard, false).unwrap();
    let denied = db.query_row(
        "SELECT item_json FROM main.thread_items WHERE thread_id=?1 LIMIT 1",
        [THREAD],
        |row| row.get::<_, String>(0),
    );
    assert!(denied.is_err(), "item payload must stay unreadable here");
}

#[test]
fn other_tables_and_sql_functions_stay_unauthorized() {
    let fixture = Fixture::new();
    fixture
        .writer
        .execute_batch("CREATE TABLE thread_realtime_items(thread_id TEXT, item_json TEXT);")
        .unwrap();
    fixture
        .writer
        .execute(
            "INSERT INTO thread_realtime_items VALUES(?1,'{}')",
            [THREAD],
        )
        .unwrap();
    let db = fixture.reader();
    let guard = Guard {
        started: Instant::now(),
        cancelled: Arc::new(AtomicBool::new(false)),
        steps: Arc::new(AtomicUsize::new(0)),
    };
    configure(&db, &guard, false).unwrap();
    for sql in [
        "SELECT item_json FROM main.thread_realtime_items LIMIT 1",
        "SELECT turn_id FROM main.thread_turns WHERE thread_id=?1 AND readfile('/etc/passwd') IS NULL",
        "SELECT group_concat(turn_id) FROM main.thread_turns WHERE thread_id=?1",
        "SELECT error_json FROM main.thread_turns WHERE thread_id=?1 LIMIT 1",
    ] {
        assert!(
            db.query_row(sql, [THREAD], |row| row.get::<_, Option<String>>(0))
                .is_err(),
            "must stay unauthorized: {sql}"
        );
    }
}

#[test]
fn a_changed_table_schema_is_refused_rather_than_parsed() {
    let fixture = Fixture::new();
    fixture.writer.execute_batch("DROP TABLE thread_turns; CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, extra TEXT);").unwrap();
    assert_eq!(capture(&fixture, THREAD), Err(Error::SchemaUnsupported));
}

#[test]
fn a_missing_history_table_is_refused_rather_than_treated_as_empty() {
    let fixture = Fixture::new();
    fixture
        .writer
        .execute_batch("DROP TABLE thread_history_projection_state;")
        .unwrap();
    assert_eq!(capture(&fixture, THREAD), Err(Error::SchemaUnsupported));
}

#[test]
fn a_writable_connection_is_refused() {
    let fixture = Fixture::new();
    let writable = Connection::open(&fixture.path).unwrap();
    assert_eq!(
        capture_checkpoint(
            writable,
            NATIVE_VERSION,
            THREAD,
            Arc::new(AtomicBool::new(false))
        ),
        Err(Error::ConnectionNotFreshReadOnly)
    );
}

#[test]
fn an_unpinned_native_version_or_invalid_selection_is_refused() {
    let fixture = Fixture::new();
    assert_eq!(
        capture_checkpoint(
            fixture.reader(),
            "0.99.0",
            THREAD,
            Arc::new(AtomicBool::new(false))
        ),
        Err(Error::InvalidSelection)
    );
    assert_eq!(capture(&fixture, ""), Err(Error::InvalidSelection));
    assert_eq!(
        capture(&fixture, "control\u{0}char"),
        Err(Error::InvalidSelection)
    );
}

#[test]
fn cancellation_is_observed_instead_of_returning_a_partial_page() {
    let fixture = Fixture::new();
    fixture.seed_checkpoint(8000, 80);
    assert_eq!(
        capture_checkpoint(
            fixture.reader(),
            NATIVE_VERSION,
            THREAD,
            Arc::new(AtomicBool::new(true))
        ),
        Err(Error::Cancelled)
    );
}

#[test]
fn more_turns_than_the_limit_are_refused_rather_than_silently_truncated() {
    let fixture = Fixture::new();
    for ordinal in 0..(TURN_LIMIT as i64 + 1) {
        fixture.seed_turn(&format!("turn-{ordinal}"), ordinal, ordinal);
    }
    assert_eq!(capture(&fixture, THREAD), Err(Error::TooLarge));
}

#[test]
fn a_wal_journal_mismatch_is_refused_for_the_cold_snapshot_entry_point() {
    let fixture = Fixture::new();
    fixture.seed_checkpoint(8000, 80);
    assert_eq!(
        capture_cold_checkpoint(
            fixture.reader(),
            NATIVE_VERSION,
            THREAD,
            Arc::new(AtomicBool::new(false))
        ),
        Err(Error::JournalUnsupported)
    );
}
