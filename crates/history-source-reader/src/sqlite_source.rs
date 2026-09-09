//! POSIX selected SQLite metadata boundary, not a Web reader grant or OS sandbox.
//! One fresh dedicated process, one source, one connection. Never call from a
//! Host process that may already have SQLite connections or POSIX file locks.
use crate::source_error::Error;
use crate::source_filesystem::{check, close, io_error, open_at, root};
use crate::sqlite_metadata::{self, Observation};
use crate::sqlite_readonly_vfs::{self, InstallError};
use rusqlite::{Connection, OpenFlags, ffi};
use serde::Serialize;
use std::ffi::{CStr, c_char, c_int, c_void};
use std::fs::{File, Metadata};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

pub mod cold;

const NAMES: [&CStr; 3] = [
    c"state_5.sqlite",
    c"state_5.sqlite-wal",
    c"state_5.sqlite-shm",
];
const VIRTUAL: [&CStr; 3] = [
    c"/stepsemble-bound/state_5.sqlite",
    c"/stepsemble-bound/state_5.sqlite-wal",
    c"/stepsemble-bound/state_5.sqlite-shm",
];
const JOURNAL: &CStr = c"/stepsemble-bound/state_5.sqlite-journal";
const URI: &str = "file:/stepsemble-bound/state_5.sqlite?mode=ro&readonly_shm=1";
pub const READ_LIMIT: usize = 8 * 1024 * 1024;
pub const READ_CALL_LIMIT: usize = 1024;
pub const SHM_MAP_LIMIT: usize = 8 * 1024 * 1024;
const TOTAL_BUDGET: Duration = Duration::from_secs(5);
static STATE: OnceLock<Mutex<Option<State>>> = OnceLock::new();

pub struct Selection {
    pub root_path: String,
    pub expected_device: u64,
    pub expected_inode: u64,
    pub native_version: String,
    pub thread_id: String,
}
pub struct RootSelection {
    pub root_path: String,
    pub expected_device: u64,
    pub expected_inode: u64,
    pub native_version: String,
}

struct Lease {
    file: File,
    before: Metadata,
}
struct State {
    cold: bool,
    selection: RootSelection,
    root: File,
    root_before: Metadata,
    leases: Vec<Lease>,
    sqlite_fds: [Option<c_int>; 3],
    opened: [bool; 3],
    maps: Vec<(usize, usize)>,
    map_count: usize,
    unmap_count: usize,
    map_bytes: usize,
    read_calls: usize,
    read_bytes: usize,
    closed_sqlite_fds: usize,
    error: Option<Error>,
    started: Instant,
    cancelled: Arc<AtomicBool>,
}

pub struct Prepared {
    state: State,
    thread_id: Option<String>,
}
/// No access to fields until finish revalidates authority and confirms close.
pub struct Pending<T = Observation> {
    state: State,
    observation: Result<T, Error>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceIdentity {
    pub role: &'static str,
    pub device: String,
    pub inode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified<T = Observation> {
    pub observation: T,
    pub identities: Vec<SourceIdentity>,
    pub filesystem_checks_passed: bool,
    pub source_descriptors_closed: usize,
    pub sqlite_descriptors_opened: usize,
    pub sqlite_descriptors_closed: usize,
    pub shm_mappings_closed: usize,
    pub requested_read_bytes: usize,
    pub read_calls: usize,
    pub mapped_shm_bytes: usize,
    pub source_authenticated: bool,
    pub publishable: bool,
}

fn same_authority(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
}
fn stat_number<T: TryInto<u64>>(actual: T, expected: u64) -> bool {
    actual.try_into().ok() == Some(expected)
}

impl State {
    fn budget(&self) -> Result<(), Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        if self.started.elapsed() >= TOTAL_BUDGET {
            return Err(Error::Budget);
        }
        if let Some(error) = self.error {
            return Err(error);
        }
        Ok(())
    }
    fn named(&self, name: &CStr) -> Result<libc::stat, Error> {
        let mut out = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: root is held, name is a fixed single component, storage is
        // correctly sized. Never open/close an extra same-inode descriptor here.
        if unsafe {
            libc::fstatat(
                self.root.as_raw_fd(),
                name.as_ptr(),
                out.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(io_error(io::Error::last_os_error()));
        }
        // SAFETY: successful fstatat initialized the complete struct.
        Ok(unsafe { out.assume_init() })
    }
    fn verify(&self) -> Result<(), Error> {
        self.budget()?;
        // SAFETY: no inputs or pointer side effects.
        let uid = unsafe { libc::geteuid() };
        if uid == 0 || !same_authority(&self.root_before, &check(&self.root, true, uid)?) {
            return Err(Error::Changed);
        }
        for (i, lease) in self.leases.iter().enumerate() {
            let current = check(&lease.file, false, uid)?;
            if !same_authority(&lease.before, &current) {
                return Err(Error::Changed);
            }
            if self.cold && !cold::same_content_stamp(&lease.before, &current) {
                return Err(Error::Changed);
            }
            let named = self.named(NAMES[i])?;
            if !stat_number(named.st_dev, current.dev())
                || !stat_number(named.st_ino, current.ino())
                || !stat_number(named.st_mode, u64::from(current.mode()))
                || named.st_nlink != 1
            {
                return Err(Error::Changed);
            }
        }
        if self.cold {
            for name in &NAMES[1..] {
                match self.named(name) {
                    Err(Error::Missing) => (),
                    Ok(_) => return Err(Error::Changed),
                    Err(error) => return Err(error),
                }
            }
        }
        match self.named(c"state_5.sqlite-journal") {
            Err(Error::Missing) => Ok(()),
            Ok(_) => Err(Error::DatabaseUnsupported),
            Err(e) => Err(e),
        }
    }
    fn verify_root_path(&self) -> Result<(), Error> {
        let current = root(&self.selection.root_path)?;
        // SAFETY: no inputs or pointer side effects.
        let result = check(&current, true, unsafe { libc::geteuid() }).and_then(|m| {
            if same_authority(&self.root_before, &m) {
                Ok(())
            } else {
                Err(Error::RootIdentityChanged)
            }
        });
        let closed = close(current);
        closed.and(result)
    }
    fn close_sources(self) -> Result<usize, Error> {
        let mut failed = false;
        let mut count = 0;
        for f in self
            .leases
            .into_iter()
            .map(|l| l.file)
            .chain(std::iter::once(self.root))
        {
            if close(f).is_err() {
                failed = true;
            } else {
                count += 1;
            }
        }
        if failed {
            Err(Error::CloseFailed)
        } else {
            Ok(count)
        }
    }
    fn read_check(&mut self, fd: c_int, amount: usize) -> Result<(), Error> {
        self.verify()?;
        if !self.sqlite_fds.contains(&Some(fd)) {
            return Err(Error::Input);
        }
        self.read_calls = self.read_calls.checked_add(1).ok_or(Error::Budget)?;
        self.read_bytes = self.read_bytes.checked_add(amount).ok_or(Error::Budget)?;
        if self.read_calls > READ_CALL_LIMIT || self.read_bytes > READ_LIMIT {
            return Err(Error::Budget);
        }
        Ok(())
    }
}

/// Prepare held descriptors, never infer HOME or expand a directory grant.
/// # Safety
/// Caller owns a fresh dedicated process with no SQLite connections/locks and
/// must not create other connections or alter VFS/syscalls through process exit.
/// Call exactly once in that process. Do not open or close other descriptors for
/// the selected DB/WAL/SHM in that process, including during cleanup or failure.
/// A failed/abandoned operation must not fall back to an unguarded connection.
pub unsafe fn prepare(selection: Selection, cancelled: Arc<AtomicBool>) -> Result<Prepared, Error> {
    if !sqlite_metadata::valid_id(&selection.thread_id) {
        return Err(Error::Input);
    }
    let mut prepared = prepare_root(
        RootSelection {
            root_path: selection.root_path,
            expected_device: selection.expected_device,
            expected_inode: selection.expected_inode,
            native_version: selection.native_version,
        },
        cancelled,
    )?;
    prepared.thread_id = Some(selection.thread_id);
    Ok(prepared)
}
/// Prepare the exact database root for bounded catalog discovery, not a guessed
/// selected thread or a permission to follow database-provided paths.
/// # Safety
/// Same fresh dedicated process and one-shot VFS/descriptor obligations as prepare.
pub unsafe fn prepare_catalog(
    selection: RootSelection,
    cancelled: Arc<AtomicBool>,
) -> Result<Prepared, Error> {
    prepare_root(selection, cancelled)
}
fn prepare_root(selection: RootSelection, cancelled: Arc<AtomicBool>) -> Result<Prepared, Error> {
    prepare_root_mode(selection, cancelled, false)
}
fn prepare_root_mode(
    selection: RootSelection,
    cancelled: Arc<AtomicBool>,
    cold: bool,
) -> Result<Prepared, Error> {
    if !cfg!(target_pointer_width = "64") || STATE.get().is_some() {
        return Err(Error::PlatformUnsupported);
    }
    // Native SHM purge passes one 32KiB region to munmap. Larger system pages
    // need separate rounded-mapping accounting and platform evidence; do not
    // misreport their native partial-size unmap as a confirmed exact close.
    // SAFETY: sysconf has no pointer arguments or filesystem side effects.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if !(1..=32 * 1024).contains(&page_size) {
        return Err(Error::PlatformUnsupported);
    }
    if selection.root_path.is_empty()
        || selection.root_path.len() > 8192
        || selection.root_path.contains('\0')
        || selection.expected_inode == 0
        || selection.native_version != sqlite_metadata::NATIVE_VERSION
    {
        return Err(Error::Input);
    }
    if !sqlite_metadata::engine_matches_pin() {
        return Err(Error::DatabaseUnsupported);
    }
    // SAFETY: geteuid only returns the current process identity.
    let uid = unsafe { libc::geteuid() };
    if uid == 0 {
        return Err(Error::PlatformUnsupported);
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(Error::Cancelled);
    }
    let started = Instant::now();
    let root = root(&selection.root_path)?;
    let root_before = check(&root, true, uid)?;
    if root_before.dev() != selection.expected_device
        || root_before.ino() != selection.expected_inode
    {
        return Err(Error::RootIdentityChanged);
    }
    let mut state = State {
        cold,
        selection,
        root,
        root_before,
        leases: Vec::with_capacity(3),
        sqlite_fds: [None; 3],
        opened: [false; 3],
        maps: Vec::new(),
        map_count: 0,
        unmap_count: 0,
        map_bytes: 0,
        read_calls: 0,
        read_bytes: 0,
        closed_sqlite_fds: 0,
        error: None,
        started,
        cancelled,
    };
    for name in &NAMES[..if cold { 1 } else { 3 }] {
        state.budget()?;
        let file = open_at(
            state.root.as_raw_fd(),
            name.to_str().map_err(|_| Error::Input)?,
            false,
        )?;
        let before = check(&file, false, uid)?;
        if before.dev() != state.root_before.dev() {
            return Err(Error::ContainmentUnavailable);
        }
        state.leases.push(Lease { file, before });
    }
    if state.leases[0].before.size() == 0 {
        return Err(Error::Empty);
    }
    state.verify()?;
    state.verify_root_path()?;
    Ok(Prepared {
        state,
        thread_id: None,
    })
}

impl Prepared {
    pub fn read(self) -> Result<Pending, Error> {
        self.read_selected(false)
    }
    pub fn read_name_context(self) -> Result<Pending, Error> {
        self.read_selected(true)
    }
    fn read_selected(self, with_context: bool) -> Result<Pending, Error> {
        let thread = self.thread_id.clone().ok_or(Error::Input)?;
        self.read_with(move |db, native, cancelled| {
            let capture = if with_context {
                sqlite_metadata::capture_name_context
            } else {
                sqlite_metadata::capture_name_fields
            };
            capture(db, native, &thread, cancelled)
        })
    }
    pub fn read_catalog(self) -> Result<Pending<sqlite_metadata::CatalogObservation>, Error> {
        if self.thread_id.is_some() {
            return Err(Error::Input);
        }
        self.read_with(sqlite_metadata::capture_catalog)
    }
    fn read_with<T>(
        self,
        capture: impl FnOnce(Connection, &str, Arc<AtomicBool>) -> Result<T, sqlite_metadata::Error>,
    ) -> Result<Pending<T>, Error> {
        self.state.verify()?;
        self.state.verify_root_path()?;
        let native = self.state.selection.native_version.clone();
        let cancelled = self.state.cancelled.clone();
        if STATE.set(Mutex::new(Some(self.state))).is_err() {
            return Err(Error::PlatformUnsupported);
        }
        // SAFETY: Prepared's constructor requires a dedicated fresh process;
        // state owns all FDs before any connection, and setup happens only once.
        let vfs = unsafe { sqlite_readonly_vfs::install_bound(configure) };
        let observation = match vfs {
            Err(_) => Err(Error::DatabaseUnsupported),
            Ok(name) => match Connection::open_with_flags_and_vfs(
                URI,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
                name.to_str().map_err(|_| Error::DatabaseUnsupported)?,
            ) {
                Ok(db) => capture(db, &native, cancelled).map_err(map_sqlite_error),
                Err(_) => Err(Error::DatabaseUnavailable),
            },
        };
        let mut guard = STATE
            .get()
            .ok_or(Error::CloseFailed)?
            .lock()
            .map_err(|_| Error::CloseFailed)?;
        let state = guard.as_ref().ok_or(Error::CloseFailed)?;
        // Unknown close keeps original leases retained until the dedicated
        // process exits. Never publish or release a slot on an assumed close.
        if state.sqlite_fds.iter().any(Option::is_some)
            || !state.maps.is_empty()
            || state.error == Some(Error::CloseFailed)
        {
            return Err(Error::CloseFailed);
        }
        let state = guard.take().ok_or(Error::CloseFailed)?;
        let observation = if let Some(error) = state.error {
            Err(error)
        } else {
            observation
        };
        Ok(Pending { state, observation })
    }
}
impl<T> Pending<T> {
    pub fn finish(self) -> Result<Verified<T>, Error> {
        let Self { state, observation } = self;
        let verified = state.verify().and_then(|_| state.verify_root_path());
        let identities = state
            .leases
            .iter()
            .enumerate()
            .map(|(i, l)| SourceIdentity {
                role: ["database", "wal", "shm"][i],
                device: l.before.dev().to_string(),
                inode: l.before.ino().to_string(),
            })
            .collect();
        let opened = state.opened.iter().filter(|v| **v).count();
        let (closed, unmaps, read_bytes, read_calls, map_bytes) = (
            state.closed_sqlite_fds,
            state.unmap_count,
            state.read_bytes,
            state.read_calls,
            state.map_bytes,
        );
        let source_closed = state.close_sources()?;
        verified?;
        let observation = observation?;
        if opened != 3 || closed != opened || source_closed != 4 {
            return Err(Error::CloseFailed);
        }
        Ok(Verified {
            observation,
            identities,
            filesystem_checks_passed: true,
            source_descriptors_closed: source_closed,
            sqlite_descriptors_opened: opened,
            sqlite_descriptors_closed: closed,
            shm_mappings_closed: unmaps,
            requested_read_bytes: read_bytes,
            read_calls,
            mapped_shm_bytes: map_bytes,
            source_authenticated: false,
            publishable: false,
        })
    }
}

fn map_sqlite_error(error: sqlite_metadata::Error) -> Error {
    use sqlite_metadata::Error as S;
    match error {
        S::InvalidSelection => Error::Input,
        S::EngineMismatch | S::SchemaUnsupported | S::JournalUnsupported => {
            Error::DatabaseUnsupported
        }
        S::Busy => Error::Busy,
        S::Budget => Error::Budget,
        S::Cancelled => Error::Cancelled,
        S::TooLarge => Error::TooLarge,
        S::CloseUnconfirmed => Error::CloseFailed,
        _ => Error::DatabaseUnavailable,
    }
}

fn errno(value: c_int) {
    // SAFETY: platform libc returns writable thread-local errno storage.
    unsafe {
        #[cfg(target_os = "macos")]
        {
            *libc::__error() = value;
        }
        #[cfg(target_os = "linux")]
        {
            *libc::__errno_location() = value;
        }
    }
}
fn with_state<T>(f: impl FnOnce(&mut State) -> Result<T, Error>) -> Result<T, Error> {
    let mut guard = STATE
        .get()
        .ok_or(Error::Io)?
        .lock()
        .map_err(|_| Error::Io)?;
    let state = guard.as_mut().ok_or(Error::Io)?;
    let result = f(state);
    if let Err(error) = result {
        if error == Error::CloseFailed {
            state.error = Some(error);
        } else {
            state.error.get_or_insert(error);
        }
    }
    result
}
unsafe fn role(name: *const c_char) -> Result<usize, Error> {
    if name.is_null() {
        return Err(Error::Input);
    }
    // SAFETY: pinned SQLite supplies a live NUL-terminated filename.
    let name = unsafe { CStr::from_ptr(name) };
    VIRTUAL.iter().position(|v| *v == name).ok_or(Error::Input)
}

unsafe extern "C" fn system_open(name: *const c_char, flags: c_int, _mode: c_int) -> c_int {
    let result = with_state(|s| {
        s.verify()?;
        // SAFETY: SQLite supplies a live filename; role validates exact virtual names.
        let i = unsafe { role(name) }?;
        if flags & libc::O_ACCMODE != libc::O_RDONLY
            || flags & (libc::O_CREAT | libc::O_TRUNC | libc::O_APPEND | libc::O_EXCL) != 0
            || s.opened[i]
        {
            return Err(Error::AccessDenied);
        }
        // SAFETY: live held descriptor; F_DUPFD_CLOEXEC accepts an integer floor.
        // Retain the original File until AFTER SQLite closes every returned dup.
        let fd = unsafe { libc::fcntl(s.leases[i].file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            return Err(Error::Io);
        }
        s.sqlite_fds[i] = Some(fd);
        s.opened[i] = true;
        Ok(fd)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EACCES);
        -1
    })
}

unsafe extern "C" fn system_close(fd: c_int) -> c_int {
    let result = with_state(|s| {
        let i = s
            .sqlite_fds
            .iter()
            .position(|v| *v == Some(fd))
            .ok_or(Error::CloseFailed)?;
        // SAFETY: fd is an owned SQLite dup, registered on successful open.
        // Never retry failure: kernel close errors can leave ownership uncertain.
        if unsafe { libc::close(fd) } != 0 {
            return Err(Error::CloseFailed);
        }
        s.sqlite_fds[i] = None;
        s.closed_sqlite_fds += 1;
        Ok(0)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EIO);
        -1
    })
}

unsafe extern "C" fn system_stat(name: *const c_char, out: *mut libc::stat) -> c_int {
    let result = with_state(|s| {
        s.verify()?;
        if out.is_null() {
            return Err(Error::Input);
        }
        // SAFETY: SQLite supplies a live filename; only fixed virtual names pass.
        let i = unsafe { role(name) }?;
        // SAFETY: caller supplies writable struct stat of the pinned platform ABI.
        if unsafe { libc::fstat(s.leases[i].file.as_raw_fd(), out) } != 0 {
            return Err(Error::Io);
        }
        Ok(0)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EACCES);
        -1
    })
}

unsafe extern "C" fn system_pread(
    fd: c_int,
    out: *mut c_void,
    len: usize,
    offset: libc::off_t,
) -> libc::ssize_t {
    let result = with_state(|s| {
        s.read_check(fd, len)?;
        if out.is_null() || offset < 0 {
            return Err(Error::Input);
        }
        // SAFETY: SQLite supplies writable len-byte storage and an offset.
        // The descriptor is one of our tracked read-only duplicates.
        let n = unsafe { libc::pread(fd, out, len, offset) };
        if n < 0 {
            return Err(Error::Io);
        }
        Ok(n)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EACCES);
        -1
    })
}
unsafe extern "C" fn system_read(fd: c_int, out: *mut c_void, len: usize) -> libc::ssize_t {
    let result = with_state(|s| {
        s.read_check(fd, len)?;
        if out.is_null() {
            return Err(Error::Input);
        }
        // SAFETY: same tracked descriptor and writable-buffer contract as pread.
        let n = unsafe { libc::read(fd, out, len) };
        if n < 0 {
            return Err(Error::Io);
        }
        Ok(n)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EACCES);
        -1
    })
}

unsafe extern "C" fn system_mmap(
    address: *mut c_void,
    len: usize,
    protection: c_int,
    flags: c_int,
    fd: c_int,
    offset: libc::off_t,
) -> *mut c_void {
    let result = with_state(|s| {
        s.verify()?;
        // Main-file mmap is disabled by capture_name_fields. Only readonly SHM
        // mapping is allowed here; this path never uses native main-file mremap.
        if s.sqlite_fds[2] != Some(fd)
            || !address.is_null()
            || protection != libc::PROT_READ
            || flags != libc::MAP_SHARED
            || offset < 0
            || len == 0
        {
            return Err(Error::AccessDenied);
        }
        let end = u64::try_from(offset)
            .ok()
            .and_then(|v| v.checked_add(len as u64))
            .ok_or(Error::TooLarge)?;
        if end > s.leases[2].file.metadata().map_err(io_error)?.size() {
            return Err(Error::DatabaseUnavailable);
        }
        let total = s.map_bytes.checked_add(len).ok_or(Error::Budget)?;
        if total > SHM_MAP_LIMIT || s.map_count >= 256 {
            return Err(Error::Budget);
        }
        // SAFETY: kernel maps a validated readonly SHM descriptor, bounded length
        // and offset; no executable, writable, fixed-address or anonymous map.
        let mapped = unsafe { libc::mmap(address, len, protection, flags, fd, offset) };
        if mapped == libc::MAP_FAILED {
            return Err(Error::Io);
        }
        s.maps.push((mapped as usize, len));
        s.map_count += 1;
        s.map_bytes = total;
        Ok(mapped)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EACCES);
        libc::MAP_FAILED
    })
}
unsafe extern "C" fn system_munmap(address: *mut c_void, len: usize) -> c_int {
    let result = with_state(|s| {
        let i = s
            .maps
            .iter()
            .position(|v| *v == (address as usize, len))
            .ok_or(Error::CloseFailed)?;
        // SAFETY: exact address/length match a successful tracked mmap. Keep the
        // mapping recorded on failure; never assume its resources were released.
        if unsafe { libc::munmap(address, len) } != 0 {
            return Err(Error::CloseFailed);
        }
        s.maps.swap_remove(i);
        s.unmap_count += 1;
        Ok(0)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EIO);
        -1
    })
}

unsafe extern "C" fn system_unlink(_name: *const c_char) -> c_int {
    let _ = with_state::<()>(|_| Err(Error::AccessDenied));
    errno(libc::EROFS);
    -1
}
unsafe extern "C" fn system_access(name: *const c_char, mode: c_int) -> c_int {
    if mode & (libc::W_OK | libc::X_OK) != 0 {
        errno(libc::EACCES);
        return -1;
    }
    let result = with_state(|s| {
        s.verify()?;
        // SAFETY: SQLite supplies a valid NUL-terminated filename.
        unsafe { role(name) }?;
        if mode != libc::F_OK && mode != libc::R_OK {
            return Err(Error::Input);
        }
        Ok(0)
    });
    result.unwrap_or_else(|_| {
        errno(libc::EACCES);
        -1
    })
}

unsafe extern "C" fn full_path(
    _vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    len: c_int,
    out: *mut c_char,
) -> c_int {
    // SAFETY: SQLite supplies a valid filename or null; role checks the name.
    if unsafe { role(name) } != Ok(0)
        || out.is_null()
        || len <= 0
        || (len as usize) < VIRTUAL[0].to_bytes_with_nul().len()
    {
        return ffi::SQLITE_CANTOPEN;
    }
    // SAFETY: out is writable len-byte SQLite storage; checked capacity and the
    // static virtual name never overlap. No actual path resolution is performed.
    unsafe {
        std::ptr::copy_nonoverlapping(
            VIRTUAL[0].as_ptr(),
            out,
            VIRTUAL[0].to_bytes_with_nul().len(),
        )
    };
    ffi::SQLITE_OK
}
unsafe extern "C" fn access(
    _vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    flags: c_int,
    out: *mut c_int,
) -> c_int {
    if out.is_null() || name.is_null() {
        return ffi::SQLITE_IOERR_ACCESS;
    }
    // SAFETY: SQLite supplied writable int output and a live NUL-terminated name.
    unsafe { *out = 0 };
    // SAFETY: same filename lifetime as above.
    let journal = unsafe { CStr::from_ptr(name) } == JOURNAL;
    let result = with_state(|s| {
        s.verify()?; // Includes verifying absence of any rollback journal.
        if journal {
            return Ok(0);
        }
        // SAFETY: valid filename checked against the exact virtual role set.
        unsafe { role(name) }?;
        match flags {
            ffi::SQLITE_ACCESS_EXISTS | ffi::SQLITE_ACCESS_READ => Ok(1),
            ffi::SQLITE_ACCESS_READWRITE => Ok(0),
            _ => Err(Error::Input),
        }
    });
    match result {
        Ok(value) => {
            // SAFETY: non-null writable SQLite output checked above.
            unsafe { *out = value };
            ffi::SQLITE_OK
        }
        Err(_) => ffi::SQLITE_IOERR_ACCESS,
    }
}
unsafe extern "C" fn randomness(
    _vfs: *mut ffi::sqlite3_vfs,
    len: c_int,
    out: *mut c_char,
) -> c_int {
    if out.is_null() || !(1..=256).contains(&len) {
        return 0;
    }
    // SAFETY: getentropy supports <=256 bytes; SQLite owns the writable buffer.
    // Do not route entropy through an unbound /dev/urandom filename in SQLite.
    if unsafe { libc::getentropy(out.cast(), len as usize) } == 0 {
        len
    } else {
        let _ = with_state::<()>(|_| Err(Error::Io));
        0
    }
}

unsafe fn configure(
    vfs: *mut ffi::sqlite3_vfs,
    shim: &mut ffi::sqlite3_vfs,
) -> Result<(), InstallError> {
    // SQLite's process-wide PRNG uses the DEFAULT VFS, even for a connection
    // opened with a named VFS. Keep its entropy request out of path-based I/O.
    // SAFETY: exclusive fresh process; never mutate an unknown/custom default.
    if unsafe { ffi::sqlite3_vfs_find(std::ptr::null()) } != vfs {
        return Err(InstallError::Unsupported);
    }
    // SAFETY: built-in VFS lives for the process and has no concurrent users yet.
    unsafe { (*vfs).xRandomness = Some(randomness) };
    // SAFETY: installer verified a live built-in VFS v3 before any connections.
    let set = unsafe { (*vfs).xSetSystemCall }.ok_or(InstallError::Unsupported)?;
    // SAFETY: same live VFS and registration-time exclusive ownership.
    let get = unsafe { (*vfs).xGetSystemCall }.ok_or(InstallError::Unsupported)?;
    for name in [c"open", c"close", c"stat", c"fstat", c"mmap", c"munmap"] {
        // SAFETY: VFS and static NUL-terminated name are live, lookup opens nothing.
        if unsafe { get(vfs, name.as_ptr()) }.is_none() {
            return Err(InstallError::Unsupported);
        }
    }
    type Open = unsafe extern "C" fn(*const c_char, c_int, c_int) -> c_int;
    type Close = unsafe extern "C" fn(c_int) -> c_int;
    type Stat = unsafe extern "C" fn(*const c_char, *mut libc::stat) -> c_int;
    type Read = unsafe extern "C" fn(c_int, *mut c_void, usize) -> libc::ssize_t;
    type Pread = unsafe extern "C" fn(c_int, *mut c_void, usize, libc::off_t) -> libc::ssize_t;
    type Mmap =
        unsafe extern "C" fn(*mut c_void, usize, c_int, c_int, c_int, libc::off_t) -> *mut c_void;
    type Munmap = unsafe extern "C" fn(*mut c_void, usize) -> c_int;
    type Unlink = unsafe extern "C" fn(*const c_char) -> c_int;
    type Access = unsafe extern "C" fn(*const c_char, c_int) -> c_int;
    // SAFETY: pinned os_unix prototypes use these exact C signatures; supported
    // platforms are 64-bit (off_t/off64_t match). SQLite erases then casts these
    // pointers back to their concrete signatures, never calls the erased type.
    let callbacks = unsafe {
        [
            (
                c"open",
                std::mem::transmute::<Open, unsafe extern "C" fn()>(system_open),
            ),
            (
                c"close",
                std::mem::transmute::<Close, unsafe extern "C" fn()>(system_close),
            ),
            (
                c"stat",
                std::mem::transmute::<Stat, unsafe extern "C" fn()>(system_stat),
            ),
            (
                c"lstat",
                std::mem::transmute::<Stat, unsafe extern "C" fn()>(system_stat),
            ),
            (
                c"read",
                std::mem::transmute::<Read, unsafe extern "C" fn()>(system_read),
            ),
            (
                c"pread",
                std::mem::transmute::<Pread, unsafe extern "C" fn()>(system_pread),
            ),
            (
                c"pread64",
                std::mem::transmute::<Pread, unsafe extern "C" fn()>(system_pread),
            ),
            (
                c"mmap",
                std::mem::transmute::<Mmap, unsafe extern "C" fn()>(system_mmap),
            ),
            (
                c"munmap",
                std::mem::transmute::<Munmap, unsafe extern "C" fn()>(system_munmap),
            ),
            (
                c"unlink",
                std::mem::transmute::<Unlink, unsafe extern "C" fn()>(system_unlink),
            ),
            (
                c"access",
                std::mem::transmute::<Access, unsafe extern "C" fn()>(system_access),
            ),
        ]
    };
    for (name, callback) in callbacks {
        // SAFETY: caller exclusively owns the process-wide SQLite table; each
        // static name is in the fixed engine's table, including optional slots.
        if unsafe { set(vfs, name.as_ptr(), Some(callback)) } != ffi::SQLITE_OK {
            return Err(InstallError::Registration);
        }
    }
    shim.xFullPathname = Some(full_path);
    shim.xAccess = Some(access);
    shim.xRandomness = Some(randomness);
    Ok(())
}
