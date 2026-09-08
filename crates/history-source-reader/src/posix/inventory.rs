//! Bounded descriptor-relative enumeration. Metadata only, never transcript IO.
use super::*;
use crate::{
    DIRECTORY_ENTRIES, INVENTORY_ENTRIES, Inventory, InventoryEntry, InventoryRequest,
    PROJECTS_LIMIT,
};
use std::ffi::CStr;
use std::os::fd::IntoRawFd;

struct Directory(*mut libc::DIR);
impl Directory {
    fn new(parent: &File) -> Result<Self, Error> {
        // A fresh open file description gives each pass its own directory offset.
        // The internal literal dot is not a caller-controlled path component.
        let file = open_at(parent.as_raw_fd(), ".", true)?;
        let fd = file.as_raw_fd();
        // SAFETY: borrowed live directory fd. fdopendir owns it only on success.
        let dir = unsafe { libc::fdopendir(fd) };
        if dir.is_null() {
            return Err(io_error(io::Error::last_os_error()));
        }
        let _ = file.into_raw_fd();
        Ok(Self(dir))
    }
    fn next(&mut self) -> Result<Option<Vec<u8>>, Error> {
        // SAFETY: platform errno pointer is thread-local and valid on this thread.
        #[cfg(target_os = "macos")]
        let errno = unsafe { libc::__error() };
        // SAFETY: platform errno pointer is thread-local and valid on this thread.
        #[cfg(target_os = "linux")]
        let errno = unsafe { libc::__errno_location() };
        // SAFETY: DIR is exclusively owned and open. Copy d_name before another
        // readdir call invalidates its storage. POSIX guarantees NUL termination.
        unsafe {
            *errno = 0;
            let entry = libc::readdir(self.0);
            if entry.is_null() {
                return if *errno == 0 {
                    Ok(None)
                } else {
                    Err(io_error(io::Error::last_os_error()))
                };
            }
            Ok(Some(
                CStr::from_ptr((*entry).d_name.as_ptr()).to_bytes().to_vec(),
            ))
        }
    }
    fn finish(mut self) -> Result<(), Error> {
        let dir = std::mem::replace(&mut self.0, std::ptr::null_mut());
        // SAFETY: transfer the sole owned DIR exactly once, never retry close.
        if unsafe { libc::closedir(dir) } == 0 {
            Ok(())
        } else {
            Err(Error::CloseFailed)
        }
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: only error paths retain a live uniquely owned DIR.
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
}

fn identity(info: &Metadata) -> Identity {
    Identity {
        device: info.dev().to_string(),
        inode: info.ino().to_string(),
        size: info.size(),
        mtime_ns: (i128::from(info.mtime()) * 1_000_000_000 + i128::from(info.mtime_nsec()))
            .to_string(),
        ctime_ns: (i128::from(info.ctime()) * 1_000_000_000 + i128::from(info.ctime_nsec()))
            .to_string(),
    }
}

fn pass(root: &File, root_before: &Metadata, uid: u32, start: Instant) -> Result<Inventory, Error> {
    let mut inventory = Inventory {
        entries: Vec::new(),
        projects_scanned: 0,
        ignored_entries: 0,
    };
    let mut visited = 0;
    let mut count = || {
        budget(start)?;
        visited += 1;
        if visited > DIRECTORY_ENTRIES {
            Err(Error::InventoryLimit)
        } else {
            Ok(())
        }
    };
    let mut projects = Directory::new(root)?;
    while let Some(name) = projects.next()? {
        if name == b"." || name == b".." {
            continue;
        }
        count()?;
        let Ok(key) = std::str::from_utf8(&name) else {
            inventory.ignored_entries += 1;
            continue;
        };
        if !crate::project_key(key) {
            inventory.ignored_entries += 1;
            continue;
        }
        // Matching project names must be safe directories. Never traverse a
        // symlink or silently hide an unsafe candidate as a successful empty scan.
        let project = open_at(root.as_raw_fd(), key, true)?;
        let before = check(&project, true, uid)?;
        if before.dev() != root_before.dev() {
            return Err(Error::ContainmentUnavailable);
        }
        inventory.projects_scanned += 1;
        if inventory.projects_scanned > PROJECTS_LIMIT {
            return Err(Error::InventoryLimit);
        }
        let mut files = Directory::new(&project)?;
        while let Some(name) = files.next()? {
            if name == b"." || name == b".." {
                continue;
            }
            count()?;
            let id = std::str::from_utf8(&name)
                .ok()
                .and_then(|s| s.strip_suffix(".jsonl"))
                .filter(|s| crate::session_id(s));
            let Some(id) = id else {
                inventory.ignored_entries += 1;
                continue;
            };
            if inventory.entries.len() == INVENTORY_ENTRIES {
                return Err(Error::InventoryLimit);
            }
            let file = open_at(
                project.as_raw_fd(),
                std::str::from_utf8(&name).map_err(|_| Error::Input)?,
                false,
            )?;
            let info = check(&file, false, uid)?;
            if info.dev() != root_before.dev() {
                return Err(Error::ContainmentUnavailable);
            }
            inventory.entries.push(InventoryEntry {
                project_key: key.into(),
                session_id: id.into(),
                identity: identity(&info),
            });
            close(file)?;
        }
        files.finish()?;
        let named = open_at(root.as_raw_fd(), key, true)?;
        if !same(&before, &check(&project, true, uid)?)
            || !same(&before, &check(&named, true, uid)?)
        {
            return Err(Error::Changed);
        }
        close(named)?;
        close(project)?;
    }
    projects.finish()?;
    if !same(root_before, &check(root, true, uid)?) {
        return Err(Error::Changed);
    }
    inventory
        .entries
        .sort_by(|a, b| (&a.project_key, &a.session_id).cmp(&(&b.project_key, &b.session_id)));
    if inventory
        .entries
        .windows(2)
        .any(|v| v[0].project_key == v[1].project_key && v[0].session_id == v[1].session_id)
    {
        return Err(Error::Changed);
    }
    Ok(inventory)
}

pub fn inventory(request: &InventoryRequest) -> Result<Inventory, Error> {
    inventory_with(request, || {})
}
fn inventory_with(
    request: &InventoryRequest,
    mut between_passes: impl FnMut(),
) -> Result<Inventory, Error> {
    let start = Instant::now();
    // SAFETY: geteuid takes no pointers and has no side effects.
    let uid = unsafe { libc::geteuid() };
    let anchor = root(&request.projects_root)?;
    let before = check(&anchor, true, uid)?;
    if before.dev().to_string() != request.expected_root.device
        || before.ino().to_string() != request.expected_root.inode
    {
        return Err(Error::RootIdentityChanged);
    }
    let first = pass(&anchor, &before, uid, start)?;
    between_passes();
    let second = pass(&anchor, &before, uid, start)?;
    if first != second {
        return Err(Error::Changed);
    }
    let named = root(&request.projects_root)?;
    if !same(&before, &check(&anchor, true, uid)?) || !same(&before, &check(&named, true, uid)?) {
        return Err(Error::Changed);
    }
    close(named)?;
    close(anchor)?;
    budget(start)?;
    Ok(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    struct Fixture {
        temp: tempfile::TempDir,
        request: InventoryRequest,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("owned temp");
            let root = fs::canonicalize(temp.path())
                .expect("canonical")
                .join("projects");
            fs::create_dir(&root).expect("root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
            let meta = fs::metadata(&root).expect("meta");
            Self {
                temp,
                request: InventoryRequest {
                    protocol_version: 2,
                    nonce: "a".repeat(64),
                    projects_root: root.to_str().expect("path").into(),
                    expected_root: crate::RootIdentity {
                        device: meta.dev().to_string(),
                        inode: meta.ino().to_string(),
                    },
                },
            }
        }
        fn project(&self, key: &str) -> std::path::PathBuf {
            let p = std::path::Path::new(&self.request.projects_root).join(key);
            fs::create_dir(&p).expect("project");
            fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).expect("mode");
            p
        }
        fn file(&self, key: &str, n: usize) -> std::path::PathBuf {
            let p = std::path::Path::new(&self.request.projects_root)
                .join(key)
                .join(format!("{n:08x}-1111-4111-8111-111111111111.jsonl"));
            fs::write(&p, b"not parsed or read by inventory").expect("file");
            fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).expect("mode");
            p
        }
    }
    #[test]
    fn metadata_only_sorted_complete_empty_and_ignored_counts() {
        let f = Fixture::new();
        assert_eq!(inventory(&f.request).expect("empty").entries.len(), 0);
        let z = f.project("z");
        f.project("A");
        f.project("empty");
        let large = f.file("z", 2);
        let empty = f.file("A", 1);
        File::options()
            .write(true)
            .open(&large)
            .expect("owned")
            .set_len((crate::SOURCE_LIMIT + 1) as u64)
            .expect("sparse large fixture");
        fs::write(&empty, b"").expect("empty");
        fs::create_dir(z.join("subagents")).expect("excluded subagents");
        fs::write(z.join("sessions-index.json"), b"not followed").expect("metadata");
        fs::write(
            std::path::Path::new(&f.request.projects_root).join(".DS_Store"),
            b"ignored",
        )
        .expect("ignored");
        let r = inventory(&f.request).expect("inventory");
        assert_eq!(r.projects_scanned, 3);
        assert_eq!(r.ignored_entries, 3);
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].project_key, "A");
        assert_eq!(r.entries[0].identity.size, 0);
        assert_eq!(r.entries[1].identity.size, (crate::SOURCE_LIMIT + 1) as u64);
    }
    #[test]
    fn every_scan_is_bounded_without_successful_truncation() {
        let f = Fixture::new();
        f.project("owned");
        for n in 0..INVENTORY_ENTRIES {
            f.file("owned", n);
        }
        assert_eq!(
            inventory(&f.request).expect("exact limit").entries.len(),
            INVENTORY_ENTRIES
        );
        f.file("owned", INVENTORY_ENTRIES);
        assert_eq!(inventory(&f.request).err(), Some(Error::InventoryLimit));
        let f = Fixture::new();
        for n in 0..=PROJECTS_LIMIT {
            f.project(&format!("p{n}"));
        }
        assert_eq!(inventory(&f.request).err(), Some(Error::InventoryLimit));
        let f = Fixture::new();
        for n in 0..=DIRECTORY_ENTRIES {
            fs::write(
                std::path::Path::new(&f.request.projects_root).join(format!(".{n}")),
                b"",
            )
            .expect("ignored fixture");
        }
        assert_eq!(inventory(&f.request).err(), Some(Error::InventoryLimit));
    }
    #[test]
    fn directory_and_file_candidates_never_follow_links_or_hide_unsafe_modes() {
        for which in 0..3 {
            let f = Fixture::new();
            let project = f.project("owned");
            let file = f.file("owned", 1);
            let root = std::path::PathBuf::from(&f.request.projects_root);
            let p = [&root, &project, &file][which];
            let renamed = p.with_extension("backup");
            fs::rename(p, &renamed).expect("rename");
            symlink(&renamed, p).expect("link");
            assert_eq!(inventory(&f.request).err(), Some(Error::NotRegular));
        }
        for which in 0..3 {
            let f = Fixture::new();
            let project = f.project("owned");
            let file = f.file("owned", 1);
            let root = std::path::PathBuf::from(&f.request.projects_root);
            fs::set_permissions(
                [&root, &project, &file][which],
                fs::Permissions::from_mode(0o777),
            )
            .expect("mode");
            assert_eq!(inventory(&f.request).err(), Some(Error::OwnerOrMode));
        }
        let f = Fixture::new();
        f.project("owned");
        let file = f.file("owned", 1);
        fs::hard_link(&file, f.temp.path().join("hardlink")).expect("hardlink");
        assert_eq!(inventory(&f.request).err(), Some(Error::Hardlinked));
        let f = Fixture::new();
        f.project("owned");
        let file = f.file("owned", 1);
        fs::remove_file(&file).expect("remove");
        let name = CString::new(file.to_str().expect("path")).expect("cstr");
        // SAFETY: test-only unoccupied owned path, no outside targets.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(inventory(&f.request).err(), Some(Error::NotRegular));
    }
    #[test]
    fn changes_between_passes_and_root_replacement_never_publish_old_inventory() {
        for action in 0..4 {
            let f = Fixture::new();
            let project = f.project("owned");
            let file = f.file("owned", 1);
            let result = inventory_with(&f.request, || match action {
                0 => {
                    f.file("owned", 2);
                }
                1 => fs::remove_file(&file).expect("delete"),
                2 => fs::write(&file, b"changed metadata").expect("edit"),
                _ => {
                    fs::rename(&project, project.with_extension("old")).expect("rename");
                    f.project("owned");
                }
            });
            assert_eq!(result.err(), Some(Error::Changed));
        }
        let f = Fixture::new();
        let result = inventory_with(&f.request, || {
            fs::rename(&f.request.projects_root, f.temp.path().join("old")).expect("root rename");
            fs::create_dir(&f.request.projects_root).expect("replacement");
        });
        assert_eq!(result.err(), Some(Error::Changed));
    }
    #[test]
    fn acl_and_expected_root_policy_apply_before_inventory_publication() {
        for which in 0..3 {
            let mut f = Fixture::new();
            let project = f.project("owned");
            let file = f.file("owned", 1);
            f.request.expected_root.inode = "1".into();
            assert_eq!(
                inventory(&f.request).err(),
                Some(Error::RootIdentityChanged)
            );
            f.request.expected_root.inode = fs::metadata(&f.request.projects_root)
                .expect("root")
                .ino()
                .to_string();
            let root = std::path::PathBuf::from(&f.request.projects_root);
            // Use the same platform fixture exercised by the capture policy tests.
            super::super::tests::add_acl([&root, &project, &file][which], false);
            assert_eq!(inventory(&f.request).err(), Some(Error::AclUnsupported));
        }
    }
}
