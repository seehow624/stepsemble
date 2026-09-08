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

// Win32 SHM opens bypass VFS xOpen and use OPEN_ALWAYS even for readonly_shm.
// Restrict SQLite's own syscall table in this dedicated process, not the OS's
// global API table. This also covers built-in cleanup bypassing shim xDelete.
#[cfg(windows)]
mod windows_policy {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{
            ERROR_ACCESS_DENIED, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE, SetLastError,
        },
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{FILE_FLAG_DELETE_ON_CLOSE, OPEN_EXISTING},
    };

    type CreateWide = unsafe extern "system" fn(
        *const u16,
        u32,
        u32,
        *const SECURITY_ATTRIBUTES,
        u32,
        u32,
        HANDLE,
    ) -> HANDLE;
    static CREATE_WIDE: OnceLock<CreateWide> = OnceLock::new();

    unsafe extern "system" fn open_existing(
        name: *const u16,
        _access: u32,
        sharing: u32,
        security: *const SECURITY_ATTRIBUTES,
        _disposition: u32,
        flags: u32,
        template: HANDLE,
    ) -> HANDLE {
        if name.is_null() || flags & FILE_FLAG_DELETE_ON_CLOSE != 0 {
            // SAFETY: SetLastError only changes this thread's error code.
            unsafe { SetLastError(ERROR_ACCESS_DENIED) };
            return INVALID_HANDLE_VALUE;
        }
        let Some(original) = CREATE_WIDE.get() else {
            // SAFETY: same thread-local error operation as above.
            unsafe { SetLastError(ERROR_ACCESS_DENIED) };
            return INVALID_HANDLE_VALUE;
        };
        // SAFETY: SQLite's pinned osCreateFileW has the exact Windows ABI and
        // pointer lifetimes below. Keep sharing/overlapped semantics for locks,
        // but the kernel must not create, truncate, delete or grant write access.
        unsafe {
            original(
                name,
                GENERIC_READ,
                sharing,
                security,
                OPEN_EXISTING,
                flags,
                template,
            )
        }
    }

    unsafe extern "system" fn deny_ansi_open(
        _name: *const u8,
        _access: u32,
        _sharing: u32,
        _security: *const SECURITY_ATTRIBUTES,
        _disposition: u32,
        _flags: u32,
        _template: HANDLE,
    ) -> HANDLE {
        // SAFETY: SetLastError has no pointer arguments. Legacy ANSI paths are
        // intentionally unsupported; modern Windows uses the wide callback.
        unsafe { SetLastError(ERROR_ACCESS_DENIED) };
        INVALID_HANDLE_VALUE
    }

    unsafe extern "system" fn deny_wide_delete(_name: *const u16) -> i32 {
        // SAFETY: thread-local error only; no path is touched.
        unsafe { SetLastError(ERROR_ACCESS_DENIED) };
        0
    }

    unsafe extern "system" fn deny_ansi_delete(_name: *const u8) -> i32 {
        // SAFETY: thread-local error only; no path is touched.
        unsafe { SetLastError(ERROR_ACCESS_DENIED) };
        0
    }

    pub(super) unsafe fn install(vfs: *mut ffi::sqlite3_vfs) -> Result<(), InstallError> {
        // SAFETY: caller verified a process-lifetime built-in VFS v3, before
        // any connections/concurrent use. Function table mutation is exclusive.
        let (get, set) = unsafe {
            (
                (*vfs).xGetSystemCall.ok_or(InstallError::Unsupported)?,
                (*vfs).xSetSystemCall.ok_or(InstallError::Unsupported)?,
            )
        };
        // SAFETY: valid built-in VFS and static names; lookups open no files.
        let wide = unsafe { get(vfs, c"CreateFileW".as_ptr()) }.ok_or(InstallError::Unsupported)?;
        // SAFETY: the pinned Win32 VFS declares osCreateFileW as HANDLE
        // (WINAPI*)(LPCWSTR,DWORD,DWORD,LPSECURITY_ATTRIBUTES,DWORD,DWORD,HANDLE).
        // SQLite's erased C function pointer is cast back to that precise ABI;
        // it is never invoked using the erased signature.
        let wide = unsafe { std::mem::transmute::<unsafe extern "C" fn(), CreateWide>(wide) };
        CREATE_WIDE
            .set(wide)
            .map_err(|_| InstallError::Registration)?;
        // SAFETY: SQLite's syscall registration uses erased function pointers;
        // pinned C casts each back to the matching WINAPI prototype before use.
        let callbacks = unsafe {
            [
                (
                    c"CreateFileW",
                    std::mem::transmute::<CreateWide, unsafe extern "C" fn()>(open_existing),
                ),
                (
                    c"CreateFileA",
                    std::mem::transmute::<
                        unsafe extern "system" fn(
                            *const u8,
                            u32,
                            u32,
                            *const SECURITY_ATTRIBUTES,
                            u32,
                            u32,
                            HANDLE,
                        ) -> HANDLE,
                        unsafe extern "C" fn(),
                    >(deny_ansi_open),
                ),
                (
                    c"DeleteFileW",
                    std::mem::transmute::<
                        unsafe extern "system" fn(*const u16) -> i32,
                        unsafe extern "C" fn(),
                    >(deny_wide_delete),
                ),
                (
                    c"DeleteFileA",
                    std::mem::transmute::<
                        unsafe extern "system" fn(*const u8) -> i32,
                        unsafe extern "C" fn(),
                    >(deny_ansi_delete),
                ),
            ]
        };
        for (name, callback) in callbacks {
            // SAFETY: all four names exist in the pinned Win32 syscall table,
            // even when the optional ANSI callback was originally null.
            if unsafe { set(vfs, name.as_ptr(), Some(callback)) } != ffi::SQLITE_OK {
                return Err(InstallError::Registration);
            }
        }
        Ok(())
    }
}

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

/// Register once, without changing SQLite's default VFS selection. On Windows,
/// restrict the built-in SQLite Win32 syscall table for this process as well.
/// No file is opened here.
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
/// On installation failure, terminate the dedicated process: policy callbacks
/// may already be partially installed, and an unguarded fallback is forbidden.
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
        #[cfg(windows)]
        // SAFETY: installation's exclusive fresh-process contract also covers
        // SQLite's shared Win32 syscall table; no other connection may use it.
        unsafe {
            windows_policy::install(original)?
        };
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
