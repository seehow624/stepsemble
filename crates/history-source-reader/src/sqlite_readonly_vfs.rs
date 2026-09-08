//! Read-only open/delete policy for a dedicated SQLite worker process.
//!
//! NOT a descriptor-backed source opener, ACL check, root grant or OS sandbox.
//! The built-in VFS still resolves paths. Caller must separately authenticate
//! and constrain every actual DB/WAL/SHM descriptor before private-source use.
use crate::sqlite_metadata::engine_matches_pin;
use rusqlite::ffi;
use std::ffi::{CStr, c_char, c_int};
use std::sync::{
    OnceLock,
    atomic::{AtomicPtr, Ordering},
};

static ORIGINAL: AtomicPtr<ffi::sqlite3_vfs> = AtomicPtr::new(std::ptr::null_mut());
static INSTALLED: OnceLock<Result<&'static CStr, InstallError>> = OnceLock::new();
const NAME: &CStr = c"stepsemble-readonly-vfs-1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallError {
    EngineMismatch,
    Unsupported,
    Registration,
}

unsafe extern "C" fn open(
    _vfs: *mut ffi::sqlite3_vfs,
    name: ffi::sqlite3_filename,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    output: *mut c_int,
) -> c_int {
    if file.is_null() {
        return ffi::SQLITE_MISUSE;
    }
    // SAFETY: SQLite gives xOpen writable sqlite3_file storage and optionally
    // writable output flags. Failed opens must leave pMethods null.
    unsafe {
        (*file).pMethods = std::ptr::null();
        if !output.is_null() {
            *output = 0;
        }
    }
    if name.is_null() || flags & ffi::SQLITE_OPEN_DELETEONCLOSE != 0 {
        return ffi::SQLITE_READONLY;
    }
    let kind = flags
        & (ffi::SQLITE_OPEN_MAIN_DB
            | ffi::SQLITE_OPEN_TEMP_DB
            | ffi::SQLITE_OPEN_TRANSIENT_DB
            | ffi::SQLITE_OPEN_MAIN_JOURNAL
            | ffi::SQLITE_OPEN_TEMP_JOURNAL
            | ffi::SQLITE_OPEN_SUBJOURNAL
            | ffi::SQLITE_OPEN_SUPER_JOURNAL
            | ffi::SQLITE_OPEN_WAL);
    if kind == ffi::SQLITE_OPEN_MAIN_DB {
        // SAFETY: SQLite supplies its own sqlite3_filename allocation to xOpen,
        // including URI metadata. The key is static and NUL terminated.
        let readonly_shm = unsafe { ffi::sqlite3_uri_boolean(name, c"readonly_shm".as_ptr(), 0) };
        if flags & (ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE) != 0
            || flags & ffi::SQLITE_OPEN_READONLY == 0
            || readonly_shm != 1
        {
            return ffi::SQLITE_READONLY;
        }
    } else if kind != ffi::SQLITE_OPEN_WAL {
        return ffi::SQLITE_READONLY;
    }
    // SQLite may request READWRITE|CREATE for a WAL even when main is readonly.
    // Force a genuine read-only WAL handle; missing WAL must fail, never create.
    let flags = (flags & !(ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE))
        | ffi::SQLITE_OPEN_READONLY
        | ffi::SQLITE_OPEN_NOFOLLOW;
    let original = ORIGINAL.load(Ordering::Acquire);
    if original.is_null() {
        return ffi::SQLITE_MISUSE;
    }
    // SAFETY: installation retains the built-in VFS for the process lifetime.
    // szOsFile is unchanged, and all borrowed SQLite arguments remain live.
    unsafe {
        match (*original).xOpen {
            Some(callback) => callback(original, name, file, flags, output),
            None => ffi::SQLITE_MISUSE,
        }
    }
}

unsafe extern "C" fn deny_delete(
    _vfs: *mut ffi::sqlite3_vfs,
    _name: *const c_char,
    _sync: c_int,
) -> c_int {
    ffi::SQLITE_READONLY
}

/// Register once, without changing SQLite's default VFS. No file is opened here.
/// Use the returned exact name with a READ_ONLY, URI, NOFOLLOW connection and
/// `readonly_shm=1`, followed by `sqlite_metadata::capture_name_fields`.
///
/// # Safety
/// Caller must own a dedicated fresh process with no prior SQLite connections.
/// Until process exit, all connections must use this VFS, READ_ONLY and
/// readonly_shm=1; do not unregister/modify VFS objects or replace their system
/// calls. Even an ordinary READ_ONLY connection can own writable SHM. SQLite
/// can reuse a pre-existing writable SHM object and defeat the readonly policy.
/// This is not a promise of filesystem containment or no checkpoint contention.
pub unsafe fn install_for_dedicated_process() -> Result<&'static CStr, InstallError> {
    *INSTALLED.get_or_init(|| {
        #[cfg(unix)]
        // SAFETY: geteuid has no arguments and only returns this process's UID.
        if unsafe { libc::geteuid() } == 0 {
            return Err(InstallError::Unsupported);
        }
        if !engine_matches_pin() {
            return Err(InstallError::EngineMismatch);
        }
        let builtin = if cfg!(windows) {
            c"win32"
        } else if cfg!(unix) {
            c"unix"
        } else {
            return Err(InstallError::Unsupported);
        };
        // SAFETY: built-in name is static; SQLite owns the returned VFS. The
        // caller's process-lifetime contract prevents unregister/replacement.
        let original = unsafe { ffi::sqlite3_vfs_find(builtin.as_ptr()) };
        // SAFETY: NAME is static, and this read-only lookup cannot open a file.
        if !unsafe { ffi::sqlite3_vfs_find(NAME.as_ptr()) }.is_null() {
            return Err(InstallError::Registration);
        }
        if original.is_null() {
            return Err(InstallError::Unsupported);
        }
        // SAFETY: sqlite3_vfs is a plain C function-pointer/data structure.
        // Copying it preserves pAppData and szOsFile for delegated callbacks.
        let mut shim = Box::new(unsafe { *original });
        if shim.iVersion != 3 || shim.xOpen.is_none() || shim.szOsFile <= 0 {
            return Err(InstallError::Unsupported);
        }
        shim.pNext = std::ptr::null_mut();
        shim.zName = NAME.as_ptr();
        shim.xOpen = Some(open);
        shim.xDelete = Some(deny_delete);
        ORIGINAL.store(original, Ordering::Release);
        // Intentional one-time process-lifetime allocation. SQLite retains this
        // pointer, including after a Connection closes; never return a stack VFS.
        let shim = Box::into_raw(shim);
        // SAFETY: shim and its name remain valid until process exit. makeDflt=0
        // leaves the application's default VFS unchanged.
        if unsafe { ffi::sqlite3_vfs_register(shim, 0) } != ffi::SQLITE_OK {
            return Err(InstallError::Registration);
        }
        Ok(NAME)
    })
}
