//! Short, bounded, read-only SQLite transactions for selected Codex name fields.
//!
//! This module deliberately accepts an already-open, caller-owned connection,
//! not a path. It does NOT open private sources, validate filesystem authority,
//! implement a VFS, or promise that an ordinary SQLite read leaves SHM untouched.
//! The caller must supply a fresh connection from the future descriptor-backed
//! boundary and run it inside the shared-admission, deadline/actual-close worker.
use rusqlite::config::DbConfig;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::ffi::CStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

pub const SQLITE_VERSION: &str = "3.53.4";
pub const SQLITE_SOURCE_ID: &str =
    "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc";
pub const THREADS_SCHEMA: &str =
    include_str!("../../../protocol/native/codex/sqlite-threads-0.153.4.sql");
pub const TEXT_LIMIT: usize = 32 * 1024;
pub const OUTPUT_LIMIT: usize = 128 * 1024;
pub const VM_STEPS: usize = 20_000;
pub const TRANSACTION_BUDGET: Duration = Duration::from_millis(250);

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidSelection,
    EngineMismatch,
    ConnectionNotFreshReadOnly,
    Busy,
    Budget,
    Cancelled,
    SchemaUnsupported,
    JournalUnsupported,
    InvalidFields,
    TooLarge,
    SqliteUnavailable,
    CloseUnconfirmed,
}

/// Values stay raw and inert. No title resolution, source version or grant.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NameFields {
    pub id: String,
    pub history_mode: String,
    pub title: String,
    pub first_user_message: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub kind: &'static str,
    pub native_version: &'static str,
    pub sqlite_version: &'static str,
    pub scope: &'static str,
    pub fields: Option<NameFields>,
    pub native_title_resolved: bool,
    pub source_authenticated: bool,
    pub publishable: bool,
    pub connection_closed: bool,
}

fn sqlite_error(error: rusqlite::Error) -> Error {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            Error::Busy
        }
        Some(rusqlite::ErrorCode::TooBig) => Error::TooLarge,
        _ => Error::SqliteUnavailable,
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

pub fn engine_matches_pin() -> bool {
    // SAFETY: SQLite returns a static, NUL-terminated source-id string. This
    // function does not initialize a connection or access any database file.
    let source = unsafe { CStr::from_ptr(rusqlite::ffi::sqlite3_sourceid()) };
    rusqlite::version() == SQLITE_VERSION && source.to_bytes() == SQLITE_SOURCE_ID.as_bytes()
}

fn authorize(context: AuthContext<'_>) -> Authorization {
    if context.accessor.is_some() || context.database_name.is_some_and(|name| name != "main") {
        return Authorization::Deny;
    }
    let allowed = match context.action {
        AuthAction::Select | AuthAction::Transaction { .. } => true,
        AuthAction::Read {
            table_name,
            column_name,
        } => match table_name {
            "sqlite_master" | "sqlite_schema" => ["name", "type", "sql"].contains(&column_name),
            "threads" => {
                ["id", "history_mode", "title", "first_user_message", "name"].contains(&column_name)
            }
            _ => false,
        },
        AuthAction::Pragma {
            pragma_name: "journal_mode",
            pragma_value: None,
        } => true,
        _ => false,
    };
    if allowed {
        Authorization::Allow
    } else {
        Authorization::Deny
    }
}

struct Guard {
    started: Instant,
    cancelled: Arc<AtomicBool>,
    steps: Arc<AtomicUsize>,
}
impl Guard {
    fn check(&self) -> Result<(), Error> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        if self.started.elapsed() >= TRANSACTION_BUDGET
            || self.steps.load(Ordering::Relaxed) >= VM_STEPS
        {
            return Err(Error::Budget);
        }
        Ok(())
    }
}

fn configure(db: &Connection, guard: &Guard) -> Result<(), Error> {
    if !engine_matches_pin() {
        return Err(Error::EngineMismatch);
    }
    // A writable connection cannot be made acceptable by setting query_only.
    // Reject existing transactions/attached DBs before preparing any SQL.
    if !db.is_autocommit()
        || !db.is_readonly("main").map_err(sqlite_error)?
        || db.db_name(0).map_err(sqlite_error)? != "main"
        || db.db_name(2).is_ok()
        || db.db_name(1).is_ok_and(|name| name != "temp")
    {
        return Err(Error::ConnectionNotFreshReadOnly);
    }
    db.busy_timeout(Duration::ZERO).map_err(sqlite_error)?;
    // SAFETY: the owned connection is live, no statement is borrowed, and 0
    // only disables extension loading; it never executes or loads an extension.
    if unsafe { rusqlite::ffi::sqlite3_enable_load_extension(db.handle(), 0) }
        != rusqlite::ffi::SQLITE_OK
    {
        return Err(Error::SqliteUnavailable);
    }
    for (option, value) in [
        (DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true),
        (DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false),
        (DbConfig::SQLITE_DBCONFIG_DQS_DML, false),
        (DbConfig::SQLITE_DBCONFIG_DQS_DDL, false),
        (DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE, false),
        (DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE, false),
    ] {
        if db.set_db_config(option, value).map_err(sqlite_error)? != value {
            return Err(Error::SqliteUnavailable);
        }
    }
    for (limit, maximum) in [
        (Limit::SQLITE_LIMIT_LENGTH, 128 * 1024),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, 8 * 1024),
        (Limit::SQLITE_LIMIT_COLUMN, 64),
        (Limit::SQLITE_LIMIT_EXPR_DEPTH, 20),
        (Limit::SQLITE_LIMIT_COMPOUND_SELECT, 0),
        (Limit::SQLITE_LIMIT_VDBE_OP, 25_000),
        (Limit::SQLITE_LIMIT_FUNCTION_ARG, 4),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 1),
        (Limit::SQLITE_LIMIT_TRIGGER_DEPTH, 0),
        (Limit::SQLITE_LIMIT_WORKER_THREADS, 0),
    ] {
        db.set_limit(limit, maximum).map_err(sqlite_error)?;
    }
    let started = guard.started;
    let cancelled = guard.cancelled.clone();
    let steps = guard.steps.clone();
    db.progress_handler(
        100,
        Some(move || {
            let count = steps.fetch_add(100, Ordering::Relaxed) + 100;
            count >= VM_STEPS
                || cancelled.load(Ordering::Acquire)
                || started.elapsed() >= TRANSACTION_BUDGET
        }),
    )
    .map_err(sqlite_error)?;
    // Connection-local settings only. No journal mode change, migration,
    // checkpoint, VACUUM, repair, database_list/path output, or source SQL write.
    db.execute_batch("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA cache_size=-512;").map_err(sqlite_error)?;
    db.authorizer(Some(authorize)).map_err(sqlite_error)?;
    guard.check()
}

fn selected_fields(db: &Connection, id: &str) -> Result<Option<NameFields>, Error> {
    let result = db.query_row(
        "SELECT id, history_mode, title, first_user_message, name FROM main.threads WHERE id=?1 LIMIT 2",
        [id], |row| Ok(NameFields { id: row.get(0)?, history_mode: row.get(1)?, title: row.get(2)?, first_user_message: row.get(3)?, name: row.get(4)? }),
    ).optional().map_err(|error| {
        match error {
            rusqlite::Error::InvalidColumnType(..) | rusqlite::Error::FromSqlConversionFailure(..) | rusqlite::Error::Utf8Error(..) => Error::InvalidFields,
            _ => sqlite_error(error),
        }
    })?;
    if let Some(row) = &result {
        if row.id != id || !["legacy", "paginated"].contains(&row.history_mode.as_str()) {
            return Err(Error::InvalidFields);
        }
        if [&row.title, &row.first_user_message]
            .into_iter()
            .chain(row.name.iter())
            .any(|v| v.len() > TEXT_LIMIT)
        {
            return Err(Error::TooLarge);
        }
    }
    Ok(result)
}

/// Consumes and closes the connection before returning any row. The caller
/// supplies the selected ID and a cancellation flag; no SQL or path is accepted.
/// A missing row is only an observation of this transaction, not index fallback.
pub fn capture_name_fields(
    db: Connection,
    native_version: &str,
    id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Observation, Error> {
    capture_with_hook(db, native_version, id, cancelled, |_, _| Ok(()))
}

fn capture_with_hook(
    mut db: Connection,
    native_version: &str,
    id: &str,
    cancelled: Arc<AtomicBool>,
    hook: impl FnOnce(&Connection, &Option<NameFields>) -> Result<(), Error>,
) -> Result<Observation, Error> {
    let guard = Guard {
        started: Instant::now(),
        cancelled,
        steps: Arc::new(AtomicUsize::new(0)),
    };
    // Also suppress close checkpoint on invalid/cancelled requests. This is
    // connection-local, not PRAGMA wal_checkpoint on the source.
    let no_close_checkpoint = db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
    let result = (|| {
        if !no_close_checkpoint.map_err(sqlite_error)? {
            return Err(Error::SqliteUnavailable);
        }
        if native_version != "0.153.4" || !valid_id(id) {
            return Err(Error::InvalidSelection);
        }
        guard.check()?;
        configure(&db, &guard)?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sqlite_error)?;
        let schema: Option<String> = transaction
            .query_row(
                "SELECT sql FROM main.sqlite_schema WHERE name='threads' AND type='table' LIMIT 2",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_error)?;
        if schema.as_deref() != Some(THREADS_SCHEMA.trim()) {
            return Err(Error::SchemaUnsupported);
        }
        let mode: String = transaction
            .query_row("PRAGMA main.journal_mode", [], |row| row.get(0))
            .map_err(sqlite_error)?;
        if mode != "wal" {
            return Err(Error::JournalUnsupported);
        }
        let fields = selected_fields(&transaction, id)?;
        hook(&transaction, &fields)?;
        guard.check()?;
        transaction.rollback().map_err(sqlite_error)?;
        guard.check()?;
        let observation = Observation {
            kind: "codex_sqlite_metadata_observation",
            native_version: "0.153.4",
            sqlite_version: SQLITE_VERSION,
            scope: "provided_connection_selected_name_fields_only",
            fields,
            native_title_resolved: false,
            source_authenticated: false,
            publishable: false,
            connection_closed: true,
        };
        if serde_json::to_vec(&observation)
            .map_err(|_| Error::InvalidFields)?
            .len()
            > OUTPUT_LIMIT
        {
            return Err(Error::TooLarge);
        }
        Ok(observation)
    })();
    // Progress interruption can also stop ROLLBACK. Connection close remains
    // mandatory on every outcome; do not replace this with dropping a pool lease.
    if db.close().is_err() {
        return Err(Error::CloseUnconfirmed);
    }
    guard.check()?;
    result
}

#[cfg(test)]
mod tests;
