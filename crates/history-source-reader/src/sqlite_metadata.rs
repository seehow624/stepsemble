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
pub const NATIVE_VERSION: &str = "0.153.4";
pub const SQLITE_SOURCE_ID: &str =
    "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc";
pub const THREADS_SCHEMA: &str =
    include_str!("../../../protocol/native/codex/sqlite-threads-0.153.4.sql");
pub const TEXT_LIMIT: usize = 32 * 1024;
pub const OUTPUT_LIMIT: usize = 128 * 1024;
pub const CONTEXT_OUTPUT_LIMIT: usize = 192 * 1024;
pub const CATALOG_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
pub const CATALOG_ENTRIES: usize = 2048;
pub const VM_STEPS: usize = 20_000;
// A full catalog selects nine columns for up to 2048 rows. Keep the original
// selected-row budget unchanged, with a separate finite discovery allowance.
pub const CATALOG_VM_STEPS: usize = 64_000;
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NameContext {
    pub rollout_path: String,
    pub preview: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub kind: &'static str,
    pub native_version: &'static str,
    pub sqlite_version: &'static str,
    pub scope: &'static str,
    pub fields: Option<NameFields>,
    // None is the unchanged v4 contract. Some(None) is an observed missing row
    // in v5, never an unread/implicitly authorized source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_context: Option<Option<NameContext>>,
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

pub(crate) fn valid_id(id: &str) -> bool {
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

fn schema_matches_pin(schema: &str) -> bool {
    // Both byte-exact native 0.153.4 forms are verified by the owned oracle:
    // POSIX LF and Windows CRLF. Do not normalize other SQL whitespace or DDL.
    let canonical = THREADS_SCHEMA.trim();
    schema == canonical || schema == canonical.replace('\n', "\r\n")
}

fn authorize(context: AuthContext<'_>) -> Authorization {
    authorize_selected(context, false)
}

fn authorize_selected(context: AuthContext<'_>, name_context: bool) -> Authorization {
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
                    || name_context && ["rollout_path", "preview"].contains(&column_name)
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
    max_steps: usize,
}
impl Guard {
    fn check(&self) -> Result<(), Error> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        if self.started.elapsed() >= TRANSACTION_BUDGET
            || self.steps.load(Ordering::Relaxed) >= self.max_steps
        {
            return Err(Error::Budget);
        }
        Ok(())
    }
}

fn configure(db: &Connection, guard: &Guard) -> Result<(), Error> {
    configure_selected(db, guard, false)
}

fn configure_selected(db: &Connection, guard: &Guard, name_context: bool) -> Result<(), Error> {
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
    let max_steps = guard.max_steps;
    db.progress_handler(
        100,
        Some(move || {
            let count = steps.fetch_add(100, Ordering::Relaxed) + 100;
            count >= max_steps
                || cancelled.load(Ordering::Acquire)
                || started.elapsed() >= TRANSACTION_BUDGET
        }),
    )
    .map_err(sqlite_error)?;
    // Connection-local settings only. No journal mode change, migration,
    // checkpoint, VACUUM, repair, database_list/path output, or source SQL write.
    db.execute_batch("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA cache_size=-512;").map_err(sqlite_error)?;
    if name_context {
        db.authorizer(Some(|context: AuthContext<'_>| {
            authorize_selected(context, true)
        }))
        .map_err(sqlite_error)?;
    } else {
        db.authorizer(Some(authorize)).map_err(sqlite_error)?;
    }
    guard.check()
}

// Deliberately separate from the v4/v5 column allowlists. Discovery reads only
// routing/classification metadata, never content, credentials or arbitrary SQL.
fn authorize_catalog(context: AuthContext<'_>) -> Authorization {
    if context.accessor.is_some() || context.database_name.is_some_and(|v| v != "main") {
        return Authorization::Deny;
    }
    let allowed = match context.action {
        AuthAction::Select | AuthAction::Transaction { .. } => true,
        AuthAction::Read {
            table_name: "sqlite_master" | "sqlite_schema",
            column_name,
        } => ["name", "type", "sql"].contains(&column_name),
        AuthAction::Read {
            table_name: "threads",
            column_name,
        } => [
            "id",
            "rollout_path",
            "source",
            "history_mode",
            "archived",
            "created_at",
            "updated_at",
            "created_at_ms",
            "updated_at_ms",
        ]
        .contains(&column_name),
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub rollout_path: String,
    pub source: String,
    pub history_mode: String,
    pub archived: bool,
    // Exact integers, not lossy JavaScript Numbers. Interpretation happens in
    // the bounded Host projection; filenames never provide a timestamp or ID.
    pub created_at: String,
    pub updated_at: String,
    pub created_at_ms: Option<String>,
    pub updated_at_ms: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogObservation {
    pub kind: &'static str,
    pub native_version: &'static str,
    pub sqlite_version: &'static str,
    pub scope: &'static str,
    pub entries: Vec<CatalogEntry>,
    pub source_authenticated: bool,
    pub publishable: bool,
    pub connection_closed: bool,
}

/// All stored state-DB rows, including archived/subagent/empty-preview rows.
/// This is not the filtered native thread/list API or transcript discovery.
/// A catalog over the explicit limits is unavailable, never silently truncated.
pub fn capture_catalog(
    db: Connection,
    native_version: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<CatalogObservation, Error> {
    capture_catalog_with_hook(db, native_version, cancelled, |_| Ok(()))
}
fn capture_catalog_with_hook(
    mut db: Connection,
    native_version: &str,
    cancelled: Arc<AtomicBool>,
    hook: impl FnOnce(&Connection) -> Result<(), Error>,
) -> Result<CatalogObservation, Error> {
    let guard = Guard {
        started: Instant::now(),
        cancelled,
        steps: Arc::new(AtomicUsize::new(0)),
        max_steps: CATALOG_VM_STEPS,
    };
    let no_checkpoint = db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
    let result = (|| {
        if !no_checkpoint.map_err(sqlite_error)? || native_version != NATIVE_VERSION {
            return Err(Error::InvalidSelection);
        }
        configure(&db, &guard)?;
        db.authorizer(Some(authorize_catalog))
            .map_err(sqlite_error)?;
        // Same 250ms transaction deadline; catalog's finite VM allowance is
        // larger than a single selected row, not an unlimited scan or retry.
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sqlite_error)?;
        let schema: Option<String> = transaction
            .query_row(
                "SELECT sql FROM main.sqlite_schema WHERE name='threads' AND type='table' LIMIT 2",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sqlite_error)?;
        if !schema.as_deref().is_some_and(schema_matches_pin) {
            return Err(Error::SchemaUnsupported);
        }
        let mode: String = transaction
            .query_row("PRAGMA main.journal_mode", [], |r| r.get(0))
            .map_err(sqlite_error)?;
        if mode != "wal" {
            return Err(Error::JournalUnsupported);
        }
        hook(&transaction)?;
        let mut entries = Vec::new();
        let mut encoded_entry_bytes = 0_usize;
        {
            let mut statement = transaction.prepare("SELECT id,rollout_path,source,history_mode,archived,created_at,updated_at,created_at_ms,updated_at_ms FROM main.threads ORDER BY id LIMIT 2049").map_err(sqlite_error)?;
            let mut rows = statement.query([]).map_err(sqlite_error)?;
            while let Some(row) = rows.next().map_err(sqlite_error)? {
                guard.check()?;
                if entries.len() == CATALOG_ENTRIES {
                    return Err(Error::TooLarge);
                }
                let field_error = |_| Error::InvalidFields;
                let archived: i64 = row.get(4).map_err(field_error)?;
                let entry = CatalogEntry {
                    id: row.get(0).map_err(field_error)?,
                    rollout_path: row.get(1).map_err(field_error)?,
                    source: row.get(2).map_err(field_error)?,
                    history_mode: row.get(3).map_err(field_error)?,
                    archived: archived == 1,
                    created_at: row.get::<_, i64>(5).map_err(field_error)?.to_string(),
                    updated_at: row.get::<_, i64>(6).map_err(field_error)?.to_string(),
                    created_at_ms: row
                        .get::<_, Option<i64>>(7)
                        .map_err(field_error)?
                        .map(|v| v.to_string()),
                    updated_at_ms: row
                        .get::<_, Option<i64>>(8)
                        .map_err(field_error)?
                        .map(|v| v.to_string()),
                };
                if !valid_id(&entry.id)
                    || !(0..=1).contains(&archived)
                    || !["legacy", "paginated"].contains(&entry.history_mode.as_str())
                {
                    return Err(Error::InvalidFields);
                }
                if entry.rollout_path.len() > 8192 || entry.source.len() > 4096 {
                    return Err(Error::TooLarge);
                }
                encoded_entry_bytes += serde_json::to_vec(&entry)
                    .map_err(|_| Error::InvalidFields)?
                    .len()
                    + usize::from(!entries.is_empty());
                // Stop retaining rows as soon as the payload cannot fit.
                // The complete envelope gets its own exact check below.
                if encoded_entry_bytes > CATALOG_OUTPUT_LIMIT {
                    return Err(Error::TooLarge);
                }
                entries.push(entry);
            }
        }
        guard.check()?;
        transaction.rollback().map_err(sqlite_error)?;
        let observation = CatalogObservation {
            kind: "codex_sqlite_catalog_observation",
            native_version: NATIVE_VERSION,
            sqlite_version: SQLITE_VERSION,
            scope: "provided_state_database_all_stored_threads",
            entries,
            source_authenticated: false,
            publishable: false,
            connection_closed: true,
        };
        if serde_json::to_vec(&observation)
            .map_err(|_| Error::InvalidFields)?
            .len()
            > CATALOG_OUTPUT_LIMIT
        {
            return Err(Error::TooLarge);
        }
        Ok(observation)
    })();
    if db.close().is_err() {
        return Err(Error::CloseUnconfirmed);
    }
    guard.check()?;
    result
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

/// v5 only: the two additional fields are read in the SAME short transaction
/// as the five name fields. They are inert data, never paths to follow here.
pub fn capture_name_context(
    db: Connection,
    native_version: &str,
    id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Observation, Error> {
    capture_selected(db, native_version, id, cancelled, true, |_, _| Ok(()))
}

fn selected_context(db: &Connection, id: &str) -> Result<NameContext, Error> {
    let result = db
        .query_row(
            "SELECT rollout_path, preview FROM main.threads WHERE id=?1 LIMIT 2",
            [id],
            |row| {
                Ok(NameContext {
                    rollout_path: row.get(0)?,
                    preview: row.get(1)?,
                })
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::InvalidColumnType(..)
            | rusqlite::Error::FromSqlConversionFailure(..)
            | rusqlite::Error::Utf8Error(..) => Error::InvalidFields,
            _ => sqlite_error(error),
        })?;
    if result.rollout_path.len() > 8192 || result.preview.len() > TEXT_LIMIT {
        return Err(Error::TooLarge);
    }
    Ok(result)
}

fn capture_with_hook(
    db: Connection,
    native_version: &str,
    id: &str,
    cancelled: Arc<AtomicBool>,
    hook: impl FnOnce(&Connection, &Option<NameFields>) -> Result<(), Error>,
) -> Result<Observation, Error> {
    capture_selected(db, native_version, id, cancelled, false, hook)
}

fn capture_selected(
    mut db: Connection,
    native_version: &str,
    id: &str,
    cancelled: Arc<AtomicBool>,
    with_context: bool,
    hook: impl FnOnce(&Connection, &Option<NameFields>) -> Result<(), Error>,
) -> Result<Observation, Error> {
    let guard = Guard {
        started: Instant::now(),
        cancelled,
        steps: Arc::new(AtomicUsize::new(0)),
        max_steps: VM_STEPS,
    };
    // Also suppress close checkpoint on invalid/cancelled requests. This is
    // connection-local, not PRAGMA wal_checkpoint on the source.
    let no_close_checkpoint = db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
    let result = (|| {
        if !no_close_checkpoint.map_err(sqlite_error)? {
            return Err(Error::SqliteUnavailable);
        }
        if native_version != NATIVE_VERSION || !valid_id(id) {
            return Err(Error::InvalidSelection);
        }
        guard.check()?;
        if with_context {
            configure_selected(&db, &guard, true)?;
        } else {
            configure(&db, &guard)?;
        }
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
        if !schema.as_deref().is_some_and(schema_matches_pin) {
            return Err(Error::SchemaUnsupported);
        }
        let mode: String = transaction
            .query_row("PRAGMA main.journal_mode", [], |row| row.get(0))
            .map_err(sqlite_error)?;
        if mode != "wal" {
            return Err(Error::JournalUnsupported);
        }
        let fields = selected_fields(&transaction, id)?;
        let name_context = if with_context {
            Some(if fields.is_some() {
                Some(selected_context(&transaction, id)?)
            } else {
                None
            })
        } else {
            None
        };
        hook(&transaction, &fields)?;
        guard.check()?;
        transaction.rollback().map_err(sqlite_error)?;
        guard.check()?;
        let observation = Observation {
            kind: "codex_sqlite_metadata_observation",
            native_version: NATIVE_VERSION,
            sqlite_version: SQLITE_VERSION,
            scope: if with_context {
                "provided_connection_selected_name_context_only"
            } else {
                "provided_connection_selected_name_fields_only"
            },
            fields,
            name_context,
            native_title_resolved: false,
            source_authenticated: false,
            publishable: false,
            connection_closed: true,
        };
        if serde_json::to_vec(&observation)
            .map_err(|_| Error::InvalidFields)?
            .len()
            > if with_context {
                CONTEXT_OUTPUT_LIMIT
            } else {
                OUTPUT_LIMIT
            }
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
