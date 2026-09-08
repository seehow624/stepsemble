//! Narrow OS boundary; see docs/native-history-reader.md for its trust limits.
use crate::{Capture, Error, Identity, Request, SOURCE_LIMIT};
#[cfg(test)]
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::time::{Duration, Instant};
pub mod codex;
pub mod inventory;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Root,
    Project,
    File,
    FirstRead,
    SecondRead,
}

#[cfg(all(target_os = "macos", test))]
use stepsemble_history_source_reader::source_filesystem::macos_mount_policy;
use stepsemble_history_source_reader::source_filesystem::{check, close, io_error, open_at, root};

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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_mount_policy_requires_local_supported_and_enforced_ownership() {
        let local = libc::MNT_LOCAL as u32;
        let noowners = libc::MNT_IGNORE_OWNERSHIP as u32;
        for filesystem in [b"apfs".as_slice(), b"hfs".as_slice()] {
            assert_eq!(macos_mount_policy(local, filesystem), Ok(()));
            assert_eq!(
                macos_mount_policy(local | libc::MNT_RDONLY as u32, filesystem),
                Ok(())
            );
            for flags in [0, noowners, local | noowners, u32::MAX] {
                assert_eq!(
                    macos_mount_policy(flags, filesystem),
                    Err(Error::ContainmentUnavailable)
                );
            }
        }
        for filesystem in [b"".as_slice(), b"nfs", b"smbfs", b"APFS", b"apfs\0"] {
            assert_eq!(
                macos_mount_policy(local, filesystem),
                Err(Error::ContainmentUnavailable)
            );
        }
    }

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
    pub(super) fn add_acl(path: &std::path::Path, _default: bool) {
        let result = std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone allow read"])
            .arg(path)
            .output()
            .expect("owned chmod ACL");
        assert!(result.status.success(), "owned ACL fixture creation failed");
    }
    #[cfg(target_os = "linux")]
    pub(super) fn add_acl(path: &std::path::Path, default: bool) {
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
        assert_eq!(
            // SAFETY: test-only owned fd, static attribute name and live bounded data buffer.
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
