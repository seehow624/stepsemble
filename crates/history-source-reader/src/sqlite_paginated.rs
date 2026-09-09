//! Bounded read-only capture of the pinned Codex paginated history projection.
//!
//! This module reads the SEPARATE `thread_history_1.sqlite` database that
//! native Codex maintains for paginated threads. It never opens a path: the
//! caller supplies a fresh, read-only, descriptor-backed connection from the
//! authenticated source boundary and runs it inside the shared-admission,
//! deadline/actual-close worker, exactly like the state-database modules.
//!
//! What it produces is a completeness CHECKPOINT, not history content. Native
//! item payloads stay in the separately verified paginated observation path.
//! A checkpoint proves only what this projection currently claims; it is not a
//! source grant, a durable-history completeness proof, or a publishable page.
use rusqlite::config::DbConfig;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use crate::sqlite_metadata::{
    Error, NATIVE_VERSION, SQLITE_VERSION, TRANSACTION_BUDGET, engine_matches_pin,
};

pub const TURNS_SCHEMA: &str =
    include_str!("../../../protocol/native/codex/sqlite-thread-turns-0.153.4.sql");
pub const ITEMS_SCHEMA: &str =
    include_str!("../../../protocol/native/codex/sqlite-thread-items-0.153.4.sql");
pub const PROJECTION_SCHEMA: &str =
    include_str!("../../../protocol/native/codex/sqlite-thread-projection-0.153.4.sql");

pub const OUTPUT_LIMIT: usize = 64 * 1024;
pub const TURN_LIMIT: usize = 2048;
pub const ID_LIMIT: usize = 256;
/// Turn boundaries are small fixed-width rows; keep a finite allowance that is
/// larger than one selected row but far below an unbounded table scan.
pub const VM_STEPS: usize = 64_000;

/// One native turn boundary. Values stay raw and inert: ordinals and byte
/// offsets are compared against durable sources by the bounded Host projection,
/// never followed or executed here.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnBoundary {
    pub turn_id: String,
    pub status: String,
    // Exact integers as strings, never lossy JavaScript Numbers.
    pub rollout_ordinal: String,
    pub rollout_byte_offset: Option<String>,
    pub rollout_end_ordinal: Option<String>,
    pub rollout_end_byte_offset: Option<String>,
    pub first_user_item_id: Option<String>,
    pub final_agent_item_id: Option<String>,
}

/// The projection's own claim about how far it has consumed the rollout.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub next_rollout_byte_offset: String,
    pub next_rollout_ordinal: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub kind: &'static str,
    pub native_version: &'static str,
    pub sqlite_version: &'static str,
    pub scope: &'static str,
    pub thread_id: String,
    /// None when this projection has no state row for the thread. That is an
    /// observation of this transaction only, never proof of empty history.
    pub checkpoint: Option<Checkpoint>,
    pub turns: Vec<TurnBoundary>,
    pub item_count: String,
    /// Highest item ordinal this projection holds, for comparison against the
    /// checkpoint. Absent when the projection holds no item for the thread.
    pub max_item_ordinal: Option<String>,
    pub source_authenticated: bool,
    pub publishable: bool,
    pub history_complete: bool,
    pub connection_closed: bool,
}

fn sqlite_error(error: rusqlite::Error) -> Error {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            Error::Busy
        }
        // The progress handler aborts a statement once the deadline, step
        // allowance, or cancellation flag is reached.
        Some(rusqlite::ErrorCode::OperationInterrupted) => Error::Budget,
        Some(rusqlite::ErrorCode::TooBig) => Error::TooLarge,
        _ => Error::SqliteUnavailable,
    }
}

fn schema_matches(actual: &str, pinned: &str) -> bool {
    let canonical = pinned.trim();
    actual == canonical || actual == canonical.replace('\n', "\r\n")
}

/// Deliberately separate from the state-database allowlists. This connection
/// may read only paginated projection bookkeeping, never item payload JSON,
/// realtime rows, credentials, or arbitrary SQL.
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
            "thread_history_projection_state" => [
                "thread_id",
                "next_rollout_byte_offset",
                "next_rollout_ordinal",
            ]
            .contains(&column_name),
            "thread_turns" => [
                "thread_id",
                "turn_id",
                "rollout_ordinal",
                "status",
                "started_at",
                "completed_at",
                "duration_ms",
                "first_user_item_id",
                "final_agent_item_id",
                "rollout_byte_offset",
                "rollout_end_ordinal",
                "rollout_end_byte_offset",
            ]
            .contains(&column_name),
            // Counting and ordinal extents only. item_json stays unreadable on
            // this connection: content belongs to the verified page pipeline.
            "thread_items" => ["thread_id", "rollout_ordinal"].contains(&column_name),
            _ => false,
        },
        AuthAction::Pragma {
            pragma_name: "journal_mode",
            pragma_value: None,
        } => true,
        // Item extents are read as aggregates so payload rows never leave
        // SQLite. Allow exactly these two, not arbitrary SQL functions.
        AuthAction::Function {
            function_name: "count" | "max",
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

fn configure(db: &Connection, guard: &Guard, readonly_memory: bool) -> Result<(), Error> {
    if !engine_matches_pin() {
        return Err(Error::EngineMismatch);
    }
    if !db.is_autocommit()
        || (!readonly_memory && !db.is_readonly("main").map_err(sqlite_error)?)
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
    db.execute_batch("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA cache_size=-512;").map_err(sqlite_error)?;
    db.authorizer(Some(authorize)).map_err(sqlite_error)?;
    guard.check()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= ID_LIMIT && !value.bytes().any(|b| b < 0x20 || b == 0x7f)
}

/// Consumes and closes the connection before returning any row.
///
/// The caller supplies the selected native thread ID, which for paginated
/// history is the PHYSICAL rollout ID recorded by the projection, not
/// necessarily the stable thread ID shown to a user. Resolving that
/// relationship stays with the separately verified state-database read.
pub fn capture_checkpoint(
    db: Connection,
    native_version: &str,
    thread_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Observation, Error> {
    capture_with_journal(db, native_version, thread_id, cancelled, "wal")
}

/// Same bounded capture against a caller-provided cold RAM snapshot, whose
/// journal mode is `memory` rather than the live WAL layout.
pub fn capture_cold_checkpoint(
    db: Connection,
    native_version: &str,
    thread_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Observation, Error> {
    capture_with_journal(db, native_version, thread_id, cancelled, "memory")
}

fn capture_with_journal(
    mut db: Connection,
    native_version: &str,
    thread_id: &str,
    cancelled: Arc<AtomicBool>,
    journal_mode: &str,
) -> Result<Observation, Error> {
    let guard = Guard {
        started: Instant::now(),
        cancelled,
        steps: Arc::new(AtomicUsize::new(0)),
    };
    let result = (|| {
        if native_version != NATIVE_VERSION || !valid_id(thread_id) {
            return Err(Error::InvalidSelection);
        }
        configure(&db, &guard, journal_mode == "memory")?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sqlite_error)?;
        for (table, pinned) in [
            ("thread_turns", TURNS_SCHEMA),
            ("thread_items", ITEMS_SCHEMA),
            ("thread_history_projection_state", PROJECTION_SCHEMA),
        ] {
            let schema: Option<String> = transaction
                .query_row(
                    "SELECT sql FROM main.sqlite_schema WHERE name=?1 AND type='table' LIMIT 2",
                    [table],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sqlite_error)?;
            if !schema
                .as_deref()
                .is_some_and(|sql| schema_matches(sql, pinned))
            {
                return Err(Error::SchemaUnsupported);
            }
        }
        let mode: String = transaction
            .query_row("PRAGMA main.journal_mode", [], |r| r.get(0))
            .map_err(sqlite_error)?;
        if mode != journal_mode {
            return Err(Error::JournalUnsupported);
        }
        guard.check()?;

        let field_error = |_| Error::InvalidFields;
        let checkpoint: Option<Checkpoint> = transaction
            .query_row(
                "SELECT next_rollout_byte_offset, next_rollout_ordinal FROM main.thread_history_projection_state WHERE thread_id=?1 LIMIT 2",
                [thread_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(sqlite_error)?
            .map(|(offset, ordinal)| Checkpoint {
                next_rollout_byte_offset: offset.to_string(),
                next_rollout_ordinal: ordinal.to_string(),
            });
        guard.check()?;

        let mut turns = Vec::new();
        {
            let mut statement = transaction
                .prepare(
                    "SELECT turn_id,status,rollout_ordinal,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset,first_user_item_id,final_agent_item_id \
                     FROM main.thread_turns WHERE thread_id=?1 ORDER BY rollout_ordinal LIMIT 2049",
                )
                .map_err(sqlite_error)?;
            let mut rows = statement.query([thread_id]).map_err(sqlite_error)?;
            while let Some(row) = rows.next().map_err(sqlite_error)? {
                guard.check()?;
                if turns.len() == TURN_LIMIT {
                    return Err(Error::TooLarge);
                }
                let optional_number = |index: usize| -> Result<Option<String>, Error> {
                    Ok(row
                        .get::<_, Option<i64>>(index)
                        .map_err(field_error)?
                        .map(|v| v.to_string()))
                };
                let boundary = TurnBoundary {
                    turn_id: row.get(0).map_err(field_error)?,
                    status: row.get(1).map_err(field_error)?,
                    rollout_ordinal: row.get::<_, i64>(2).map_err(field_error)?.to_string(),
                    rollout_byte_offset: optional_number(3)?,
                    rollout_end_ordinal: optional_number(4)?,
                    rollout_end_byte_offset: optional_number(5)?,
                    first_user_item_id: row.get(6).map_err(field_error)?,
                    final_agent_item_id: row.get(7).map_err(field_error)?,
                };
                if !valid_id(&boundary.turn_id)
                    || boundary.status.len() > ID_LIMIT
                    || boundary
                        .first_user_item_id
                        .iter()
                        .chain(boundary.final_agent_item_id.iter())
                        .any(|v| !valid_id(v))
                {
                    return Err(Error::InvalidFields);
                }
                turns.push(boundary);
            }
        }
        guard.check()?;

        let (item_count, max_item_ordinal): (i64, Option<i64>) = transaction
            .query_row(
                "SELECT COUNT(rollout_ordinal), MAX(rollout_ordinal) FROM main.thread_items WHERE thread_id=?1",
                [thread_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(sqlite_error)?;
        guard.check()?;
        transaction.rollback().map_err(sqlite_error)?;

        let observation = Observation {
            kind: "codex_paginated_projection_checkpoint",
            native_version: NATIVE_VERSION,
            sqlite_version: SQLITE_VERSION,
            scope: "provided_history_database_selected_thread_projection_only",
            thread_id: thread_id.to_string(),
            checkpoint,
            turns,
            item_count: item_count.to_string(),
            max_item_ordinal: max_item_ordinal.map(|v| v.to_string()),
            source_authenticated: false,
            publishable: false,
            history_complete: false,
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
    if db.close().is_err() {
        return Err(Error::CloseUnconfirmed);
    }
    guard.check()?;
    result
}

#[cfg(test)]
mod tests;
