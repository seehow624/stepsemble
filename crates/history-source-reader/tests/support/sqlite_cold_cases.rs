//! Cold copy/lock evidence is distinct from the existing hot WAL/SHM gate.
use super::*;

pub(super) fn child(request: Request, input: &mut BufReader<std::io::Stdin>) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::fs::MetadataExt;
        use stepsemble_history_source_reader::sqlite_source::{RootSelection, cold};
        let root = request.path.parent().unwrap();
        let info = std::fs::metadata(root).unwrap();
        let selection = RootSelection {
            root_path: root.to_str().unwrap().into(),
            expected_device: info.dev(),
            expected_inode: info.ino(),
            native_version: "0.153.4".into(),
        };
        let result = (|| {
            // SAFETY: fresh owned-fixture child, no other source descriptors,
            // connections or POSIX locks; the parent owns the separate writer.
            let prepared = unsafe {
                cold::prepare(
                    selection,
                    Arc::new(AtomicBool::new(request.mode == "cold_cancel")),
                )
            }?;
            let mut wait = |stage| {
                send(json!({"ready":stage}));
                let mut line = Vec::new();
                input.by_ref().take(8).read_until(b'\n', &mut line).unwrap();
                assert_eq!(line, b"finish\n");
            };
            if request.mode == "cold_prepared" {
                wait("prepared");
            }
            if request.mode == "cold_catalog" {
                return prepared
                    .read_catalog()
                    .finish()
                    .map(|v| serde_json::to_value(v).unwrap());
            }
            let pending = prepared.read_name_context(ID);
            if request.mode == "cold_read" {
                wait("read");
            }
            pending.finish().map(|v| serde_json::to_value(v).unwrap())
        })();
        send(result.unwrap_or_else(|error| json!({"error":error.code()})));
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (request, input);
        send(json!({"error":"source_platform_unsupported"}));
    }
}

pub(super) fn run() {
    let spawned = SPAWNED.load(Ordering::Relaxed);
    let reaped = REAPED.load(Ordering::Relaxed);
    let dirs = CLOSED_FIXTURES.load(Ordering::Relaxed);
    let mut cases = Vec::new();
    let mut f = Fixture::named("cold-root/state_5.sqlite");
    f.close_writer(false);
    let before = f.snapshot();
    assert_eq!(before.len(), 1);
    let reply = f.capture("cold");
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        expect_title(&reply, "latest");
        assert_eq!(reply["sourceLayout"], "cold_snapshot");
        assert_eq!(reply["identities"].as_array().unwrap().len(), 1);
        assert_eq!(reply["sourceDescriptorsClosed"], 2);
        assert_eq!(reply["snapshotStorage"], "private_readonly_memory");
        assert_eq!(reply["sourceMainSharedLock"], true);
        assert_eq!(reply["absentSidecarsVerified"], true);
        assert_eq!(reply["snapshotBytes"], before["state_5.sqlite"].bytes);
        let catalog = f.capture("cold_catalog");
        assert_eq!(catalog["observation"]["entries"][0]["id"], ID, "{catalog}");
        assert_eq!(
            catalog["observation"]["entries"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            f.capture("cold_cancel"),
            json!({"error":"source_cancelled"})
        );
        cases.push("cold_name_context_catalog_exact_bytes_and_names_unchanged");
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        assert_eq!(reply, json!({"error":"source_platform_unsupported"}));
        cases.push("cold_source_platform_explicit_unsupported");
    }
    assert!(f.snapshot() == before);
    drop(f);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    posix(&mut cases);
    let children = SPAWNED.load(Ordering::Relaxed) - spawned;
    assert_eq!(children, REAPED.load(Ordering::Relaxed) - reaped);
    println!(
        "{}",
        json!({"kind":"owned_sqlite_cold_snapshot_gate", "platform":std::env::consts::OS, "cases":cases,
        "spawnedChildren":children,"reapedChildren":children,"remainingChildren":0,
        "removedOwnedFixtureDirectories":CLOSED_FIXTURES.load(Ordering::Relaxed)-dirs,
        "privateHistoryReads":0,"modelCalls":0,"hostWebConnected":false})
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn posix(cases: &mut Vec<&str>) {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let cold = || {
        let mut f = Fixture::named("cold-root/state_5.sqlite");
        f.close_writer(false);
        f
    };
    for phase in ["cold_prepared", "cold_read"] {
        // A compliant native writer may reopen and commit under the shared
        // main-file lock, but cannot delete its WAL when closing. The final
        // absence fence MUST reject, never publish the older cold copy.
        let mut f = cold();
        let mut reader = Worker::start(&f.path, phase);
        assert_eq!(
            reader.line()["ready"],
            if phase == "cold_read" {
                "read"
            } else {
                "prepared"
            }
        );
        f.writer = Some(Connection::open(&f.path).unwrap());
        f.writer().busy_timeout(Duration::ZERO).unwrap();
        f.update("reopened");
        f.close_writer(false);
        assert!(
            f.sidecar("-wal").exists(),
            "main SHARED lock prevents native WAL deletion"
        );
        reader
            .input
            .as_mut()
            .unwrap()
            .write_all(b"finish\n")
            .unwrap();
        reader.input.as_mut().unwrap().flush().unwrap();
        assert_eq!(reader.line(), json!({"error":"source_changed"}));
        reader.finish(false);
        // Once the cold reader really exits, native close can remove sidecars.
        let writer = Connection::open(&f.path).unwrap();
        writer
            .query_row("SELECT title FROM threads WHERE id=?1", [ID], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        writer.close().unwrap();
        assert!(!f.sidecar("-wal").exists());
        expect_title(&f.capture("cold"), "reopened");
    }
    cases.push("native_reopen_commit_close_cannot_hide_wal_before_or_after_copy");
    for suffix in ["-wal", "-shm", "-journal"] {
        let f = cold();
        std::fs::write(f.sidecar(suffix), b"owned-invalid-sidecar").unwrap();
        let before = f.snapshot();
        let reply = f.capture("cold");
        assert_eq!(
            reply,
            json!({"error":if suffix == "-journal" {"source_database_unsupported"} else {"source_changed"}})
        );
        assert!(f.snapshot() == before);
    }
    cases.push("partial_or_rollback_sidecars_never_repaired_or_ignored");
    for phase in ["cold_prepared", "cold_read"] {
        let f = cold();
        let mut reader = Worker::start(&f.path, phase);
        reader.line();
        std::fs::set_permissions(&f.path, std::fs::Permissions::from_mode(0o666)).unwrap();
        reader
            .input
            .as_mut()
            .unwrap()
            .write_all(b"finish\n")
            .unwrap();
        reader.input.as_mut().unwrap().flush().unwrap();
        assert_eq!(reader.line(), json!({"error":"source_owner_or_mode"}));
        reader.finish(false);
        std::fs::set_permissions(&f.path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    cases.push("source_revocation_before_copy_or_publication_drops_all_fields");
    for phase in ["cold_prepared", "cold_read"] {
        let f = cold();
        let mut reader = Worker::start(&f.path, phase);
        reader.line();
        // A non-SQLite writer does not obey advisory locks. Observe changes to
        // the held main file itself as well as the presence of native sidecars.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&f.path)
            .unwrap();
        file.set_len(file.metadata().unwrap().len() + 512).unwrap();
        drop(file);
        reader
            .input
            .as_mut()
            .unwrap()
            .write_all(b"finish\n")
            .unwrap();
        reader.input.as_mut().unwrap().flush().unwrap();
        assert_eq!(reader.line(), json!({"error":"source_changed"}));
        reader.finish(false);
    }
    cases.push("main_content_stamp_changes_before_copy_or_publication_refuse");
    for phase in ["cold_prepared", "cold_read"] {
        for root in [false, true] {
            let f = cold();
            let mut reader = Worker::start(&f.path, phase);
            reader.line();
            let target = if root {
                f.path.parent().unwrap()
            } else {
                &f.path
            };
            let moved = target.with_file_name("owned-moved");
            std::fs::rename(target, &moved).unwrap();
            if root {
                std::fs::create_dir(target).unwrap();
            } else {
                std::fs::copy(&moved, target).unwrap();
            }
            reader
                .input
                .as_mut()
                .unwrap()
                .write_all(b"finish\n")
                .unwrap();
            reader.input.as_mut().unwrap().flush().unwrap();
            let reply = reader.line();
            assert!(
                reply.as_object().unwrap().len() == 1 && reply["error"].is_string(),
                "replaced source publishes no fields: {reply}"
            );
            reader.finish(false);
        }
    }
    cases.push("root_and_main_replacement_before_copy_or_publication_refuse");

    // This raw owned-file lock is held only in the separate parent process.
    // It models an existing native EXCLUSIVE lock; the reader must not wait.
    {
        use std::os::fd::AsRawFd;
        let f = cold();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&f.path)
            .unwrap();
        // SAFETY: zero-initialized native flock, then exact finite SQLite shared
        // byte range; the owned writable test FD and range remain live.
        let mut range: libc::flock = unsafe { std::mem::zeroed() };
        range.l_type = libc::F_WRLCK as _;
        range.l_whence = libc::SEEK_SET as _;
        range.l_start = 0x4000_0002;
        range.l_len = 510;
        assert_eq!(
            // SAFETY: held owned test FD, correctly initialized platform flock.
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &range) },
            0
        );
        assert_eq!(f.capture("cold"), json!({"error":"source_busy"}));
        drop(file);
        expect_title(&f.capture("cold"), "latest");
    }
    cases.push("existing_native_exclusive_lock_refuses_without_blocking_or_retry");

    {
        let mut f = cold();
        let mut reader = Worker::start(&f.path, "cold_prepared");
        reader.line();
        f.writer = Some(Connection::open(&f.path).unwrap());
        f.writer().busy_timeout(Duration::ZERO).unwrap();
        f.update("after-kill");
        reader.finish(true);
        f.close_writer(false);
        assert!(
            !f.sidecar("-wal").exists(),
            "actual killed-reader exit releases SHARED lock"
        );
        expect_title(&f.capture("cold"), "after-kill");
    }
    cases.push("killed_cold_reader_actual_exit_releases_native_main_lock");

    {
        let mut f = Fixture::named("cold-root/state_5.sqlite");
        f.writer().execute_batch("CREATE TABLE unrelated_large_data(value BLOB); INSERT INTO unrelated_large_data VALUES(zeroblob(12582912));").unwrap();
        f.close_writer(false);
        let before = f.snapshot();
        let reply = f.capture("cold");
        expect_title(&reply, "latest");
        assert!(reply["snapshotBytes"].as_u64().unwrap() > 8 * 1024 * 1024);
        assert!(reply["sourceReadCalls"].as_u64().unwrap() > 128);
        assert!(f.snapshot() == before);
    }
    cases.push("cold_database_above_hot_read_budget_is_bounded_and_unchanged");
    let f = cold();
    let moved = f.path.with_file_name("owned-original");
    std::fs::rename(&f.path, &moved).unwrap();
    symlink(&moved, &f.path).unwrap();
    assert_eq!(
        f.capture("cold"),
        json!({"error":"source_not_regular_or_linked"})
    );
    cases.push("symlink_main_refused");
    let f = cold();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&f.path)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 512)
        .unwrap();
    assert_eq!(f.capture("cold"), json!({"error":"source_too_large"}));
    cases.push("cold_memory_copy_has_explicit_64mib_limit");
    for bad in [vec![0_u8; 512], b"not sqlite".to_vec()] {
        let f = cold();
        std::fs::write(&f.path, bad).unwrap();
        let before = f.snapshot();
        assert_eq!(
            f.capture("cold"),
            json!({"error":"source_database_unsupported"})
        );
        assert!(f.snapshot() == before);
    }
    cases.push("malformed_cold_image_has_no_repair_or_payload");
}
