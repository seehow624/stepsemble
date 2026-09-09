//! Cold WAL-mode databases only: no WAL/SHM/journal may exist. Take the native
//! POSIX main-file SHARED lock before copying into bounded private RAM. A native
//! writer can create a WAL, but cannot delete it under this lock; every fence
//! then refuses publication. No original descriptor is ever writable, no source
//! is declared immutable, and no private SQLite pages are persisted to a temp file.
//!
//! This is deliberately a distinct API/proof, not a fallback hidden inside the
//! v4-v6 three-file contract. Call in a fresh one-shot process, never in a Host
//! with existing SQLite connections or same-inode descriptors/locks.
use super::*;
use std::ptr::NonNull;

pub const SNAPSHOT_LIMIT: usize = 64 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
const PENDING_BYTE: libc::off_t = 0x4000_0000;
const SHARED_FIRST: libc::off_t = PENDING_BYTE + 2;
const SHARED_SIZE: libc::off_t = 510;

pub struct Prepared {
    state: State,
}
/// Sealed proof of the exact READONLY deserialize construction. SQLite's
/// sqlite3_db_readonly reports the btree open flags, not memdb's immutable
/// deserialize flag; do not weaken the hot connection guard to accommodate it.
pub(crate) struct ReadOnlyMemory(Connection);
impl ReadOnlyMemory {
    pub(crate) fn into_connection(self) -> Connection {
        self.0
    }
}
pub struct Pending<T> {
    state: State,
    observation: Result<T, Error>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified<T> {
    pub observation: T,
    pub source_layout: &'static str,
    pub identities: Vec<SourceIdentity>,
    pub filesystem_checks_passed: bool,
    pub source_descriptors_closed: usize,
    pub snapshot_bytes: usize,
    pub source_read_calls: usize,
    pub source_main_shared_lock: bool,
    pub absent_sidecars_verified: bool,
    pub snapshot_storage: &'static str,
    pub source_authenticated: bool,
    pub publishable: bool,
}

pub(super) fn same_content_stamp(a: &Metadata, b: &Metadata) -> bool {
    a.size() == b.size()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

fn lock(fd: c_int, kind: libc::c_short, start: libc::off_t, len: libc::off_t) -> Result<(), Error> {
    // SAFETY: all-zero flock is a valid initial value; fields below describe a
    // finite byte range. F_SETLK is non-blocking and never writes file content.
    let mut range: libc::flock = unsafe { std::mem::zeroed() };
    range.l_type = kind;
    range.l_whence = libc::SEEK_SET as libc::c_short;
    range.l_start = start;
    range.l_len = len;
    // SAFETY: fd is the held read-only main descriptor, range is live and uses
    // this platform's flock ABI. No writable or exclusive lock is requested.
    if unsafe { libc::fcntl(fd, libc::F_SETLK, &range) } != 0 {
        return Err(match io::Error::last_os_error().raw_os_error() {
            Some(libc::EAGAIN | libc::EACCES) => Error::Busy,
            _ => Error::Io,
        });
    }
    Ok(())
}

/// Exact main-file root, owner/ACL/mount checks shared with the hot reader.
/// No data or SQLite connection is exposed before the cold-source lock/fences.
/// # Safety
/// Fresh dedicated process only. Do not open or close any other descriptor to
/// this database until this value is consumed/dropped (POSIX per-process locks).
pub unsafe fn prepare(
    selection: RootSelection,
    cancelled: Arc<AtomicBool>,
) -> Result<Prepared, Error> {
    let state = prepare_root_mode(selection, cancelled, true)?.state;
    let fd = state.leases[0].file.as_raw_fd();
    // Match SQLite's SHARED acquisition ordering, including its pending-byte
    // check. Closing the held main FD releases locks on every error path.
    lock(fd, libc::F_RDLCK as _, PENDING_BYTE, 1)?;
    lock(fd, libc::F_RDLCK as _, SHARED_FIRST, SHARED_SIZE)?;
    lock(fd, libc::F_UNLCK as _, PENDING_BYTE, 1)?;
    state.verify()?;
    state.verify_root_path()?;
    Ok(Prepared { state })
}

struct Buffer(NonNull<u8>);
impl Drop for Buffer {
    fn drop(&mut self) {
        // SAFETY: exclusively owned sqlite3_malloc64 allocation, not yet
        // transferred to SQLite's FREEONCLOSE ownership.
        unsafe { ffi::sqlite3_free(self.0.as_ptr().cast()) };
    }
}

impl Prepared {
    fn connection(&mut self) -> Result<ReadOnlyMemory, Error> {
        let s = &mut self.state;
        s.verify()?;
        s.verify_root_path()?;
        let size = usize::try_from(s.leases[0].before.size()).map_err(|_| Error::TooLarge)?;
        if size > SNAPSHOT_LIMIT {
            return Err(Error::TooLarge);
        }
        if size < 512 {
            return Err(Error::DatabaseUnsupported);
        }
        // SAFETY: size is finite/nonzero; allocation failure is checked. This
        // private buffer is never mapped to or written back to the source.
        let buffer = Buffer(
            NonNull::new(unsafe { ffi::sqlite3_malloc64(size as u64) }.cast())
                .ok_or(Error::TooLarge)?,
        );
        let mut offset = 0;
        while offset < size {
            s.verify()?;
            let length = CHUNK.min(size - offset);
            if s.read_calls >= SNAPSHOT_LIMIT / CHUNK {
                return Err(Error::Budget);
            }
            s.read_calls += 1;
            // SAFETY: the allocation has size bytes; checked offset/length
            // remain inside it. Source FD is O_RDONLY, offset is <=64 MiB.
            let read = unsafe {
                libc::pread(
                    s.leases[0].file.as_raw_fd(),
                    buffer.0.as_ptr().add(offset).cast(),
                    length,
                    offset as libc::off_t,
                )
            };
            if read < 0 {
                return Err(Error::Io);
            }
            if read as usize != length {
                return Err(Error::Changed);
            }
            offset += length;
            s.read_bytes += length;
        }
        s.verify()?;
        s.verify_root_path()?;
        // SAFETY: the complete allocation is initialized by exact reads above,
        // exclusively owned here and larger than the 100-byte SQLite header.
        let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.0.as_ptr(), size) };
        let page_size = u16::from_be_bytes([bytes[16], bytes[17]]) as usize;
        let page_size = if page_size == 1 { 65536 } else { page_size };
        if &bytes[..16] != b"SQLite format 3\0"
            || bytes[18..20] != [2, 2]
            || !(512..=65536).contains(&page_size)
            || !page_size.is_power_of_two()
            || size % page_size != 0
        {
            return Err(Error::DatabaseUnsupported);
        }
        // sqlite3_deserialize does not support WAL images. The pinned engine's
        // documented conversion changes ONLY these two bytes of the PRIVATE
        // in-memory copy. Original database bytes/header are never modified.
        bytes[18..20].copy_from_slice(&[1, 1]);
        memory_connection(buffer, size)
    }

    pub fn read_name_context(mut self, id: &str) -> Pending<Observation> {
        let observation = if !sqlite_metadata::valid_id(id) {
            Err(Error::Input)
        } else {
            self.connection().and_then(|db| {
                sqlite_metadata::capture_cold_context(
                    db,
                    &self.state.selection.native_version,
                    id,
                    Arc::clone(&self.state.cancelled),
                )
                .map_err(map_sqlite_error)
            })
        };
        Pending {
            state: self.state,
            observation,
        }
    }

    pub fn read_catalog(mut self) -> Pending<sqlite_metadata::CatalogObservation> {
        let observation = self.connection().and_then(|db| {
            sqlite_metadata::capture_cold_catalog(
                db,
                &self.state.selection.native_version,
                Arc::clone(&self.state.cancelled),
            )
            .map_err(map_sqlite_error)
        });
        Pending {
            state: self.state,
            observation,
        }
    }
}

fn memory_connection(buffer: Buffer, size: usize) -> Result<ReadOnlyMemory, Error> {
    let db = Connection::open_in_memory().map_err(|_| Error::DatabaseUnavailable)?;
    let pointer = buffer.0.as_ptr();
    // SQLite takes/frees this allocation even if deserialize returns an
    // error when FREEONCLOSE is set. No double-free from Buffer::drop.
    std::mem::forget(buffer);
    // SAFETY: fresh connection, exact live sqlite3_malloc64 allocation,
    // correct size and pinned API flags; ownership transferred above.
    let rc = unsafe {
        ffi::sqlite3_deserialize(
            db.handle(),
            c"main".as_ptr(),
            pointer,
            size as i64,
            size as i64,
            ffi::SQLITE_DESERIALIZE_FREEONCLOSE | ffi::SQLITE_DESERIALIZE_READONLY,
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(if db.close().is_ok() {
            Error::DatabaseUnavailable
        } else {
            Error::CloseFailed
        });
    }
    Ok(ReadOnlyMemory(db))
}

impl<T> Pending<T> {
    pub fn finish(self) -> Result<Verified<T>, Error> {
        let checked = self
            .state
            .verify()
            .and_then(|()| self.state.verify_root_path());
        let lease = &self.state.leases[0];
        let identity = SourceIdentity {
            role: "database",
            device: lease.before.dev().to_string(),
            inode: lease.before.ino().to_string(),
        };
        let bytes = self.state.read_bytes;
        let calls = self.state.read_calls;
        // Keep the main shared lock until after ALL publication checks. Never
        // reopen/close a same-inode descriptor to verify it during this interval.
        let closed = self.state.close_sources()?;
        if closed != 2 {
            return Err(Error::CloseFailed);
        }
        checked?;
        Ok(Verified {
            observation: self.observation?,
            source_layout: "cold_snapshot",
            identities: vec![identity],
            filesystem_checks_passed: true,
            source_descriptors_closed: closed,
            snapshot_bytes: bytes,
            source_read_calls: calls,
            source_main_shared_lock: true,
            absent_sidecars_verified: true,
            snapshot_storage: "private_readonly_memory",
            source_authenticated: false,
            publishable: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> ReadOnlyMemory {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE owned(value TEXT); INSERT INTO owned VALUES('unchanged');")
            .unwrap();
        let mut length = 0_i64;
        // SAFETY: owned fresh in-memory test DB, writable length, static schema;
        // flags=0 returns a new sqlite3_malloc allocation owned by the caller.
        let pointer =
            unsafe { ffi::sqlite3_serialize(db.handle(), c"main".as_ptr(), &mut length, 0) };
        let buffer = Buffer(NonNull::new(pointer).unwrap());
        db.close().unwrap();
        memory_connection(buffer, length as usize).unwrap()
    }

    #[test]
    fn deserialize_readonly_enforces_native_write_denial_without_query_only() {
        let db = memory().into_connection();
        // sqlite3_db_readonly checks btree flags, not memdb's deserialize flag.
        // Pin this distinction instead of silently broadening the hot guard.
        assert!(!db.is_readonly("main").unwrap());
        assert_eq!(
            db.query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.execute_batch("UPDATE owned SET value='must not write';")
                .unwrap_err()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::ReadOnly)
        );
        assert_eq!(
            db.query_row("SELECT value FROM owned", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "unchanged"
        );
        assert!(db.is_autocommit());
        db.close().unwrap();
    }

    #[test]
    fn sealed_snapshot_does_not_make_old_public_wal_capture_accept_memory() {
        let db = memory().into_connection();
        let result = sqlite_metadata::capture_name_context(
            db,
            sqlite_metadata::NATIVE_VERSION,
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            result.unwrap_err(),
            sqlite_metadata::Error::ConnectionNotFreshReadOnly
        );
    }
}
