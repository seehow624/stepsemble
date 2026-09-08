//! Shared descriptor-only POSIX checks used by text and SQLite source readers.
//! These primitives do not grant a path or authorize a Web reader by themselves.
use crate::source_error::Error;
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::fs::MetadataExt;

pub fn io_error(error: io::Error) -> Error {
    match error.raw_os_error() {
        Some(libc::ENOENT) => Error::Missing,
        Some(libc::ENOTDIR | libc::ELOOP) => Error::NotRegular,
        Some(libc::EACCES | libc::EPERM) => Error::AccessDenied,
        _ => Error::Io,
    }
}

pub fn open_at(parent: i32, name: &str, directory: bool) -> Result<File, Error> {
    let name = CString::new(name).map_err(|_| Error::Input)?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | libc::O_NOCTTY
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: name is a live NUL-terminated string, parent is a borrowed live fd
    // (or AT_FDCWD); no create flag, so no variadic mode argument is consumed.
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io_error(io::Error::last_os_error()));
    }
    // SAFETY: openat returned a fresh owned descriptor. File assumes ownership once.
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub fn close(file: File) -> Result<(), Error> {
    // Transfer ownership before calling close. Never retry a failed close: the
    // descriptor may already have been released and reassigned by the kernel.
    let fd = file.into_raw_fd();
    // SAFETY: fd was owned by file, which no longer closes it on drop.
    if unsafe { libc::close(fd) } == 0 {
        Ok(())
    } else {
        Err(Error::CloseFailed)
    }
}

pub fn root(path: &str) -> Result<File, Error> {
    if !path.starts_with('/') || path == "/" || path.ends_with('/') {
        return Err(Error::Input);
    }
    let parts: Vec<_> = path[1..].split('/').collect();
    if parts.len() > 256
        || parts
            .iter()
            .any(|v| v.is_empty() || *v == "." || *v == "..")
    {
        return Err(Error::Input);
    }
    let mut current = open_at(libc::AT_FDCWD, "/", true)?;
    for part in parts {
        let child = open_at(current.as_raw_fd(), part, true)?;
        close(current)?;
        current = child;
    }
    Ok(current)
}

#[cfg(target_os = "macos")]
pub fn macos_mount_policy(flags: u32, filesystem: &[u8]) -> Result<(), Error> {
    // SDK sys/mount.h: IGNORE_OWNERSHIP means VFS ignores object ownership.
    // mount(8) noowners maps the apparent owner to the current effective UID;
    // observing uid == euid and owner-only modes does not establish UID isolation.
    if flags & libc::MNT_LOCAL as u32 == 0
        || flags & libc::MNT_IGNORE_OWNERSHIP as u32 != 0
        || ![b"apfs".as_slice(), b"hfs".as_slice()].contains(&filesystem)
    {
        return Err(Error::ContainmentUnavailable);
    }
    Ok(())
}

fn local_filesystem(file: &File) -> Result<(), Error> {
    let mut info = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: a valid borrowed fd and correctly sized writable statfs storage.
    if unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
        return Err(Error::ContainmentUnavailable);
    }
    // SAFETY: successful fstatfs initialized the complete struct.
    let info = unsafe { info.assume_init() };
    #[cfg(target_os = "macos")]
    {
        let name: Vec<u8> = info
            .f_fstypename
            .iter()
            .take_while(|v| **v != 0)
            .map(|v| *v as u8)
            .collect();
        macos_mount_policy(info.f_flags, &name)?;
    }
    #[cfg(target_os = "linux")]
    {
        // EXT4's magic is shared by ext2/3/4; do not claim a distinct ext version.
        if ![
            libc::EXT4_SUPER_MAGIC,
            libc::XFS_SUPER_MAGIC,
            libc::BTRFS_SUPER_MAGIC,
            libc::TMPFS_MAGIC,
        ]
        .contains(&info.f_type)
        {
            return Err(Error::ContainmentUnavailable);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn acl(file: &File, _directory: bool) -> Result<(), Error> {
    // acl_get_fd_np returns NULL both on error and absent FILESEC_ACL. Use the
    // documented file-security object API instead of guessing absence from errno.
    // SDK sys/unistd.h: _PC_EXTENDED_SECURITY_NP=13; sys/fcntl.h: FILESEC_ACL=5.
    unsafe extern "C" {
        fn filesec_init() -> *mut libc::c_void;
        fn filesec_free(value: *mut libc::c_void);
        fn filesec_query_property(
            value: *mut libc::c_void,
            property: libc::c_int,
            valid: *mut libc::c_int,
        ) -> libc::c_int;
        #[cfg_attr(not(target_arch = "aarch64"), link_name = "fstatx_np$INODE64")]
        fn fstatx_np(
            fd: libc::c_int,
            info: *mut libc::stat,
            value: *mut libc::c_void,
        ) -> libc::c_int;
    }
    // SAFETY: live borrowed fd and the documented query constant. A filesystem
    // without extended security can also report no ACL; that is not accepted.
    if unsafe { libc::fpathconf(file.as_raw_fd(), 13) } != 1 {
        return Err(Error::AclUnavailable);
    }
    // SAFETY: no inputs; allocation is returned by the system library.
    let value = unsafe { filesec_init() };
    if value.is_null() {
        return Err(Error::AclUnavailable);
    }
    let mut info = MaybeUninit::<libc::stat>::uninit();
    let mut present: libc::c_int = -1;
    // SAFETY: live fd, allocated filesec object, correctly sized writable stat.
    let status = unsafe { fstatx_np(file.as_raw_fd(), info.as_mut_ptr(), value) };
    let query = if status == 0 {
        // SAFETY: successful fstatx populated value; present is writable c_int.
        unsafe { filesec_query_property(value, 5, &mut present) }
    } else {
        -1
    };
    // SAFETY: exactly one free; no subsequent dereference and no owned aliases.
    unsafe { filesec_free(value) };
    if status != 0 || query != 0 {
        return Err(Error::AclUnavailable);
    }
    // filesec_query_property returns the validity bitmask, not necessarily 1.
    match present {
        0 => Ok(()),
        1.. => Err(Error::AclUnsupported),
        _ => Err(Error::AclUnavailable),
    }
}

#[cfg(target_os = "linux")]
fn acl(file: &File, directory: bool) -> Result<(), Error> {
    for name in [c"system.posix_acl_access", c"system.posix_acl_default"]
        .into_iter()
        .take(if directory { 2 } else { 1 })
    {
        // SAFETY: live fd and static NUL-terminated name; null buffer with size=0
        // queries only length. Never allocate untrusted ACL data or treat ENOTSUP as absent.
        let size =
            unsafe { libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0) };
        if size >= 0 {
            return Err(Error::AclUnsupported);
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::ENODATA) {
            return Err(Error::AclUnavailable);
        }
    }
    Ok(())
}

pub fn check(file: &File, directory: bool, uid: u32) -> Result<Metadata, Error> {
    let info = file.metadata().map_err(io_error)?;
    if !directory
        && (info.mtime() < 0
            || info.ctime() < 0
            || !(0..1_000_000_000).contains(&info.mtime_nsec())
            || !(0..1_000_000_000).contains(&info.ctime_nsec()))
    {
        return Err(Error::IdentityUnavailable);
    }
    if (directory && !info.is_dir()) || (!directory && !info.is_file()) {
        return Err(Error::NotRegular);
    }
    if info.uid() != uid || info.mode() & 0o022 != 0 {
        return Err(Error::OwnerOrMode);
    }
    if !directory && info.nlink() != 1 {
        return Err(Error::Hardlinked);
    }
    if info.ino() == 0 {
        return Err(Error::ContainmentUnavailable);
    }
    local_filesystem(file)?;
    acl(file, directory)?;
    Ok(info)
}
