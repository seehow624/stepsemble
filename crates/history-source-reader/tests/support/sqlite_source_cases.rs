//! Owned actual source-boundary cases; never consult private native homes.
use super::*;

fn request(f: &Fixture) -> Value {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        let info = std::fs::metadata(f.path.parent().unwrap()).unwrap();
        (info.dev().to_string(), info.ino().to_string())
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let (device, inode) = ("1".to_owned(), "1".to_owned());
    let root = f.path.parent().unwrap().to_str().unwrap();
    // canonicalize uses the extended Windows spelling. The v4 contract rejects
    // wildcard/question-mark paths; test the same owned directory using its
    // ordinary absolute spelling, not a broadened production input contract.
    #[cfg(windows)]
    let root = root.strip_prefix(r"\\?\").unwrap_or(root);
    json!({"protocolVersion":4,"nonce":"a".repeat(64),"nativeVersion":"0.153.4",
        "source":{"sqliteRoot":root,"threadId":ID},
        "expectedRoot":{"device":device,"inode":inode}})
}
fn frame(f: &Fixture, request: Value) -> Value {
    let version = request["protocolVersion"].clone();
    let mut child = Worker::start_request(&f.path, "frame", Some(request));
    let reply = child.line();
    child.finish(false);
    assert_eq!(reply["header"]["protocolVersion"], version);
    assert_eq!(reply["header"]["nonce"], "a".repeat(64));
    reply
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unavailable(reply: &Value, code: &str) {
    assert_eq!(reply, &json!({"error":code}), "no fields on refusal");
}

pub(super) fn run() {
    let before_spawn = SPAWNED.load(Ordering::Relaxed);
    let before_reap = REAPED.load(Ordering::Relaxed);
    let before_dirs = CLOSED_FIXTURES.load(Ordering::Relaxed);
    let before_snapshot = SNAPSHOT_CHILDREN.load(Ordering::Relaxed);
    let mut cases = Vec::<String>::new();
    let f = Fixture::named("sqlite root 🐾 #%/state_5.sqlite");
    let before = f.snapshot();
    let reply = frame(&f, request(&f));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        expect_title(&reply["body"], "latest");
        assert_eq!(reply["header"]["result"]["kind"], "native_sqlite_metadata");
        assert_eq!(reply["body"]["sqliteDescriptorsClosed"], 3);
        assert!(reply["body"]["shmMappingsClosed"].as_u64().unwrap() > 0);
        assert_eq!(
            reply["header"]["result"]["expectedRoot"],
            request(&f)["expectedRoot"]
        );
        let mut wrong = request(&f);
        wrong["expectedRoot"]["inode"] = json!("18446744073709551615");
        let reply = frame(&f, wrong);
        assert_eq!(reply["body"], Value::Null);
        assert_eq!(
            reply["header"]["result"],
            json!({"kind":"source_unavailable","code":"source_root_identity_changed"})
        );
        cases.push("actual_v4_wrong_root_zero_payload".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        assert_eq!(reply["body"], Value::Null);
        assert_eq!(
            reply["header"]["result"],
            json!({"kind":"source_unavailable","code":"source_platform_unsupported"})
        );
    }
    assert!(f.snapshot() == before);
    let mut v5 = request(&f);
    v5["protocolVersion"] = json!(5);
    let context = frame(&f, v5.clone());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        expect_title(&context["body"], "latest");
        assert_eq!(
            context["header"]["result"]["kind"],
            "native_sqlite_name_context"
        );
        assert_eq!(
            context["body"]["observation"]["nameContext"],
            json!({"rolloutPath":"owned","preview":""})
        );
        assert!(context["body"]["shmMappingsClosed"].as_u64().unwrap() > 0);
        v5["expectedRoot"]["inode"] = json!("18446744073709551615");
        let rejected = frame(&f, v5);
        assert_eq!(rejected["body"], Value::Null);
        assert_eq!(
            rejected["header"]["result"]["code"],
            "source_root_identity_changed"
        );
        cases.push("actual_v5_wrong_root_zero_fields".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        assert_eq!(context["body"], Value::Null);
        assert_eq!(
            context["header"]["result"]["code"],
            "source_platform_unsupported"
        );
    }
    assert!(f.snapshot() == before);
    cases.push("actual_v5_context_frame_and_platform_boundary".into());
    let mut v6 = request(&f);
    v6["protocolVersion"] = json!(6);
    v6["source"].as_object_mut().unwrap().remove("threadId");
    let catalog = frame(&f, v6.clone());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        assert_eq!(catalog["header"]["result"]["kind"], "native_sqlite_catalog");
        assert!(catalog["header"]["result"].get("threadId").is_none());
        let observation = &catalog["body"]["observation"];
        assert_eq!(observation["kind"], "codex_sqlite_catalog_observation");
        assert_eq!(observation["entries"].as_array().unwrap().len(), 1);
        assert_eq!(observation["entries"][0]["id"], ID);
        assert_eq!(observation["entries"][0]["rolloutPath"], "owned");
        assert!(observation["entries"][0].get("title").is_none());
        assert_eq!(catalog["body"]["sourceDescriptorsClosed"], 4);
        assert_eq!(catalog["body"]["sqliteDescriptorsClosed"], 3);
        assert!(catalog["body"]["shmMappingsClosed"].as_u64().unwrap() > 0);
        v6["expectedRoot"]["inode"] = json!("18446744073709551615");
        let rejected = frame(&f, v6);
        assert_eq!(rejected["body"], Value::Null);
        assert_eq!(
            rejected["header"]["result"]["code"],
            "source_root_identity_changed"
        );
        cases.push("actual_v6_wrong_root_zero_entries".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        assert_eq!(catalog["body"], Value::Null);
        assert_eq!(
            catalog["header"]["result"]["code"],
            "source_platform_unsupported"
        );
    }
    assert!(f.snapshot() == before);
    cases.push("actual_v6_catalog_frame_and_platform_boundary".into());
    drop(f);
    cases.push("actual_v4_frame_nonce_digest_and_platform_boundary".into());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    posix(&mut cases);
    let children = SPAWNED.load(Ordering::Relaxed) - before_spawn;
    assert_eq!(children, REAPED.load(Ordering::Relaxed) - before_reap);
    println!(
        "{}",
        json!({"kind":"owned_sqlite_source_adversarial_gate","platform":std::env::consts::OS,
        "cases":cases,"spawnedChildren":children,"reapedChildren":children,"remainingChildren":0,
        "snapshotChildren":SNAPSHOT_CHILDREN.load(Ordering::Relaxed)-before_snapshot,
        "removedOwnedFixtureDirectories":CLOSED_FIXTURES.load(Ordering::Relaxed)-before_dirs,
        "privateHistoryReads":0,"modelCalls":0,"hostWebConnected":false})
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn posix(cases: &mut Vec<String>) {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let new = || Fixture::named("sqlite-root/state_5.sqlite");
    let closed = || {
        let mut f = new();
        f.close_writer(true);
        f
    };
    let role = |f: &Fixture, i: usize| -> PathBuf {
        match i {
            0 => f.path.parent().unwrap().into(),
            1 => f.path.clone(),
            2 => f.sidecar("-wal"),
            3 => f.sidecar("-shm"),
            _ => unreachable!(),
        }
    };
    let f = new();
    unavailable(&f.capture("bound_cancel"), "source_cancelled");
    cases.push("cancel_before_open".into());
    drop(f);

    for i in 1..=3 {
        let f = closed();
        std::fs::remove_file(role(&f, i)).unwrap();
        let before = f.snapshot();
        unavailable(&f.capture("bound"), "source_missing");
        assert!(f.snapshot() == before);
        cases.push(format!("missing_role_{i}_no_create"));
    }
    for i in 0..=3 {
        for stage in ["before", "prepared", "read"] {
            for operation in ["mode", "acl"] {
                let f = closed();
                let selected = role(&f, i);
                let mut worker = if stage == "before" {
                    None
                } else {
                    let w = Worker::start(&f.path, &format!("bound_{stage}"));
                    assert_eq!(w.line(), json!({"ready":stage}));
                    Some(w)
                };
                if operation == "mode" {
                    std::fs::set_permissions(&selected, std::fs::Permissions::from_mode(0o777))
                        .unwrap();
                } else {
                    add_acl(&selected);
                }
                let reply = if let Some(w) = worker.as_mut() {
                    w.input.as_mut().unwrap().write_all(b"finish\n").unwrap();
                    let reply = w.line();
                    w.finish(false);
                    reply
                } else {
                    f.capture("bound")
                };
                unavailable(
                    &reply,
                    if operation == "mode" {
                        "source_owner_or_mode"
                    } else {
                        "source_acl_unsupported"
                    },
                );
                cases.push(format!("{operation}_role_{i}_{stage}_no_fields"));
            }
        }
    }
    for i in 1..=3 {
        for operation in ["symlink", "hardlink", "directory", "fifo"] {
            let f = closed();
            let selected = role(&f, i);
            let backup = selected.with_extension("held-original");
            if operation == "hardlink" {
                std::fs::hard_link(&selected, &backup).unwrap();
            } else {
                std::fs::rename(&selected, &backup).unwrap();
                match operation {
                    "symlink" => symlink(&backup, &selected).unwrap(),
                    "directory" => std::fs::create_dir(&selected).unwrap(),
                    "fifo" => {
                        use std::os::unix::ffi::OsStrExt;
                        let name = std::ffi::CString::new(selected.as_os_str().as_bytes()).unwrap();
                        // SAFETY: live NUL-terminated owned fixture path, no reader/writer opens yet.
                        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                    }
                    _ => unreachable!(),
                }
            }
            unavailable(
                &f.capture("bound"),
                if operation == "hardlink" {
                    "source_hardlinked"
                } else {
                    "source_not_regular_or_linked"
                },
            );
            cases.push(format!("{operation}_role_{i}_no_follow_no_block"));
        }
    }
    for i in 0..=3 {
        for stage in ["prepared", "read"] {
            let f = closed();
            let selected = role(&f, i);
            let mut w = Worker::start(&f.path, &format!("bound_{stage}"));
            assert_eq!(w.line(), json!({"ready":stage}));
            let backup = selected.with_extension("held-original");
            std::fs::rename(&selected, &backup).unwrap();
            if i == 0 {
                std::fs::create_dir(&selected).unwrap();
            } else {
                std::fs::File::create(&selected).unwrap();
            }
            w.input.as_mut().unwrap().write_all(b"finish\n").unwrap();
            unavailable(
                &w.line(),
                if i == 0 {
                    "source_root_identity_changed"
                } else {
                    "source_changed"
                },
            );
            w.finish(false);
            cases.push(format!("replace_role_{i}_{stage}_no_fields"));
        }
    }
    let f = closed();
    std::fs::File::create(f.sidecar("-journal")).unwrap();
    unavailable(&f.capture("bound"), "source_database_unsupported");
    cases.push("rollback_journal_presence_no_repair".into());
    drop(f);

    let f = new();
    let mut w = Worker::start(&f.path, "bound_read");
    assert_eq!(w.line(), json!({"ready":"read"}));
    f.update("later-commit");
    assert_eq!(
        f.checkpoint(),
        0,
        "reader has really closed before final publication check"
    );
    w.input.as_mut().unwrap().write_all(b"finish\n").unwrap();
    expect_title(&w.line(), "latest");
    w.finish(false);
    expect_title(&f.capture("bound"), "later-commit");
    cases
        .push("legitimate_commit_after_read_preserves_captured_snapshot_and_releases_locks".into());
    drop(f);
    let f = new();
    f.update(&"a".repeat(32 * 1024 + 1));
    unavailable(&f.capture("bound"), "source_too_large");
    cases.push("oversize_selected_field_no_truncation".into());
}

#[cfg(target_os = "macos")]
fn add_acl(path: &Path) {
    let output = Command::new("/bin/chmod")
        .args(["+a", "everyone allow read"])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "owned ACL creation must not be skipped"
    );
}
#[cfg(target_os = "linux")]
fn add_acl(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let mut bytes = 2_u32.to_le_bytes().to_vec();
    // SAFETY: geteuid has no pointer arguments or side effects.
    let other = unsafe { libc::geteuid() }.saturating_add(1);
    for (tag, perm, id) in [
        (1_u16, 7_u16, u32::MAX),
        (2, 4, other),
        (4, 0, u32::MAX),
        (16, 4, u32::MAX),
        (32, 0, u32::MAX),
    ] {
        bytes.extend(tag.to_le_bytes());
        bytes.extend(perm.to_le_bytes());
        bytes.extend(id.to_le_bytes());
    }
    assert_eq!(
        // SAFETY: fixed ACL version/entries, live bounded buffer and owned path.
        // Path-based setxattr opens/closes no writer-process DB descriptor.
        unsafe {
            libc::setxattr(
                path.as_ptr(),
                c"system.posix_acl_access".as_ptr(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
            )
        },
        0,
        "owned ACL creation must not be skipped"
    );
}
