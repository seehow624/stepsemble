//! Narrow OS boundary; see docs/native-history-reader.md for its trust limits.
use crate::{Capture, Error, Identity, Request, SOURCE_LIMIT};
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Root,
    Project,
    File,
    FirstRead,
    SecondRead,
}

fn io_error(error: io::Error) -> Error {
    match error.raw_os_error() {
        Some(libc::ENOENT) => Error::Missing,
        Some(libc::ENOTDIR | libc::ELOOP) => Error::NotRegular,
        Some(libc::EACCES | libc::EPERM) => Error::AccessDenied,
        _ => Error::Io,
    }
}

fn open_at(parent: i32, name: &str, directory: bool) -> Result<File, Error> {
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

fn close(file: File) -> Result<(), Error> {
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

fn root(path: &str) -> Result<File, Error> {
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
        if info.f_flags & libc::MNT_LOCAL as u32 == 0
            || ![b"apfs".as_slice(), b"hfs".as_slice()].contains(&name.as_slice())
        {
            return Err(Error::ContainmentUnavailable);
        }
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

fn check(file: &File, directory: bool, uid: u32) -> Result<Metadata, Error> {
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

fn same(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn budget(start: Instant) -> Result<(), Error> {
    if start.elapsed() >= Duration::from_secs(5) {
        Err(Error::Budget)
    } else {
        Ok(())
    }
}

fn read(file: &File, size: usize, start: Instant) -> Result<Vec<u8>, Error> {
    let mut out = vec![0; size];
    let mut offset = 0;
    while offset < size {
        budget(start)?;
        let end = size.min(offset + 65536);
        let count = file
            .read_at(&mut out[offset..end], offset as u64)
            .map_err(io_error)?;
        if count == 0 {
            return Err(Error::Changed);
        }
        offset += count;
    }
    let mut extra = [0_u8];
    if file.read_at(&mut extra, size as u64).map_err(io_error)? != 0 {
        return Err(Error::Changed);
    }
    budget(start)?;
    Ok(out)
}

pub fn capture(request: &Request) -> Result<Capture, Error> {
    capture_with(request, |_| {})
}

fn capture_with(request: &Request, mut hook: impl FnMut(Stage)) -> Result<Capture, Error> {
    let start = Instant::now();
    // SAFETY: geteuid takes no pointers and has no side effects.
    let uid = unsafe { libc::geteuid() };
    let root = root(&request.source.projects_root)?;
    let root_before = check(&root, true, uid)?;
    if root_before.dev().to_string() != request.expected_root.device
        || root_before.ino().to_string() != request.expected_root.inode
    {
        return Err(Error::RootIdentityChanged);
    }
    hook(Stage::Root);
    budget(start)?;
    let project = open_at(root.as_raw_fd(), &request.source.project_key, true)?;
    let project_before = check(&project, true, uid)?;
    if project_before.dev() != root_before.dev() {
        return Err(Error::ContainmentUnavailable);
    }
    hook(Stage::Project);
    budget(start)?;
    let name = format!("{}.jsonl", request.source.session_id);
    let file = open_at(project.as_raw_fd(), &name, false)?;
    let before = check(&file, false, uid)?;
    if before.dev() != root_before.dev() {
        return Err(Error::ContainmentUnavailable);
    }
    if before.size() == 0 {
        return Err(Error::Empty);
    }
    if before.size() > SOURCE_LIMIT as u64 {
        return Err(Error::TooLarge);
    }
    hook(Stage::File);
    let bytes = read(&file, before.size() as usize, start)?;
    hook(Stage::FirstRead);
    if !same(&before, &check(&file, false, uid)?) {
        return Err(Error::Changed);
    }
    let second = read(&file, before.size() as usize, start)?;
    hook(Stage::SecondRead);
    if bytes != second || !same(&before, &check(&file, false, uid)?) {
        return Err(Error::Changed);
    }
    drop(second);
    // Observe name->object edges again from held parent capabilities. A rename
    // later is still possible; this is not an atomic snapshot of the namespace.
    let current_file = open_at(project.as_raw_fd(), &name, false)?;
    let current_project = open_at(root.as_raw_fd(), &request.source.project_key, true)?;
    if !same(&before, &check(&current_file, false, uid)?)
        || !same(&project_before, &check(&current_project, true, uid)?)
        || !same(&project_before, &check(&project, true, uid)?)
        || !same(&root_before, &check(&root, true, uid)?)
    {
        return Err(Error::Changed);
    }
    budget(start)?;
    let identity = Identity {
        device: before.dev().to_string(),
        inode: before.ino().to_string(),
        size: before.size(),
        mtime_ns: (i128::from(before.mtime()) * 1_000_000_000 + i128::from(before.mtime_nsec()))
            .to_string(),
        ctime_ns: (i128::from(before.ctime()) * 1_000_000_000 + i128::from(before.ctime_nsec()))
            .to_string(),
    };
    let mut close_failed = false;
    for file in [current_file, current_project, file, project, root] {
        if close(file).is_err() {
            close_failed = true;
        }
    }
    if close_failed {
        return Err(Error::CloseFailed);
    }
    Ok(Capture { bytes, identity })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        project: PathBuf,
        file: PathBuf,
        request: Request,
    }
    impl Fixture {
        fn new(size: usize) -> Self {
            let temp = tempfile::tempdir().expect("owned temp");
            let root = fs::canonicalize(temp.path())
                .expect("temp canonical")
                .join("projects");
            let project = root.join("owned");
            fs::create_dir_all(&project).expect("owned dirs");
            for dir in [&root, &project] {
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).expect("owned mode");
            }
            let file = project.join("11111111-1111-1111-1111-111111111111.jsonl");
            fs::write(&file, vec![b'x'; size]).expect("owned source");
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("owned mode");
            let info = fs::metadata(&root).expect("root id");
            let request = Request {
                protocol_version: 1,
                nonce: "a".repeat(64),
                source: crate::Source {
                    projects_root: root.to_str().expect("temp utf8").into(),
                    project_key: "owned".into(),
                    session_id: "11111111-1111-1111-1111-111111111111".into(),
                },
                expected_root: crate::RootIdentity {
                    device: info.dev().to_string(),
                    inode: info.ino().to_string(),
                },
            };
            Self {
                _temp: temp,
                root,
                project,
                file,
                request,
            }
        }
        fn error(&self) -> Error {
            capture(&self.request).err().expect("must reject")
        }
    }
    #[test]
    fn bounded_exact_bytes_and_no_provenance_inference() {
        let f = Fixture::new(SOURCE_LIMIT);
        let result = capture(&f.request).expect("local no-ACL source");
        assert_eq!(result.bytes, vec![b'x'; SOURCE_LIMIT]);
        assert_eq!(result.identity.size, SOURCE_LIMIT as u64);
        // Same-UID pre-existing edits are not authenticated as native agent output.
        fs::write(&f.file, b"not a native transcript\n").expect("owned edit");
        assert_eq!(
            capture(&f.request).expect("raw not parser").bytes,
            b"not a native transcript\n"
        );
    }
    #[test]
    fn empty_oversize_root_and_permissions_reject() {
        assert_eq!(Fixture::new(0).error(), Error::Empty);
        assert_eq!(Fixture::new(SOURCE_LIMIT + 1).error(), Error::TooLarge);
        let mut f = Fixture::new(4);
        f.request.expected_root.inode = "1".into();
        assert_eq!(f.error(), Error::RootIdentityChanged);
        for component in 0..3 {
            let f = Fixture::new(4);
            let path = [&f.root, &f.project, &f.file][component];
            fs::set_permissions(path, fs::Permissions::from_mode(0o777)).expect("owned mode");
            assert_eq!(f.error(), Error::OwnerOrMode);
        }
    }

    #[test]
    fn source_timestamp_and_root_spelling_contract() {
        let mut f = Fixture::new(20);
        let file = File::open(&f.file).expect("owned file");
        file.set_times(
            fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH - Duration::from_secs(1)),
        )
        .expect("owned timestamp");
        assert_eq!(f.error(), Error::IdentityUnavailable);
        for root in [
            format!("{}/", f.root.display()),
            format!("{}/.", f.root.display()),
            format!("{}//projects", f._temp.path().display()),
        ] {
            f.request.source.projects_root = root;
            assert_eq!(f.error(), Error::Input);
        }
        let f = Fixture::new(20);
        let result = capture_with(&f.request, |at| {
            if at == Stage::File {
                fs::write(&f.file, vec![b'x'; 21]).expect("owned growth");
            }
        });
        assert_eq!(result.err(), Some(Error::Changed));
    }
    #[test]
    fn refuses_links_directories_and_fifo_without_blocking() {
        for component in 0..3 {
            let f = Fixture::new(4);
            let path = [&f.root, &f.project, &f.file][component];
            let replacement = path.with_extension("renamed");
            fs::rename(path, &replacement).expect("owned rename");
            symlink(&replacement, path).expect("owned link");
            assert_eq!(f.error(), Error::NotRegular);
        }
        let f = Fixture::new(4);
        fs::hard_link(&f.file, f.project.join("hardlink")).expect("owned hardlink");
        assert_eq!(f.error(), Error::Hardlinked);
        let f = Fixture::new(4);
        fs::remove_file(&f.file).expect("owned remove");
        fs::create_dir(&f.file).expect("owned directory");
        assert_eq!(f.error(), Error::NotRegular);
        let f = Fixture::new(4);
        fs::remove_file(&f.file).expect("owned remove");
        let path = CString::new(f.file.to_str().expect("temp utf8")).expect("temp path");
        // SAFETY: test-only owned temporary path is NUL terminated, no existing file.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert_eq!(f.error(), Error::NotRegular);
    }
    #[test]
    fn deterministic_race_barriers_reject_observed_changes() {
        for (stage, action) in [
            (Stage::Root, 0),
            (Stage::Project, 1),
            (Stage::File, 2),
            (Stage::FirstRead, 3),
            (Stage::FirstRead, 4),
            (Stage::SecondRead, 5),
        ] {
            let f = Fixture::new(20);
            let result = capture_with(&f.request, |at| {
                if at == stage {
                    match action {
                        0 => {
                            fs::rename(&f.root, f.root.with_extension("old")).expect("root rename");
                            fs::create_dir(&f.root).expect("replacement");
                        }
                        1 => {
                            fs::rename(&f.project, f.project.with_extension("old"))
                                .expect("project rename");
                            fs::create_dir(&f.project).expect("replacement");
                        }
                        2 => {
                            fs::rename(&f.file, f.file.with_extension("old")).expect("file rename");
                            fs::write(&f.file, b"outside sentinel").expect("replacement");
                        }
                        3 => fs::write(&f.file, vec![b'y'; 20]).expect("same-size edit"),
                        4 => fs::write(&f.file, b"short").expect("truncate"),
                        5 => fs::hard_link(&f.file, f.project.join("hardlink")).expect("new link"),
                        _ => unreachable!(),
                    }
                }
            });
            assert!(result.is_err(), "stage {stage:?}");
        }
    }
    #[cfg(target_os = "macos")]
    fn add_acl(path: &std::path::Path, _default: bool) {
        let result = std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone allow read"])
            .arg(path)
            .output()
            .expect("owned chmod ACL");
        assert!(result.status.success(), "owned ACL fixture creation failed");
    }
    #[cfg(target_os = "linux")]
    fn add_acl(path: &std::path::Path, default: bool) {
        let fd = File::open(path).expect("owned file");
        let mut bytes = 2_u32.to_le_bytes().to_vec();
        // POSIX ACL xattr version 2: owner, named user, group, mask, other.
        // SAFETY: geteuid has no parameters or pointers.
        let other_uid = unsafe { libc::geteuid() }.saturating_add(1);
        for (tag, perm, id) in [
            (1_u16, 7_u16, u32::MAX),
            (2, 4, other_uid),
            (4, 0, u32::MAX),
            (16, 4, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            bytes.extend(tag.to_le_bytes());
            bytes.extend(perm.to_le_bytes());
            bytes.extend(id.to_le_bytes());
        }
        let name = if default {
            c"system.posix_acl_default"
        } else {
            c"system.posix_acl_access"
        };
        // SAFETY: test-only owned fd, static attribute name and live bounded data buffer.
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    fd.as_raw_fd(),
                    name.as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                )
            },
            0,
            "ACL fixture must be exercised, not skipped"
        );
    }
    #[test]
    fn extended_acl_on_each_descriptor_and_read_race_rejects() {
        for component in 0..3 {
            let f = Fixture::new(20);
            add_acl([&f.root, &f.project, &f.file][component], false);
            assert_eq!(f.error(), Error::AclUnsupported);
        }
        let f = Fixture::new(20);
        let result = capture_with(&f.request, |at| {
            if at == Stage::FirstRead {
                add_acl(&f.file, false);
            }
        });
        assert_eq!(result.err(), Some(Error::AclUnsupported));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn directory_default_acl_rejects() {
        let f = Fixture::new(20);
        add_acl(&f.project, true);
        assert_eq!(f.error(), Error::AclUnsupported);
    }
}
