use super::*;
use rusqlite::{OpenFlags, params};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

const ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MISSING: &str = "00000000-0000-4000-8000-000000000000";

struct Fixture {
    path: PathBuf,
    writer: Connection,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // macOS's default temp prefix uses /var -> /private/var. Resolve this
        // owned directory before using SQLITE_OPEN_NOFOLLOW; do not drop it.
        let path = dir.path().canonicalize().unwrap().join("owned.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE thread_sections(id TEXT PRIMARY KEY);").unwrap();
        writer.execute_batch(THREADS_SCHEMA).unwrap();
        writer.execute("INSERT INTO threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,first_user_message,name) VALUES(?1,'owned',0,0,'cli','owned','owned',?2,'owned','never',?2,?2)", params![ID, "original 🐾"]).unwrap();
        Self {
            path,
            writer,
            _dir: dir,
        }
    }
    fn reader(&self) -> Connection {
        open_reader(&self.path)
    }
    fn checkpoint(&self) -> (i32, i32, i32) {
        self.writer
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap()
    }
    fn update(&self, value: &str) {
        self.writer
            .execute(
                "UPDATE threads SET title=?1,first_user_message=?1,name=?1 WHERE id=?2",
                params![value, ID],
            )
            .unwrap();
    }
}
fn open_reader(path: &Path) -> Connection {
    // Owned test directories only. Not an authenticated production path opener.
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap()
}
fn flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}
fn read(f: &Fixture) -> Result<Observation, Error> {
    capture_name_fields(f.reader(), "0.153.4", ID, flag())
}

#[test]
fn exact_engine_has_the_official_wal_fix_and_newer_patch_pin() {
    assert!(engine_matches_pin());
    assert_eq!(rusqlite::version_number(), 3_053_004);
}

#[test]
fn selected_fields_include_wal_commits_and_keep_native_values_inert() {
    let f = Fixture::new();
    assert_eq!(f.checkpoint().0, 0);
    let base = std::fs::read(&f.path).unwrap();
    let text = "  <img src=x onerror=never()> \u{85}\u{feff}🐾\0  ";
    f.update(text);
    assert_eq!(
        std::fs::read(&f.path).unwrap(),
        base,
        "new value remains in WAL, not the main file"
    );
    let wal = std::fs::read(f.path.with_extension("sqlite-wal")).unwrap();
    let result = read(&f).unwrap();
    let fields = result.fields.as_ref().unwrap();
    assert_eq!(fields.id, ID);
    assert_eq!(fields.title, text);
    assert_eq!(fields.first_user_message, text);
    assert_eq!(fields.name.as_deref(), Some(text));
    assert!(!result.publishable);
    assert!(!result.native_title_resolved);
    assert!(!result.source_authenticated);
    assert!(result.connection_closed);
    assert_eq!(std::fs::read(&f.path).unwrap(), base);
    assert_eq!(
        std::fs::read(f.path.with_extension("sqlite-wal")).unwrap(),
        wal
    );
    assert_eq!(f.checkpoint().0, 0, "read lock released before publication");
}

#[test]
fn missing_row_is_distinct_from_missing_or_unknown_schema() {
    let f = Fixture::new();
    assert!(
        capture_name_fields(f.reader(), "0.153.4", MISSING, flag())
            .unwrap()
            .fields
            .is_none()
    );
    f.writer.execute_batch("DROP TABLE threads").unwrap();
    assert_eq!(read(&f), Err(Error::SchemaUnsupported));
}

#[test]
fn exact_schema_rejects_views_and_changed_column_contracts() {
    for sql in [
        "CREATE VIEW threads AS SELECT 'private' AS title",
        "CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT)",
    ] {
        let f = Fixture::new();
        f.writer.execute_batch("DROP TABLE threads").unwrap();
        f.writer.execute_batch(sql).unwrap();
        assert_eq!(read(&f), Err(Error::SchemaUnsupported));
        assert_eq!(f.checkpoint().0, 0);
    }
}

#[test]
fn exact_native_lf_and_crlf_schemas_are_supported_but_other_rewrites_are_not() {
    assert!(
        !THREADS_SCHEMA.contains('\r'),
        "canonical checkout stays LF"
    );
    for schema in [
        THREADS_SCHEMA.to_owned(),
        THREADS_SCHEMA.replace('\n', "\r\n"),
    ] {
        let f = Fixture::new();
        f.writer.execute_batch("DROP TABLE threads").unwrap();
        f.writer.execute_batch(&schema).unwrap();
        assert!(read(&f).unwrap().fields.is_none());
    }
    for schema in [
        THREADS_SCHEMA.replace('\n', " "),
        THREADS_SCHEMA.replacen("title TEXT", "title  TEXT", 1),
        THREADS_SCHEMA.replacen('\n', "\r\n", 1),
    ] {
        let f = Fixture::new();
        f.writer.execute_batch("DROP TABLE threads").unwrap();
        f.writer.execute_batch(&schema).unwrap();
        assert_eq!(read(&f), Err(Error::SchemaUnsupported));
    }
}

#[test]
fn fixed_version_selection_and_read_only_flag_are_mandatory() {
    let f = Fixture::new();
    for (version, id) in [
        ("latest", ID),
        ("0.153.4", "../../auth"),
        ("0.153.4", &ID.to_uppercase()),
    ] {
        assert_eq!(
            capture_name_fields(f.reader(), version, id, flag()),
            Err(Error::InvalidSelection)
        );
    }
    let writable = Connection::open(&f.path).unwrap();
    writable.execute_batch("PRAGMA query_only=ON").unwrap();
    assert_eq!(
        capture_name_fields(writable, "0.153.4", ID, flag()),
        Err(Error::ConnectionNotFreshReadOnly)
    );
    let reader = f.reader();
    reader
        .execute_batch("BEGIN; SELECT id FROM threads LIMIT 1")
        .unwrap();
    assert_eq!(
        capture_name_fields(reader, "0.153.4", ID, flag()),
        Err(Error::ConnectionNotFreshReadOnly)
    );
    assert_eq!(f.checkpoint().0, 0);
}

#[test]
fn attached_connections_are_not_reused_as_source_capabilities() {
    let f = Fixture::new();
    let reader = f.reader();
    reader
        .execute_batch("ATTACH ':memory:' AS unrelated")
        .unwrap();
    assert_eq!(
        capture_name_fields(reader, "0.153.4", ID, flag()),
        Err(Error::ConnectionNotFreshReadOnly)
    );
}

#[test]
fn only_wal_is_supported_and_the_reader_never_switches_journal_mode() {
    let f = Fixture::new();
    f.writer
        .execute_batch("PRAGMA journal_mode=DELETE")
        .unwrap();
    assert_eq!(read(&f), Err(Error::JournalUnsupported));
    let journal: String = f
        .writer
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(journal, "delete");
}

#[test]
fn fields_remain_raw_nullable_and_mode_specific_without_coercion() {
    let f = Fixture::new();
    f.writer
        .execute_batch(
            "UPDATE threads SET history_mode='paginated',first_user_message='',name=NULL",
        )
        .unwrap();
    let r = read(&f).unwrap().fields.unwrap();
    assert_eq!(r.history_mode, "paginated");
    assert_eq!(r.first_user_message, "");
    assert_eq!(r.name, None);
    f.writer
        .execute_batch("UPDATE threads SET history_mode='future'")
        .unwrap();
    assert_eq!(read(&f), Err(Error::InvalidFields));
}

#[test]
fn malformed_text_and_oversize_fields_are_never_truncated_or_replaced() {
    let f = Fixture::new();
    for sql in [
        "UPDATE threads SET title=x'80'",
        "UPDATE threads SET title=CAST(x'80' AS TEXT)",
    ] {
        f.writer.execute_batch(sql).unwrap();
        assert_eq!(read(&f), Err(Error::InvalidFields));
    }
    f.update(&"a".repeat(TEXT_LIMIT));
    assert_eq!(read(&f).unwrap().fields.unwrap().title.len(), TEXT_LIMIT);
    f.update(&"a".repeat(TEXT_LIMIT + 1));
    assert_eq!(read(&f), Err(Error::TooLarge));
    f.update(&"\"".repeat(TEXT_LIMIT));
    assert_eq!(read(&f), Err(Error::TooLarge), "encoded output limit");
    assert_eq!(f.checkpoint().0, 0);
}

#[test]
fn authorizer_denies_writes_attachments_unselected_columns_functions_and_pragmas() {
    let f = Fixture::new();
    capture_with_hook(f.reader(), "0.153.4", ID, flag(), |db, _| {
        for sql in [
            "UPDATE threads SET title='bad'",
            "ATTACH ':memory:' AS extra",
            "SELECT cwd FROM threads",
            "SELECT * FROM threads",
            "SELECT randomblob(100)",
            "PRAGMA wal_checkpoint(TRUNCATE)",
            "PRAGMA journal_mode=DELETE",
            "PRAGMA writable_schema=ON",
            "CREATE TABLE bad(x)",
            "VACUUM",
            "SELECT * FROM projects",
        ] {
            assert!(db.execute_batch(sql).is_err(), "must reject {sql}");
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(read(&f).unwrap().fields.unwrap().title, "original 🐾");
    assert_eq!(f.checkpoint().0, 0);
}

#[test]
fn cancelled_and_over_budget_transactions_close_before_returning() {
    let f = Fixture::new();
    let cancelled = flag();
    cancelled.store(true, Ordering::Release);
    assert_eq!(
        capture_name_fields(f.reader(), "0.153.4", ID, cancelled),
        Err(Error::Cancelled)
    );
    let cancelled = flag();
    let change = cancelled.clone();
    assert_eq!(
        capture_with_hook(f.reader(), "0.153.4", ID, cancelled, |_, _| {
            change.store(true, Ordering::Release);
            Ok(())
        }),
        Err(Error::Cancelled)
    );
    assert_eq!(
        capture_with_hook(f.reader(), "0.153.4", ID, flag(), |_, _| {
            thread::sleep(TRANSACTION_BUDGET + Duration::from_millis(10));
            Ok(())
        }),
        Err(Error::Budget)
    );
    assert_eq!(f.checkpoint().0, 0);
}

#[test]
fn opcode_budget_interrupts_expensive_reads_even_before_time_limit() {
    let f = Fixture::new();
    for n in 0..40 {
        f.writer.execute("INSERT INTO threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode) VALUES(?1,'owned',0,0,'cli','owned','owned','owned','owned','never')",[format!("owned-{n}")]).unwrap();
    }
    let guard = Guard {
        started: Instant::now(),
        cancelled: flag(),
        steps: Arc::new(AtomicUsize::new(0)),
    };
    let db = f.reader();
    configure(&db, &guard).unwrap();
    {
        // A single long statement crosses the progress quantum. Fresh tiny
        // statements reset SQLite's quantum and are not a valid budget probe.
        let mut statement = db
            .prepare(
                "SELECT a.id, b.id, c.id FROM threads a CROSS JOIN threads b CROSS JOIN threads c",
            )
            .unwrap();
        let mut rows = statement.query([]).unwrap();
        loop {
            match rows.next() {
                Ok(Some(_)) => {}
                Err(_) => break,
                Ok(None) => panic!("expensive query completed without the VM budget"),
            }
        }
    }
    assert!(guard.steps.load(Ordering::Relaxed) >= VM_STEPS);
    assert_eq!(guard.check(), Err(Error::Budget));
    db.close().unwrap();
    assert_eq!(f.checkpoint().0, 0);
}

#[test]
fn wal_writer_commits_while_reader_sees_one_consistent_transaction() {
    let f = Fixture::new();
    let path = f.path.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let db = Connection::open(path).unwrap();
        db.busy_timeout(Duration::ZERO).unwrap();
        // This fixture verifies transaction isolation, not crash durability or
        // native-writer throughput. Avoid 20 disk flushes inside the reader's
        // unchanged 250ms budget; prepare the independent writer beforehand.
        db.execute_batch("PRAGMA synchronous=OFF; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        ready_tx.send(()).unwrap();
        go_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        for n in 0..20 {
            db.execute(
                "UPDATE threads SET title=?1,first_user_message=?1,name=?1 WHERE id=?2",
                params![format!("new-{n}"), ID],
            )
            .unwrap();
        }
        db.close().unwrap();
        done_tx.send(()).unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let result = capture_with_hook(f.reader(), "0.153.4", ID, flag(), |db, first| {
        go_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            &selected_fields(db, ID).unwrap(),
            first,
            "commits cannot split the reader transaction"
        );
        Ok(())
    });
    writer.join().unwrap();
    assert_eq!(result.unwrap().fields.unwrap().title, "original 🐾");
    let next = read(&f).unwrap().fields.unwrap();
    assert_eq!(next.title, "new-19");
    assert_eq!(next.first_user_message, next.title);
    assert_eq!(next.name.as_deref(), Some(next.title.as_str()));
    assert_eq!(f.checkpoint().0, 0);
}

#[test]
fn a_read_lock_can_delay_checkpoint_but_is_not_retained_between_requests() {
    let f = Fixture::new();
    f.writer.busy_timeout(Duration::ZERO).unwrap();
    capture_with_hook(f.reader(), "0.153.4", ID, flag(), |_, _| {
        f.update("new");
        assert_eq!(
            f.checkpoint().0,
            1,
            "the owned writer demonstrates the real checkpoint cost of a reader"
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(f.checkpoint().0, 0, "actual close releases the read lock");
    assert_eq!(read(&f).unwrap().fields.unwrap().title, "new");
}

#[test]
fn busy_is_unavailable_without_retrying_or_repairing_the_source() {
    let f = Fixture::new();
    f.writer.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE threads SET title='uncommitted';").unwrap();
    assert_eq!(read(&f), Err(Error::Busy));
    f.writer.execute_batch("ROLLBACK").unwrap();
}
