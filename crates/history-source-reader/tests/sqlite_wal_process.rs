//! Disposable-source VFS behavior gate. This is NOT a production source opener,
//! filesystem grant, native Codex process, OS sandbox or performance benchmark.
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};
use stepsemble_history_source_reader::sqlite_metadata::{
    THREADS_SCHEMA, capture_name_fields, engine_matches_pin,
};
#[path = "support/sqlite_cold_cases.rs"]
mod cold_cases;
#[path = "support/sqlite_source_cases.rs"]
mod source_cases;

const ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const WAIT: Duration = Duration::from_secs(5);
static SPAWNED: AtomicUsize = AtomicUsize::new(0);
static REAPED: AtomicUsize = AtomicUsize::new(0);
static CLOSED_FIXTURES: AtomicUsize = AtomicUsize::new(0);
static SNAPSHOT_CHILDREN: AtomicUsize = AtomicUsize::new(0);

#[derive(Deserialize, Serialize, PartialEq, Eq)]
struct FileDigest {
    bytes: usize,
    sha256: String,
}
impl FileDigest {
    fn len(&self) -> usize {
        self.bytes
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    path: PathBuf,
    mode: String,
}

fn uri(path: &Path, readonly_shm: bool) -> String {
    let raw = path.to_str().expect("owned path UTF8");
    #[cfg(windows)]
    let raw = format!(
        "/{}",
        raw.strip_prefix(r"\\?\").unwrap_or(raw).replace('\\', "/")
    );
    let mut out = String::from("file:");
    for b in raw.as_bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~:".contains(b) {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out.push_str(if readonly_shm {
        "?mode=ro&readonly_shm=1"
    } else {
        "?mode=ro"
    });
    out
}

fn send(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}

#[cfg(windows)]
fn windows_policy_probe(path: &Path) {
    use rusqlite::ffi;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_DELETE_ON_CLOSE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_ALWAYS, OPEN_EXISTING, WriteFile,
        },
    };
    type Open = unsafe extern "system" fn(
        *const u16,
        u32,
        u32,
        *const SECURITY_ATTRIBUTES,
        u32,
        u32,
        HANDLE,
    ) -> HANDLE;
    type OpenAnsi = unsafe extern "system" fn(
        *const u8,
        u32,
        u32,
        *const SECURITY_ATTRIBUTES,
        u32,
        u32,
        HANDLE,
    ) -> HANDLE;
    let wide = |p: &Path| p.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
    let existing = wide(path);
    let missing = wide(&path.with_file_name("never-create-shm"));
    let ansi = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    // SAFETY: dedicated test process already installed the policy. SQLite's
    // Win32 table and static names remain live; cast erased callbacks to the
    // exact pinned WINAPI signatures. All paths refer to owned fixtures only.
    unsafe {
        let vfs = ffi::sqlite3_vfs_find(c"win32".as_ptr());
        assert!(!vfs.is_null());
        let get = (*vfs).xGetSystemCall.unwrap();
        let open = std::mem::transmute::<unsafe extern "C" fn(), Open>(
            get(vfs, c"CreateFileW".as_ptr()).unwrap(),
        );
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
        let null = std::ptr::null();
        let null_handle = std::ptr::null_mut();
        assert_eq!(
            open(
                missing.as_ptr(),
                GENERIC_READ,
                share,
                null,
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                null_handle
            ),
            INVALID_HANDLE_VALUE,
            "internal SHM OPEN_ALWAYS cannot create a missing file"
        );
        let handle = open(
            existing.as_ptr(),
            GENERIC_WRITE,
            share,
            null,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            null_handle,
        );
        assert_ne!(handle, INVALID_HANDLE_VALUE, "existing file can be opened");
        let mut written = 0;
        let wrote = WriteFile(handle, b"!".as_ptr(), 1, &mut written, std::ptr::null_mut());
        let closed = CloseHandle(handle);
        assert_eq!(wrote, 0, "kernel handle must not grant write access");
        assert_ne!(closed, 0);
        assert_eq!(
            open(
                existing.as_ptr(),
                GENERIC_READ,
                share,
                null,
                OPEN_EXISTING,
                FILE_FLAG_DELETE_ON_CLOSE,
                null_handle
            ),
            INVALID_HANDLE_VALUE
        );
        let open_ansi = std::mem::transmute::<unsafe extern "C" fn(), OpenAnsi>(
            get(vfs, c"CreateFileA".as_ptr()).unwrap(),
        );
        assert_eq!(
            open_ansi(
                ansi.as_ptr().cast(),
                GENERIC_READ,
                share,
                null,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_handle
            ),
            INVALID_HANDLE_VALUE
        );
        let delete_wide = std::mem::transmute::<
            unsafe extern "C" fn(),
            unsafe extern "system" fn(*const u16) -> i32,
        >(get(vfs, c"DeleteFileW".as_ptr()).unwrap());
        let delete_ansi = std::mem::transmute::<
            unsafe extern "C" fn(),
            unsafe extern "system" fn(*const u8) -> i32,
        >(get(vfs, c"DeleteFileA".as_ptr()).unwrap());
        assert_eq!(delete_wide(existing.as_ptr()), 0);
        assert_eq!(delete_ansi(ansi.as_ptr().cast()), 0);
    }
    // Parent checks the complete byte/name snapshot, including no truncation.
}

fn child() {
    // A fresh process has no writable SQLite/SHM object to reuse. The parent
    // supplies only its disposable fixture; never consult HOME or native config.
    assert!(engine_matches_pin());
    #[cfg(unix)]
    // SAFETY: geteuid takes no pointers and only returns this process's identity.
    assert_ne!(unsafe { libc::geteuid() }, 0, "never run this gate as root");
    let mut input = BufReader::new(std::io::stdin());
    let mut line = Vec::new();
    input
        .by_ref()
        .take(4097)
        .read_until(b'\n', &mut line)
        .unwrap();
    assert!(line.len() <= 4096 && line.ends_with(b"\n"));
    let request: Request = serde_json::from_slice(&line).unwrap();
    assert!(request.path.is_absolute());
    assert!(
        [
            "capture",
            "ordinary",
            "unguarded",
            "cancel",
            "hold",
            "policy",
            "bound",
            "bound_prepared",
            "bound_read",
            "bound_cancel",
            "snapshot",
            "cold",
            "cold_catalog",
            "cold_prepared",
            "cold_read",
            "cold_cancel"
        ]
        .contains(&request.mode.as_str())
    );
    if request.mode == "snapshot" {
        // Never read/close same-inode descriptors in the writer process: POSIX
        // close releases that process's SQLite locks, even for an unrelated FD.
        use sha2::{Digest, Sha256};
        let files = std::fs::read_dir(request.path.parent().unwrap())
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                assert!(entry.file_type().unwrap().is_file());
                // Separate-process streaming comparison also covers the cold
                // 64 MiB image limit without allocating another whole image.
                let mut file = std::fs::File::open(entry.path()).unwrap();
                let mut digest = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];
                let mut bytes = 0_usize;
                loop {
                    let count = file.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes += count;
                    assert!(bytes <= 65 * 1024 * 1024);
                    digest.update(&buffer[..count]);
                }
                (
                    entry.file_name().to_str().unwrap().to_owned(),
                    FileDigest {
                        bytes,
                        sha256: format!("{:x}", digest.finalize()),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        send(serde_json::to_value(files).unwrap());
        return;
    }
    if request.mode.starts_with("bound") {
        bound_child(request, &mut input);
        return;
    }
    if request.mode.starts_with("cold") {
        cold_cases::child(request, &mut input);
        return;
    }
    let guarded = request.mode != "ordinary" && request.mode != "unguarded";
    let vfs = if guarded {
        // SAFETY: this is a new dedicated subprocess. No SQLite connection has
        // been opened, none will be writable, and no VFS is unregistered/changed.
        unsafe {
            stepsemble_history_source_reader::sqlite_readonly_vfs::install_for_dedicated_process()
        }
        .unwrap()
        .to_str()
        .unwrap()
    } else if cfg!(windows) {
        "win32"
    } else {
        "unix"
    };
    if request.mode == "policy" {
        assert!(
            Connection::open_with_flags_and_vfs(
                &request.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY,
                vfs
            )
            .is_err(),
            "missing readonly_shm must refuse"
        );
        assert!(
            Connection::open_with_flags_and_vfs(
                uri(&request.path, true).replace("mode=ro", "mode=rw"),
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
                vfs
            )
            .is_err(),
            "writable main must refuse"
        );
        let missing = request.path.with_file_name("never-create.sqlite");
        assert!(
            Connection::open_with_flags_and_vfs(
                uri(&missing, true).replace("mode=ro", "mode=rwc"),
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_URI,
                vfs
            )
            .is_err()
        );
        assert!(!missing.exists());
        let vfs_name = std::ffi::CString::new(vfs).unwrap();
        let filename = std::ffi::CString::new(request.path.to_str().unwrap()).unwrap();
        // SAFETY: registered VFS remains live; filename is a live C string.
        // xDelete is the shim's deny callback and ignores its path argument.
        unsafe {
            let shim = rusqlite::ffi::sqlite3_vfs_find(vfs_name.as_ptr());
            assert!(!shim.is_null());
            assert_eq!(
                (*shim).xDelete.unwrap()(shim, filename.as_ptr(), 0),
                rusqlite::ffi::SQLITE_READONLY
            );
            let default_vfs = rusqlite::ffi::sqlite3_vfs_find(std::ptr::null());
            assert_ne!(
                default_vfs, shim,
                "registration leaves the default unchanged"
            );
        }
        #[cfg(windows)]
        windows_policy_probe(&request.path);
        send(json!({"policyRefusals":4,"defaultUnchanged":true,
                    "windowsSyscallChecks":if cfg!(windows) { 7 } else { 0 }}));
        return;
    }
    let db = Connection::open_with_flags_and_vfs(
        uri(&request.path, request.mode != "ordinary"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        vfs,
    );
    let db = match db {
        Ok(db) => db,
        Err(_) => {
            send(json!({"error":"open_refused"}));
            return;
        }
    };
    if request.mode == "hold" {
        // Deliberately held transaction for OS-lock semantics only. This path
        // is NOT capture_name_fields, never a published app observation and is
        // bounded/killed by the parent. Production capture remains 250ms.
        db.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .unwrap();
        db.busy_timeout(Duration::ZERO).unwrap();
        db.execute_batch("PRAGMA query_only=ON; PRAGMA mmap_size=0; BEGIN")
            .unwrap();
        let title = || {
            db.query_row("SELECT title FROM threads WHERE id=?1", [ID], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
        };
        let first = title();
        send(json!({"ready":true,"title":first}));
        line.clear();
        input.by_ref().take(8).read_until(b'\n', &mut line).unwrap();
        assert_eq!(line, b"finish\n");
        assert_eq!(
            title(),
            first,
            "writer commits cannot split this transaction"
        );
        db.execute_batch("ROLLBACK").unwrap();
        db.close().unwrap();
        send(json!({"closed":true,"title":first}));
    } else {
        let result = capture_name_fields(
            db,
            "0.153.4",
            ID,
            Arc::new(AtomicBool::new(request.mode == "cancel")),
        );
        send(match result {
            Ok(observation) => json!({"observation":observation}),
            Err(error) => json!({"error":format!("{error:?}")}),
        });
    }
}

struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    lines: mpsc::Receiver<Value>,
    output: Option<thread::JoinHandle<()>>,
    errors: Option<thread::JoinHandle<Vec<u8>>>,
    reaped: bool,
}

fn bound_child(request: Request, input: &mut BufReader<std::io::Stdin>) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::fs::MetadataExt;
        use stepsemble_history_source_reader::sqlite_source::{self, Selection};
        let parent = request.path.parent().unwrap();
        let info = std::fs::metadata(parent).unwrap();
        let selection = Selection {
            root_path: parent.to_str().unwrap().to_owned(),
            expected_device: info.dev(),
            expected_inode: info.ino(),
            native_version: "0.153.4".into(),
            thread_id: ID.into(),
        };
        let result = (|| {
            // SAFETY: fresh fixture-only subprocess with no SQLite connections
            // or lock-bearing descriptors; no unguarded fallback or later use.
            let prepared = unsafe {
                sqlite_source::prepare(
                    selection,
                    Arc::new(AtomicBool::new(request.mode == "bound_cancel")),
                )
            }?;
            let mut wait = |stage| {
                send(json!({"ready":stage}));
                let mut line = Vec::new();
                input.by_ref().take(8).read_until(b'\n', &mut line).unwrap();
                assert_eq!(line, b"finish\n");
            };
            if request.mode == "bound_prepared" {
                wait("prepared");
            }
            let pending = prepared.read()?;
            if request.mode == "bound_read" {
                wait("read");
            }
            pending.finish()
        })();
        send(match result {
            Ok(value) => serde_json::to_value(value).unwrap(),
            Err(error) => json!({"error":error.code()}),
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (request, input);
        send(json!({"error":"source_platform_unsupported"}));
    }
}
impl Worker {
    fn start(path: &Path, mode: &str) -> Self {
        Self::start_request(path, mode, None)
    }
    fn start_request(path: &Path, mode: &str, frame: Option<Value>) -> Self {
        let framed = frame.is_some();
        let mut command = if framed {
            Command::new(env!("CARGO_BIN_EXE_stepsemble-history-source-reader"))
        } else {
            let mut c = Command::new(std::env::current_exe().unwrap());
            c.arg("--owned-reader-child");
            c
        };
        command.current_dir(path.parent().unwrap()).env_clear();
        // Windows runtime system location only; no native HOME/auth/config.
        #[cfg(windows)]
        if let Some(value) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", value);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        SPAWNED.fetch_add(1, Ordering::Relaxed);
        if mode == "snapshot" {
            SNAPSHOT_CHILDREN.fetch_add(1, Ordering::Relaxed);
        }
        let input = child.stdin.take().unwrap();
        let (tx, lines) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        // Own kill/wait cleanup before fallible thread startup or pipe writes.
        let mut worker = Self {
            child,
            input: Some(input),
            lines,
            output: None,
            errors: None,
            reaped: false,
        };
        worker.output = Some(thread::spawn(move || {
            if framed {
                use sha2::{Digest, Sha256};
                let mut bytes = Vec::new();
                stdout.take(164 * 1024 + 1).read_to_end(&mut bytes).unwrap();
                assert!((5..=164 * 1024).contains(&bytes.len()));
                let n = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
                assert!((1..=16 * 1024).contains(&n) && 4 + n <= bytes.len());
                let header: Value = serde_json::from_slice(&bytes[4..4 + n]).unwrap();
                let payload = &bytes[4 + n..];
                let body = if payload.is_empty() {
                    Value::Null
                } else {
                    assert_eq!(header["result"]["byteLength"], payload.len());
                    assert_eq!(
                        header["result"]["sha256"],
                        format!("{:x}", Sha256::digest(payload))
                    );
                    serde_json::from_slice(payload).unwrap()
                };
                tx.send(json!({"header":header,"body":body})).unwrap();
                return;
            }
            let mut reader = BufReader::new(stdout).take(16385);
            let mut count = 0;
            loop {
                let mut line = String::new();
                let bytes = reader.read_line(&mut line).unwrap();
                if bytes == 0 {
                    break;
                }
                count += bytes;
                assert!(count <= 16384, "bounded child output");
                tx.send(serde_json::from_str(&line).unwrap()).unwrap();
            }
        }));
        worker.errors = Some(thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.take(16385).read_to_end(&mut bytes).unwrap();
            bytes
        }));
        let input = worker.input.as_mut().unwrap();
        let request = frame.unwrap_or_else(|| {
            serde_json::to_value(Request {
                path: path.into(),
                mode: mode.into(),
            })
            .unwrap()
        });
        serde_json::to_writer(&mut *input, &request).unwrap();
        writeln!(input).unwrap();
        input.flush().unwrap();
        if framed {
            worker.input.take(); // Production helper consumes exactly one bounded stdin to EOF.
        }
        worker
    }
    fn line(&self) -> Value {
        self.lines.recv_timeout(WAIT).expect("bounded child reply")
    }
    fn finish(&mut self, killed: bool) {
        if killed {
            // Keep stdin live through actual exit. Closing it first lets the
            // held reader observe EOF and panic before Windows terminates it,
            // turning a kill/OS-lock test into an accidental protocol failure.
            assert!(self.input.is_some());
            self.child.kill().unwrap();
        } else {
            self.input.take();
        }
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                REAPED.fetch_add(1, Ordering::Relaxed);
                assert_eq!(status.success(), !killed, "actual child exit: {status}");
                break;
            }
            assert!(start.elapsed() < WAIT, "child did not actually close");
            thread::sleep(Duration::from_millis(5));
        }
        self.input.take();
        self.output.take().unwrap().join().unwrap();
        let errors = self.errors.take().unwrap().join().unwrap();
        assert!(
            errors.is_empty(),
            "child diagnostics: {}",
            String::from_utf8_lossy(&errors)
        );
        assert!(self.lines.try_recv().is_err(), "no extra reply");
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(h) = self.output.take() {
            let _ = h.join();
        }
        if let Some(h) = self.errors.take()
            && let Ok(bytes) = h.join()
            && !bytes.is_empty()
        {
            eprintln!(
                "owned child diagnostics: {}",
                String::from_utf8_lossy(&bytes)
            );
        }
    }
}

struct Fixture {
    dir: Option<tempfile::TempDir>,
    path: PathBuf,
    writer: Option<Connection>,
}
impl Fixture {
    fn new() -> Self {
        Self::named(if cfg!(windows) {
            "owned 🐾 #% space.sqlite"
        } else {
            "owned 🐾 #%?.sqlite"
        })
    }
    fn named(filename: &str) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("stepsemble-sqlite-process-owned-")
            .tempdir()
            .unwrap();
        let path = dir.path().canonicalize().unwrap().join(filename);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE thread_sections(id TEXT PRIMARY KEY);").unwrap();
        writer.execute_batch(THREADS_SCHEMA).unwrap();
        writer.execute("INSERT INTO threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,first_user_message,name) VALUES(?1,'owned',0,0,'cli','owned','owned','base','owned','never','base','base')", [ID]).unwrap();
        writer.busy_timeout(Duration::ZERO).unwrap();
        let f = Self {
            dir: Some(dir),
            path,
            writer: Some(writer),
        };
        assert_eq!(f.checkpoint(), 0);
        f.update("latest");
        f
    }
    fn writer(&self) -> &Connection {
        self.writer.as_ref().unwrap()
    }
    fn update(&self, title: &str) {
        self.writer()
            .execute(
                "UPDATE threads SET title=?1,first_user_message=?1,name=?1 WHERE id=?2",
                params![title, ID],
            )
            .unwrap();
    }
    fn checkpoint(&self) -> i32 {
        self.writer()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
            .unwrap()
    }
    fn close_writer(&mut self, keep_wal: bool) {
        let db = self.writer.take().unwrap();
        db.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            keep_wal,
        )
        .unwrap();
        db.close().unwrap();
    }
    fn sidecar(&self, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}{suffix}", self.path.display()))
    }
    fn snapshot(&self) -> BTreeMap<String, FileDigest> {
        serde_json::from_value(self.capture("snapshot")).unwrap()
    }
    fn capture(&self, mode: &str) -> Value {
        let mut child = Worker::start(&self.path, mode);
        let reply = child.line();
        child.finish(false);
        reply
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(db) = self.writer.take() {
            db.close().unwrap();
        }
        if let Some(dir) = self.dir.take() {
            let path = dir.path().to_owned();
            // TempDir's implicit Drop ignores deletion errors. Explicit close
            // must succeed before this gate can claim owned fixture cleanup.
            dir.close().expect("owned fixture directory cleanup");
            assert!(
                !path.try_exists().expect("verify owned fixture removal"),
                "owned fixture directory remains"
            );
            CLOSED_FIXTURES.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn expect_title(reply: &Value, title: &str) {
    let row = &reply["observation"];
    assert_eq!(row["fields"]["title"], title, "{reply}");
    assert_eq!(row["fields"]["first_user_message"], title);
    assert_eq!(row["fields"]["name"], title);
    assert_eq!(row["connectionClosed"], true);
    assert_eq!(row["publishable"], false);
    assert_eq!(row["sourceAuthenticated"], false);
}

fn suite() {
    assert!(engine_matches_pin());
    let mut cases = Vec::new();
    let f = Fixture::new();
    let before = f.snapshot();
    expect_title(&f.capture("capture"), "latest");
    assert!(
        f.snapshot() == before,
        "readonly SHM does not change owned file bytes/names"
    );
    cases.push("active_writer_latest_wal_bytes_unchanged");
    assert_eq!(f.capture("cancel")["error"], "Cancelled");
    assert!(f.snapshot() == before);
    cases.push("cancelled_capture_bytes_unchanged");
    assert_eq!(
        f.capture("policy"),
        json!({"policyRefusals":4,"defaultUnchanged":true,
               "windowsSyscallChecks":if cfg!(windows) { 7 } else { 0 }})
    );
    assert!(f.snapshot() == before);
    cases.push("vfs_refuses_writable_main_create_delete_and_missing_shm_flag");
    // Negative control proves that an ordinary read-only connection may still
    // mutate SHM; compare a quiet writer's exact files around the child only.
    expect_title(&f.capture("ordinary"), "latest");
    let after = f.snapshot();
    let shm = f
        .sidecar("-shm")
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        before[&shm] != after[&shm],
        "ordinary read must expose SHM mutation in this fixture"
    );
    for (name, bytes) in &before {
        if name != &shm {
            assert!(&after[name] == bytes);
        }
    }
    cases.push("ordinary_readonly_negative_control_changes_shm_only");
    drop(f);

    for (label, keep_wal, remove) in [
        ("orphan_wal", true, ""),
        ("missing_shm", true, "-shm"),
        ("missing_wal", true, "-wal"),
        ("cold_checkpointed", false, ""),
    ] {
        let mut f = Fixture::new();
        f.close_writer(keep_wal);
        if !remove.is_empty() {
            std::fs::remove_file(f.sidecar(remove)).unwrap();
        }
        let before = f.snapshot();
        let reply = f.capture("capture");
        let after = f.snapshot();
        assert!(after == before, "no repair/create/checkpoint for {label}");
        if label == "orphan_wal" {
            expect_title(&reply, "latest");
        } else {
            assert_eq!(reply, json!({"error":"SqliteUnavailable"}), "{label}");
        }
        cases.push(label);
    }

    for missing_wal in [true, false] {
        let mut f = Fixture::new();
        f.close_writer(missing_wal);
        if missing_wal {
            std::fs::remove_file(f.sidecar("-wal")).unwrap();
        }
        let before = f.snapshot();
        let reply = f.capture("unguarded");
        // Bounded diagnostics contain owned filenames/sizes, never DB bytes.
        let summary = f
            .snapshot()
            .iter()
            .map(|(name, bytes)| {
                (
                    name.clone(),
                    json!({"bytes":bytes.len(),"changed":before.get(name)!=Some(bytes)}),
                )
            })
            .collect::<BTreeMap<_, _>>();
        println!(
            "{}",
            json!({"negativeControl":if missing_wal {"missing_wal"}else{"cold"},
            "reply":reply,"ownedFiles":summary})
        );
        if missing_wal {
            expect_title(&reply, "base");
        } else if cfg!(windows) {
            // Verified on Windows CI: unguarded winHandleOpen(OPEN_ALWAYS)
            // creates a zero-byte SHM as well, enabling heap-index fallback.
            expect_title(&reply, "latest");
        } else {
            assert_eq!(reply, json!({"error":"SqliteUnavailable"}));
        }
        let mut after = f.snapshot();
        let wal_name = f
            .sidecar("-wal")
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            after.remove(&wal_name).unwrap().len(),
            0,
            "unguarded engine creates an empty WAL"
        );
        if cfg!(windows) && !missing_wal {
            let shm_name = f
                .sidecar("-shm")
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            assert_eq!(
                after.remove(&shm_name).unwrap().len(),
                0,
                "unguarded Windows also creates an empty SHM"
            );
        }
        assert!(
            after == before,
            "only the expected empty sidecars are created"
        );
        cases.push(if missing_wal {
            "unguarded_missing_wal_creates_file_and_reads_old_base"
        } else if cfg!(windows) {
            "unguarded_cold_database_creates_wal_and_shm_on_success"
        } else {
            "unguarded_cold_database_creates_wal_even_on_failure"
        });
    }

    let f = Fixture::new();
    f.writer().execute_batch("BEGIN IMMEDIATE").unwrap();
    f.update("uncommitted");
    expect_title(&f.capture("capture"), "latest");
    f.writer().execute_batch("COMMIT").unwrap();
    expect_title(&f.capture("capture"), "uncommitted");
    cases.push("writer_transaction_only_committed_fields_visible");

    let mut worker = Worker::start(&f.path, "hold");
    assert_eq!(worker.line(), json!({"ready":true,"title":"uncommitted"}));
    // Owned semantic test only, not native durability/throughput evidence.
    f.writer().execute_batch("PRAGMA synchronous=OFF").unwrap();
    for n in 0..20 {
        f.update(&format!("generation-{n}"));
    }
    assert_eq!(
        f.checkpoint(),
        1,
        "real cross-process reader delays checkpoint"
    );
    worker
        .input
        .as_mut()
        .unwrap()
        .write_all(b"finish\n")
        .unwrap();
    assert_eq!(worker.line(), json!({"closed":true,"title":"uncommitted"}));
    worker.finish(false);
    assert_eq!(f.checkpoint(), 0);
    expect_title(&f.capture("capture"), "generation-19");
    cases.push("cross_process_snapshot_and_actual_close_release");

    f.update("kill-lease");
    let mut worker = Worker::start(&f.path, "hold");
    assert_eq!(worker.line(), json!({"ready":true,"title":"kill-lease"}));
    f.update("after-kill");
    assert_eq!(f.checkpoint(), 1);
    worker.finish(true);
    assert_eq!(
        f.checkpoint(),
        0,
        "OS releases locks only after child actually ends"
    );
    expect_title(&f.capture("capture"), "after-kill");
    cases.push("killed_reader_actual_exit_releases_os_locks");
    drop(f);
    let spawned = SPAWNED.load(Ordering::Relaxed);
    let reaped = REAPED.load(Ordering::Relaxed);
    let snapshots = SNAPSHOT_CHILDREN.load(Ordering::Relaxed);
    assert_eq!(spawned, 16 + snapshots);
    assert_eq!(reaped, spawned);
    let closed_fixtures = CLOSED_FIXTURES.load(Ordering::Relaxed);
    assert_eq!(closed_fixtures, 8);
    println!(
        "{}",
        json!({"kind":"owned_sqlite_process_gate","platform":std::env::consts::OS,
        "sqliteVersion":rusqlite::version(),"cases":cases,"nativeCodexWriter":false,
        "spawnedChildren":spawned,"reapedChildren":reaped,"remainingChildren":spawned-reaped,
        "snapshotChildren":snapshots,"readerChildren":16,"fileComparison":"size_and_sha256_in_separate_process",
        "removedOwnedFixtureDirectories":closed_fixtures,
        "productionSourceOpener":false,"privateHistoryReads":0,"modelCalls":0,"cleanupConfirmed":true})
    );
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--owned-reader-child" {
        child();
    } else {
        assert_eq!(args.len(), 1, "no user-supplied source arguments");
        suite();
        source_suite();
        source_cases::run();
        cold_cases::run();
    }
}

fn source_suite() {
    let before_spawn = SPAWNED.load(Ordering::Relaxed);
    let before_reap = REAPED.load(Ordering::Relaxed);
    let before_dirs = CLOSED_FIXTURES.load(Ordering::Relaxed);
    let f = Fixture::named("sqlite-root/state_5.sqlite");
    let before = f.snapshot();
    let reply = f.capture("bound");
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        expect_title(&reply, "latest");
        assert_eq!(reply["filesystemChecksPassed"], true);
        assert_eq!(reply["sourceDescriptorsClosed"], 4);
        assert_eq!(reply["sqliteDescriptorsOpened"], 3);
        assert_eq!(reply["sqliteDescriptorsClosed"], 3);
        assert!(reply["shmMappingsClosed"].as_u64().unwrap() > 0);
        assert!(reply["readCalls"].as_u64().unwrap() > 0);
        assert_eq!(reply["publishable"], false);
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    assert_eq!(reply, json!({"error":"source_platform_unsupported"}));
    assert!(
        f.snapshot() == before,
        "bound source read leaves exact bytes/names unchanged"
    );
    drop(f);
    let children = SPAWNED.load(Ordering::Relaxed) - before_spawn;
    assert_eq!(children, REAPED.load(Ordering::Relaxed) - before_reap);
    println!(
        "{}",
        json!({"kind":"owned_sqlite_source_gate","platform":std::env::consts::OS,
        "sourceBoundary":if cfg!(any(target_os="macos",target_os="linux")) {"passed"}else{"unsupported"},
        "spawnedChildren":children,"reapedChildren":children,"remainingChildren":0,
        "removedOwnedFixtureDirectories":CLOSED_FIXTURES.load(Ordering::Relaxed)-before_dirs})
    );
}
