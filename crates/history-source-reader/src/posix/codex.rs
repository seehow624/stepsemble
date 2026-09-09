//! Observe one selected plain rollout and the fixed optional name index together.
//! Repeated checks are not an atomic filesystem transaction or native provenance.
use super::*;
use crate::codex::{INDEX_LIMIT, Pair, Request as CodexRequest, valid_locator};
use stepsemble_history_source_reader::{codex_rollout_format, codex_rollout_structure, jsonl_scan};

const NAME_INDEX: &str = "session_index.jsonl";
#[derive(Clone, Copy, PartialEq, Eq)]
enum Point {
    Opened,
    FirstRead,
    SecondRead,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum PageMode {
    Opaque,
    Validated,
    Structured,
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
fn optional_index(root: &File) -> Result<Option<File>, Error> {
    match open_at(root.as_raw_fd(), NAME_INDEX, false) {
        Ok(file) => Ok(Some(file)),
        Err(Error::Missing) => Ok(None),
        Err(error) => Err(error),
    }
}
fn bounded_info(
    file: &File,
    uid: u32,
    device: u64,
    limit: usize,
    empty: bool,
) -> Result<Metadata, Error> {
    let info = check(file, false, uid)?;
    if info.dev() != device {
        return Err(Error::ContainmentUnavailable);
    }
    if !empty && info.size() == 0 {
        return Err(Error::Empty);
    }
    if info.size() > limit as u64 {
        return Err(Error::TooLarge);
    }
    Ok(info)
}

pub fn capture(request: &CodexRequest) -> Result<Pair, Error> {
    capture_with(request, |_| {})
}
fn capture_with(request: &CodexRequest, mut hook: impl FnMut(Point)) -> Result<Pair, Error> {
    match capture_variant(request, None, PageMode::Opaque, &mut hook)? {
        Captured::Bytes(pair) => Ok(pair),
        Captured::Page(_) => Err(Error::Input),
    }
}

pub fn capture_scanned(
    request: &CodexRequest,
    page: jsonl_scan::Selection,
) -> Result<crate::codex_scanned::Pair, Error> {
    capture_scanned_with(request, page, |_| {})
}
fn capture_scanned_with(
    request: &CodexRequest,
    page: jsonl_scan::Selection,
    mut hook: impl FnMut(Point),
) -> Result<crate::codex_scanned::Pair, Error> {
    capture_scanned_mode(request, page, PageMode::Opaque, &mut hook)
}
pub fn capture_validated(
    request: &CodexRequest,
    page: jsonl_scan::Selection,
) -> Result<crate::codex_scanned::Pair, Error> {
    capture_scanned_mode(request, page, PageMode::Validated, &mut |_| {})
}
pub fn capture_structured(
    request: &CodexRequest,
    page: jsonl_scan::Selection,
) -> Result<crate::codex_scanned::Pair, Error> {
    capture_scanned_mode(request, page, PageMode::Structured, &mut |_| {})
}
fn capture_scanned_mode(
    request: &CodexRequest,
    page: jsonl_scan::Selection,
    mode: PageMode,
    hook: &mut impl FnMut(Point),
) -> Result<crate::codex_scanned::Pair, Error> {
    if page.offset > jsonl_scan::RECORDS || page.limit == 0 || page.limit > jsonl_scan::PAGE_RECORDS
    {
        return Err(Error::Input);
    }
    match capture_variant(request, Some(page), mode, hook)? {
        Captured::Page(pair) => Ok(pair),
        Captured::Bytes(_) => Err(Error::Input),
    }
}
enum Captured {
    Bytes(Pair),
    Page(crate::codex_scanned::Pair),
}
enum Rollout {
    Bytes(Vec<u8>),
    Page(jsonl_scan::Page),
}

// Shared authenticated open/check/close boundary. v3/v9 retain their exact
// literal two-buffer comparison; v10 uses full-source digest scans explicitly.
fn capture_variant(
    request: &CodexRequest,
    page: Option<jsonl_scan::Selection>,
    mode: PageMode,
    hook: &mut impl FnMut(Point),
) -> Result<Captured, Error> {
    if !valid_locator(&request.source.rollout_path, &request.source.thread_id) {
        return Err(Error::Input);
    }
    let stored = request.protocol_version == 9;
    if !stored && request.source.rollout_path.ends_with(".zst") {
        return Err(Error::EncodingUnsupported);
    }
    let start = Instant::now();
    // SAFETY: geteuid has no pointer arguments and no side effects.
    let uid = unsafe { libc::geteuid() };
    let anchor = root(&request.source.codex_root)?;
    let before = check(&anchor, true, uid)?;
    if before.dev().to_string() != request.expected_root.device
        || before.ino().to_string() != request.expected_root.inode
    {
        return Err(Error::RootIdentityChanged);
    }
    let device = before.dev();
    let mut directories = vec![anchor];
    let mut directory_info = vec![before];
    let parts: Vec<_> = request.source.rollout_path.split('/').collect();
    for name in &parts[..parts.len() - 1] {
        budget(start)?;
        let next = open_at(
            directories.last().ok_or(Error::Input)?.as_raw_fd(),
            name,
            true,
        )?;
        let info = check(&next, true, uid)?;
        if info.dev() != device {
            return Err(Error::ContainmentUnavailable);
        }
        directories.push(next);
        directory_info.push(info);
    }
    let requested = *parts.last().ok_or(Error::Input)?;
    let plain_name = if stored {
        requested.strip_suffix(".zst").unwrap_or(requested)
    } else {
        requested
    };
    let parent = directories.last().ok_or(Error::Input)?;
    // Only ENOENT permits the fixed compressed sibling. Never bypass a plain
    // symlink, directory, ACL, mode, empty file or other unreadable source.
    let (file_name, file) = match open_at(parent.as_raw_fd(), plain_name, false) {
        Ok(file) => (plain_name.to_owned(), file),
        Err(Error::Missing) if stored => {
            let compressed = format!("{plain_name}.zst");
            let file = open_at(parent.as_raw_fd(), &compressed, false)?;
            (compressed, file)
        }
        Err(error) => return Err(error),
    };
    let file_info = bounded_info(
        &file,
        uid,
        device,
        if page.is_some() {
            jsonl_scan::SOURCE_BYTES as usize
        } else {
            SOURCE_LIMIT
        },
        false,
    )?;
    if page.is_some() && file_name.ends_with(".zst") {
        // Never feed compressed bytes to the plain byte-framing scanner.
        return Err(Error::EncodingUnsupported);
    }
    let index = optional_index(&directories[0])?;
    let index_info = index
        .as_ref()
        .map(|file| bounded_info(file, uid, device, INDEX_LIMIT, true))
        .transpose()?;
    // Recheck every held descriptor and the fixed name's absence/presence.
    let verify = || -> Result<(), Error> {
        budget(start)?;
        for (file, info) in directories.iter().zip(&directory_info) {
            if !same(info, &check(file, true, uid)?) {
                return Err(Error::Changed);
            }
        }
        if !same(&file_info, &check(&file, false, uid)?) {
            return Err(Error::Changed);
        }
        if stored {
            if file_name != plain_name {
                match open_at(parent.as_raw_fd(), plain_name, false) {
                    Err(Error::Missing) => {}
                    Ok(file) => {
                        close(file)?;
                        return Err(Error::Changed);
                    }
                    Err(error) => return Err(error),
                }
            }
            let selected = open_at(parent.as_raw_fd(), &file_name, false)?;
            if !same(&file_info, &check(&selected, false, uid)?) {
                return Err(Error::Changed);
            }
            close(selected)?;
        }
        let named = optional_index(&directories[0])?;
        match (&index, &index_info, &named) {
            (None, None, None) => {}
            (Some(held), Some(before), Some(current)) => {
                if !same(before, &check(held, false, uid)?)
                    || !same(before, &check(current, false, uid)?)
                {
                    return Err(Error::Changed);
                }
            }
            _ => return Err(Error::Changed),
        }
        if let Some(file) = named {
            close(file)?;
        }
        Ok(())
    };
    let read_index = || -> Result<Option<Vec<u8>>, Error> {
        index
            .as_ref()
            .zip(index_info.as_ref())
            .map(|(file, info)| read(file, info.size() as usize, start))
            .transpose()
    };
    hook(Point::Opened);
    verify()?;
    let mut validation = None;
    let mut structure = None;
    let (rollout, first_index) = if let Some(selection) = page {
        let first_index = read_index()?;
        let mut selected = SelectedReader {
            file: &file,
            offset: 0,
            rewinds: 0,
            failure: None,
            between: || {
                hook(Point::FirstRead);
                verify()
            },
        };
        let scanned = if mode == PageMode::Structured {
            let result = codex_rollout_structure::scan_page(
                &mut selected,
                file_info.size(),
                selection,
                &request.source.thread_id,
                &request.native_version,
                None,
                || budget(start).map_err(|_| jsonl_scan::Error::Budget),
            );
            if let Some(error) = selected.failure {
                return Err(error);
            }
            let result = result.map_err(|error| match error {
                codex_rollout_structure::Error::Format(e) => Error::RolloutFormat(e),
                codex_rollout_structure::Error::Scan(e) => scan_error(e),
                codex_rollout_structure::Error::InvalidStructure => Error::RolloutStructure,
                codex_rollout_structure::Error::Allocation => Error::Io,
            })?;
            validation = Some(result.validation);
            structure = Some(result.structure);
            result.records
        } else {
            let mut validator = if mode == PageMode::Validated {
                Some(
                    codex_rollout_format::Validator::new(&request.source.thread_id)
                        .map_err(Error::RolloutFormat)?,
                )
            } else {
                None
            };
            let mut format_failure = None;
            let scanned = jsonl_scan::scan_matching_page(
                &mut selected,
                file_info.size(),
                selection,
                None,
                || budget(start).map_err(|_| jsonl_scan::Error::Budget),
                |index, _, bytes| {
                    if let Some(validator) = &mut validator {
                        validator.record(index, bytes).map_err(|error| {
                            format_failure = Some(error);
                            jsonl_scan::Error::InvalidRecord
                        })?;
                    }
                    Ok(())
                },
            );
            if let Some(error) = selected.failure {
                return Err(error);
            }
            if let Some(error) = format_failure {
                return Err(Error::RolloutFormat(error));
            }
            let scanned = scanned.map_err(scan_error)?;
            validation = validator
                .map(|v| v.finish())
                .transpose()
                .map_err(Error::RolloutFormat)?;
            scanned
        };
        let second_index = read_index()?;
        hook(Point::SecondRead);
        verify()?;
        if first_index != second_index {
            return Err(Error::Changed);
        }
        (Rollout::Page(scanned), first_index)
    } else {
        let first = read(&file, file_info.size() as usize, start)?;
        let first_index = read_index()?;
        hook(Point::FirstRead);
        verify()?;
        let second = read(&file, file_info.size() as usize, start)?;
        let second_index = read_index()?;
        hook(Point::SecondRead);
        verify()?;
        if first != second || first_index != second_index {
            return Err(Error::Changed);
        }
        (Rollout::Bytes(first), first_index)
    };
    // Re-observe all selected name->object edges from the original held parents.
    for (i, name) in parts[..parts.len() - 1].iter().enumerate() {
        let named = open_at(directories[i].as_raw_fd(), name, true)?;
        if !same(&directory_info[i + 1], &check(&named, true, uid)?) {
            return Err(Error::Changed);
        }
        close(named)?;
    }
    let named = open_at(
        directories.last().ok_or(Error::Input)?.as_raw_fd(),
        &file_name,
        false,
    )?;
    if !same(&file_info, &check(&named, false, uid)?) {
        return Err(Error::Changed);
    }
    close(named)?;
    let current_root = root(&request.source.codex_root)?;
    if !same(&directory_info[0], &check(&current_root, true, uid)?) {
        return Err(Error::Changed);
    }
    close(current_root)?;
    verify()?;
    let physical_path = format!("{}/{}", parts[..parts.len() - 1].join("/"), file_name);
    let name_index = first_index
        .zip(index_info.as_ref())
        .map(|(bytes, info)| Capture {
            bytes,
            identity: identity(info),
        });
    let pair = match rollout {
        Rollout::Bytes(bytes) => Captured::Bytes(Pair {
            physical_path,
            name_index,
            rollout: Capture {
                bytes,
                identity: identity(&file_info),
            },
        }),
        Rollout::Page(page) => Captured::Page(crate::codex_scanned::Pair {
            physical_path,
            name_index,
            page,
            rollout_identity: identity(&file_info),
            validation,
            structure,
        }),
    };
    let mut close_failed = false;
    for file in index
        .into_iter()
        .chain(std::iter::once(file))
        .chain(directories.into_iter().rev())
    {
        if close(file).is_err() {
            close_failed = true;
        }
    }
    if close_failed {
        return Err(Error::CloseFailed);
    }
    budget(start)?;
    Ok(pair)
}

fn scan_error(error: jsonl_scan::Error) -> Error {
    match error {
        jsonl_scan::Error::InvalidSelection | jsonl_scan::Error::InvalidRecord => Error::Input,
        jsonl_scan::Error::SourceLimit => Error::TooLarge,
        jsonl_scan::Error::Empty => Error::Empty,
        jsonl_scan::Error::RecordLimit => Error::RecordLimit,
        jsonl_scan::Error::IncompleteTail => Error::IncompleteTail,
        jsonl_scan::Error::Changed => Error::Changed,
        jsonl_scan::Error::Io => Error::Io,
        jsonl_scan::Error::Cancelled => Error::Cancelled,
        jsonl_scan::Error::Budget => Error::Budget,
    }
}

// Positioned reads on the same held FD, not a reopened path, duplicate FD or
// shared OS seek cursor. Check original identities between the two full scans.
struct SelectedReader<'a, F> {
    file: &'a File,
    offset: u64,
    rewinds: usize,
    between: F,
    failure: Option<Error>,
}
impl<F> std::io::Read for SelectedReader<'_, F> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.file.read_at(bytes, self.offset)?;
        self.offset += count as u64;
        Ok(count)
    }
}
impl<F: FnMut() -> Result<(), Error>> std::io::Seek for SelectedReader<'_, F> {
    fn seek(&mut self, position: std::io::SeekFrom) -> io::Result<u64> {
        if position != std::io::SeekFrom::Start(0) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.rewinds += 1;
        if self.rewinds == 2
            && let Err(error) = (self.between)()
        {
            self.failure = Some(error);
            return Err(io::ErrorKind::Other.into());
        }
        self.offset = 0;
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        file: PathBuf,
        index: PathBuf,
        request: CodexRequest,
    }
    impl Fixture {
        fn new(archive: bool, has_index: bool) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap().join("codex");
            let prefix = if archive {
                "archived_sessions"
            } else {
                "sessions/2026/01/05"
            };
            let locator = format!("{prefix}/rollout-2026-01-05T12-00-00-{ID}.jsonl");
            let file = root.join(&locator);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, b"owned rollout\n").unwrap();
            let index = root.join(NAME_INDEX);
            if has_index {
                fs::write(&index, b"owned index\n").unwrap();
            }
            let info = fs::metadata(&root).unwrap();
            let input = serde_json::json!({"protocolVersion":3,"nonce":"a".repeat(64),"nativeVersion":"0.153.4",
                "source":{"codexRoot":root,"rolloutPath":locator,"threadId":ID},
                "expectedRoot":{"device":info.dev().to_string(),"inode":info.ino().to_string()}});
            let request =
                crate::codex::parse_request(&serde_json::to_vec(&input).unwrap()).unwrap();
            Self {
                _temp: temp,
                root,
                file,
                index,
                request,
            }
        }
    }
    #[test]
    fn structured_capture_has_global_links_and_a_distinct_bounded_frame() {
        let mut f = Fixture::new(false, true);
        f.request.protocol_version = 9;
        let rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":ID,"cli_version":"0.153.4"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"native A 🐾"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"exec_command_begin","turn_id":"native A 🐾","call_id":"native call"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"agent_message","message":"entire original text"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"exec_command_end","turn_id":"native A 🐾","call_id":"native call"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"native A 🐾"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
        ];
        let raw = rows.iter().map(|v| format!("{v}\n")).collect::<String>();
        fs::write(&f.file, &raw).unwrap();
        for (offset, related) in [(2, Some(4)), (4, Some(2)), (7, None)] {
            let selection = jsonl_scan::Selection { offset, limit: 1 };
            let pair = capture_structured(&f.request, selection).unwrap();
            let structure = pair.structure.as_ref().unwrap();
            assert_eq!(structure.total_turns, 1);
            assert_eq!(structure.retained_turns, 0);
            assert_eq!(pair.validation.as_ref().unwrap().records_validated, 7);
            if let Some(related) = related {
                assert_eq!(
                    structure.turns[0].native_turn_id.as_deref(),
                    Some("native A 🐾")
                );
                assert_eq!(structure.turns[0].recorded_status, "completed");
                assert_eq!(structure.turns[0].rollback_record_index, Some(6));
                assert_eq!(
                    structure.annotations[0]
                        .tool
                        .as_ref()
                        .unwrap()
                        .related_record_index,
                    Some(related)
                );
                assert_eq!(
                    pair.page.records[0].bytes,
                    format!("{}\n", rows[offset as usize]).as_bytes()
                );
            } else {
                assert!(structure.turns.is_empty());
                assert!(structure.annotations.is_empty());
            }
            let request = crate::codex_scanned::Request { base: crate::codex::parse_request(&serde_json::to_vec(&serde_json::json!({
                "protocolVersion":9,"nonce":"a".repeat(64),"nativeVersion":"0.153.4",
                "source":{"codexRoot":f.root.to_str().unwrap(),"threadId":ID,"rolloutPath":f.request.source.rollout_path},
                "expectedRoot":{"device":f.request.expected_root.device,"inode":f.request.expected_root.inode}
            })).unwrap()).unwrap(), page: selection, protocol_version: 12 };
            let mut frame = Vec::new();
            crate::codex_scanned::write_frame(&mut frame, &request, Ok(pair)).unwrap();
            let header_len = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
            assert!(header_len <= 16 * 1024);
            let header: serde_json::Value =
                serde_json::from_slice(&frame[4..4 + header_len]).unwrap();
            let result = &header["result"];
            assert_eq!(header["protocolVersion"], 12);
            assert_eq!(result["kind"], "native_codex_structured_source_page");
            let payload = &frame[4 + header_len..];
            let descriptor = &result["structureFrame"];
            let split = descriptor["byteOffset"].as_u64().unwrap() as usize;
            assert_eq!(
                split,
                result["page"]["byteLength"].as_u64().unwrap() as usize
                    + result["nameIndex"]["byteLength"].as_u64().unwrap() as usize
            );
            assert_eq!(descriptor["byteLength"], payload.len() - split);
            assert_eq!(result["byteLength"], payload.len());
            assert_eq!(
                result["sha256"],
                format!("{:x}", sha2::Sha256::digest(payload))
            );
            assert_eq!(
                descriptor["sha256"],
                format!("{:x}", sha2::Sha256::digest(&payload[split..]))
            );
            let value: serde_json::Value = serde_json::from_slice(&payload[split..]).unwrap();
            assert_eq!(value["structureProfile"], codex_rollout_structure::PROFILE);
            for flag in [
                "recordSemanticsValidated",
                "semanticHistoryComplete",
                "sourceAuthenticated",
                "publishable",
            ] {
                assert_eq!(result[flag], false);
            }
        }
        assert!(
            capture_validated(
                &f.request,
                jsonl_scan::Selection {
                    offset: 0,
                    limit: 1
                }
            )
            .unwrap()
            .structure
            .is_none()
        );
        assert!(
            capture_scanned(
                &f.request,
                jsonl_scan::Selection {
                    offset: 0,
                    limit: 1
                }
            )
            .unwrap()
            .structure
            .is_none()
        );
        fs::write(&f.file, raw.replace("0.153.4", "other-writer")).unwrap();
        assert!(matches!(
            capture_structured(
                &f.request,
                jsonl_scan::Selection {
                    offset: 0,
                    limit: 1
                }
            ),
            Err(Error::RolloutStructure)
        ));
        // Envelope-only remains intentionally different from structure semantics.
        assert!(
            capture_validated(
                &f.request,
                jsonl_scan::Selection {
                    offset: 0,
                    limit: 1
                }
            )
            .is_ok()
        );
    }
    #[test]
    fn structured_capture_keeps_permission_selection_and_index_fences_on_each_pass() {
        for point in [Point::Opened, Point::FirstRead, Point::SecondRead] {
            for mutation in 0..4 {
                let mut f = Fixture::new(false, true);
                f.request.protocol_version = 9;
                let raw = format!(
                    "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\",\"cli_version\":\"0.153.4\"}}}}\n"
                );
                fs::write(&f.file, &raw).unwrap();
                let result = capture_scanned_mode(
                    &f.request,
                    jsonl_scan::Selection {
                        offset: 0,
                        limit: 1,
                    },
                    PageMode::Structured,
                    &mut |at| {
                        if at == point {
                            match mutation {
                                0 => fs::write(&f.file, format!("{raw}\n")).unwrap(),
                                1 => {
                                    fs::set_permissions(&f.file, fs::Permissions::from_mode(0o644))
                                        .unwrap()
                                }
                                2 => {
                                    let replacement = f.root.join("owned-new-index");
                                    fs::write(&replacement, b"owned index\n").unwrap();
                                    fs::rename(&replacement, &f.index).unwrap();
                                }
                                _ => {
                                    let replacement = f.root.join("owned-new-rollout");
                                    fs::write(&replacement, &raw).unwrap();
                                    fs::set_permissions(
                                        &replacement,
                                        fs::Permissions::from_mode(0o600),
                                    )
                                    .unwrap();
                                    fs::rename(&replacement, &f.file).unwrap();
                                }
                            }
                        }
                    },
                );
                assert!(matches!(result, Err(Error::Changed | Error::OwnerOrMode)));
            }
        }
    }
    #[test]
    fn validated_capture_observes_every_record_and_never_upgrades_opaque_bytes() {
        let mut f = Fixture::new(false, true);
        f.request.protocol_version = 9;
        let selection = jsonl_scan::Selection {
            offset: 0,
            limit: 1,
        };
        assert!(matches!(
            capture_validated(&f.request, selection),
            Err(Error::RolloutFormat(
                codex_rollout_format::Error::InvalidRecord
            ))
        ));
        let mut raw =
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\"}}}}\n").into_bytes();
        for _ in 0..1000 {
            raw.extend_from_slice(b"{\"type\":\"event_msg\"}\n");
        }
        fs::write(&f.file, &raw).unwrap();
        let pair = capture_validated(&f.request, selection).unwrap();
        assert_eq!(pair.page.records.len(), 1);
        assert_eq!(pair.validation.unwrap().records_validated, 1001);
        assert!(
            capture_scanned(&f.request, selection)
                .unwrap()
                .validation
                .is_none()
        );
        raw.extend_from_slice(b"{\"type\":\"session_meta\",\"payload\":null}\n");
        fs::write(&f.file, &raw).unwrap();
        assert!(matches!(
            capture_validated(&f.request, selection),
            Err(Error::RolloutFormat(
                codex_rollout_format::Error::InvalidMetadata
            ))
        ));
        assert!(capture_scanned(&f.request, selection).is_ok());
    }
    #[test]
    fn validated_capture_keeps_before_between_after_permissions_and_name_fences() {
        for point in [Point::Opened, Point::FirstRead, Point::SecondRead] {
            for mutation in 0..3 {
                let mut f = Fixture::new(false, true);
                f.request.protocol_version = 9;
                let raw =
                    format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\"}}}}\n");
                fs::write(&f.file, &raw).unwrap();
                let result = capture_scanned_mode(
                    &f.request,
                    jsonl_scan::Selection {
                        offset: 0,
                        limit: 1,
                    },
                    PageMode::Validated,
                    &mut |at| {
                        if at == point {
                            match mutation {
                                0 => fs::write(&f.file, format!("{raw}\n")).unwrap(),
                                1 => {
                                    fs::set_permissions(&f.file, fs::Permissions::from_mode(0o644))
                                        .unwrap()
                                }
                                _ => {
                                    let replacement = f.root.join("owned-new-index");
                                    fs::write(&replacement, b"owned index\n").unwrap();
                                    fs::rename(&replacement, &f.index).unwrap();
                                }
                            }
                        }
                    },
                );
                assert!(matches!(result, Err(Error::Changed | Error::OwnerOrMode)));
            }
        }
    }
    #[test]
    fn stored_capture_resolves_both_selectors_with_plain_priority_without_decoding() {
        for archive in [false, true] {
            let mut f = Fixture::new(archive, true);
            f.request.protocol_version = 9;
            let compressed = f.file.with_extension("jsonl.zst");
            fs::write(&compressed, b"owned encoded bytes").unwrap();
            let plain = capture(&f.request).unwrap();
            assert_eq!(plain.rollout.bytes, b"owned rollout\n");
            assert!(!plain.physical_path.ends_with(".zst"));
            f.request.source.rollout_path.push_str(".zst");
            assert_eq!(
                capture(&f.request).unwrap().rollout.bytes,
                b"owned rollout\n"
            );
            fs::remove_file(&f.file).unwrap();
            let stored = capture(&f.request).unwrap();
            assert_eq!(stored.rollout.bytes, b"owned encoded bytes");
            assert!(stored.physical_path.ends_with(".zst"));
            f.request
                .source
                .rollout_path
                .truncate(f.request.source.rollout_path.len() - 4);
            assert_eq!(
                capture(&f.request).unwrap().rollout.bytes,
                b"owned encoded bytes"
            );
            let mut frame = Vec::new();
            crate::codex::write_frame(&mut frame, &f.request, Ok(stored)).unwrap();
            let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
            let header: serde_json::Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
            assert_eq!(header["protocolVersion"], 9);
            assert_eq!(header["result"]["storage"]["encoding"], "zstd");
            assert_eq!(
                header["result"]["checks"]["rolloutSelectionRechecked"],
                true
            );
        }
    }

    fn page(offset: u32) -> jsonl_scan::Selection {
        jsonl_scan::Selection { offset, limit: 2 }
    }
    #[test]
    fn scanned_pages_preserve_bytes_index_presence_and_explicit_digest_checks() {
        use sha2::{Digest, Sha256};
        for archive in [false, true] {
            for has_index in [false, true] {
                let mut f = Fixture::new(archive, has_index);
                f.request.protocol_version = 9;
                let bytes = "第一筆🐾\r\n \r\n第三筆\n".as_bytes();
                fs::write(&f.file, bytes).unwrap();
                let first = capture_scanned(&f.request, page(0)).unwrap();
                assert_eq!(first.page.summary.record_count, 3);
                assert_eq!(first.page.summary.byte_length, bytes.len() as u64);
                assert_eq!(
                    first.page.summary.sha256,
                    <[u8; 32]>::from(Sha256::digest(bytes))
                );
                assert_eq!(first.page.next_offset, Some(2));
                assert_eq!(first.name_index.is_some(), has_index);
                let last = capture_scanned(&f.request, page(2)).unwrap();
                assert_eq!(first.page.summary, last.page.summary);
                assert_eq!(last.page.records[0].bytes, "第三筆\n".as_bytes());
                assert_eq!(last.page.next_offset, None);
                assert!(
                    capture_scanned(&f.request, page(3))
                        .unwrap()
                        .page
                        .records
                        .is_empty()
                );
                assert!(matches!(
                    capture_scanned(&f.request, page(4)),
                    Err(Error::Input)
                ));
                fs::write(&f.index, b"").unwrap();
                assert!(
                    capture_scanned(&f.request, page(0))
                        .unwrap()
                        .name_index
                        .unwrap()
                        .bytes
                        .is_empty()
                );
                f.request.source.rollout_path.push_str(".zst");
                assert!(
                    !capture_scanned(&f.request, page(0))
                        .unwrap()
                        .physical_path
                        .ends_with(".zst")
                );
                fs::rename(&f.file, f.file.with_extension("jsonl.zst")).unwrap();
                assert!(matches!(
                    capture_scanned(&f.request, page(0)),
                    Err(Error::EncodingUnsupported)
                ));
            }
        }
    }

    #[test]
    fn scanned_capture_exceeds_the_old_whole_buffer_limit_without_changing_legacy() {
        use std::io::Write;
        let f = Fixture::new(false, true);
        let mut line = vec![b'a'; 1024];
        line[1023] = b'\n';
        let mut writer = fs::File::create(&f.file).unwrap();
        for _ in 0..10_000 {
            writer.write_all(&line).unwrap();
        }
        drop(writer);
        assert!(matches!(capture(&f.request), Err(Error::TooLarge)));
        let result = capture_scanned(&f.request, page(9998)).unwrap();
        assert_eq!(result.rollout_identity.size, 10_240_000);
        assert_eq!(result.page.summary.record_count, 10_000);
        assert_eq!(result.page.records.len(), 2);
        assert_eq!(result.page.records[0].byte_offset, 9998 * 1024);
        assert_eq!(
            result
                .page
                .records
                .iter()
                .map(|r| r.bytes.len())
                .sum::<usize>(),
            2048
        );
    }

    #[test]
    fn scanned_source_bound_tail_and_count_fail_without_partial_pages() {
        let f = Fixture::new(false, true);
        fs::write(&f.file, b"ok\npartial").unwrap();
        assert!(matches!(
            capture_scanned(&f.request, page(0)),
            Err(Error::IncompleteTail)
        ));
        fs::write(&f.file, vec![b'\n'; jsonl_scan::RECORDS as usize + 1]).unwrap();
        assert!(matches!(
            capture_scanned(&f.request, page(0)),
            Err(Error::RecordLimit)
        ));
        fs::write(
            &f.file,
            [vec![b'a'; jsonl_scan::RECORD_BYTES], vec![b'\n']].concat(),
        )
        .unwrap();
        assert!(matches!(
            capture_scanned(&f.request, page(0)),
            Err(Error::RecordLimit)
        ));
        fs::OpenOptions::new()
            .write(true)
            .open(&f.file)
            .unwrap()
            .set_len(jsonl_scan::SOURCE_BYTES + 1)
            .unwrap();
        assert!(matches!(
            capture_scanned(&f.request, page(0)),
            Err(Error::TooLarge)
        ));
    }

    #[test]
    fn scanned_source_rechecks_files_index_presence_and_all_name_edges() {
        for point in [Point::Opened, Point::FirstRead, Point::SecondRead] {
            for mode in 0..7 {
                let f = Fixture::new(false, mode != 2);
                let result = capture_scanned_with(&f.request, page(0), |at| {
                    if at != point {
                        return;
                    }
                    match mode {
                        0 => fs::write(&f.file, b"changed rollout\n").unwrap(),
                        1 => fs::write(&f.index, b"changed index\n").unwrap(),
                        2 => fs::write(&f.index, b"new index\n").unwrap(),
                        3 => fs::remove_file(&f.index).unwrap(),
                        4 => {
                            fs::rename(&f.file, f.root.join("moved-rollout")).unwrap();
                            fs::write(&f.file, b"owned rollout\n").unwrap();
                        }
                        5 => {
                            fs::rename(f.root.join("sessions"), f.root.join("moved")).unwrap();
                            fs::create_dir(f.root.join("sessions")).unwrap();
                        }
                        _ => {
                            let other = f.root.join("replacement");
                            fs::write(&other, b"owned index\n").unwrap();
                            fs::rename(other, &f.index).unwrap();
                        }
                    }
                });
                assert!(matches!(result, Err(Error::Changed)), "mode={mode}");
            }
        }
    }

    #[test]
    fn scanned_source_preserves_acl_and_mode_rejection_before_between_and_after_scans() {
        for point in [Point::Opened, Point::FirstRead, Point::SecondRead] {
            for component in 0..7 {
                for acl in [false, true] {
                    let f = Fixture::new(false, true);
                    let paths = [
                        f.root.clone(),
                        f.root.join("sessions"),
                        f.root.join("sessions/2026"),
                        f.root.join("sessions/2026/01"),
                        f.root.join("sessions/2026/01/05"),
                        f.file.clone(),
                        f.index.clone(),
                    ];
                    let result = capture_scanned_with(&f.request, page(0), |at| {
                        if at == point {
                            if acl {
                                super::super::tests::add_acl(&paths[component], false);
                            } else {
                                fs::set_permissions(
                                    &paths[component],
                                    fs::Permissions::from_mode(0o770),
                                )
                                .unwrap();
                            }
                        }
                    });
                    assert!(matches!(
                        result,
                        Err(Error::OwnerOrMode | Error::AclUnsupported)
                    ));
                }
            }
        }
    }

    #[test]
    fn scanned_source_rejects_root_substitution_and_unsafe_selected_objects() {
        let mut f = Fixture::new(false, true);
        f.request.expected_root.inode = "1".into();
        assert!(matches!(
            capture_scanned(&f.request, page(0)),
            Err(Error::RootIdentityChanged)
        ));
        for index in [false, true] {
            for mode in ["symlink", "directory", "fifo", "hardlink"] {
                let f = Fixture::new(false, true);
                let target = if index { &f.index } else { &f.file };
                if mode == "hardlink" {
                    fs::hard_link(target, f.root.join("other")).unwrap();
                } else {
                    fs::remove_file(target).unwrap();
                    match mode {
                        "symlink" => symlink(f.root.join("missing"), target).unwrap(),
                        "directory" => fs::create_dir(target).unwrap(),
                        _ => {
                            let path = CString::new(target.to_str().unwrap()).unwrap();
                            // SAFETY: fresh, owned missing fixture path with valid CString.
                            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
                        }
                    }
                }
                assert!(matches!(
                    capture_scanned(&f.request, page(0)),
                    Err(Error::NotRegular | Error::Hardlinked)
                ));
            }
        }
    }
    #[test]
    fn stored_fallback_never_bypasses_unsafe_plain_or_compressed_objects() {
        for mode in ["symlink", "directory", "hardlink", "mode", "empty"] {
            for compressed_only in [false, true] {
                let mut f = Fixture::new(false, true);
                f.request.protocol_version = 9;
                let compressed = f.file.with_extension("jsonl.zst");
                fs::write(&compressed, b"encoded").unwrap();
                let target = if compressed_only {
                    fs::remove_file(&f.file).unwrap();
                    &compressed
                } else {
                    &f.file
                };
                match mode {
                    "symlink" => {
                        fs::remove_file(target).unwrap();
                        symlink(&f.index, target).unwrap();
                    }
                    "directory" => {
                        fs::remove_file(target).unwrap();
                        fs::create_dir(target).unwrap();
                    }
                    "hardlink" => fs::hard_link(target, f.root.join("owned-link")).unwrap(),
                    "mode" => {
                        fs::set_permissions(target, fs::Permissions::from_mode(0o666)).unwrap()
                    }
                    _ => fs::write(target, b"").unwrap(),
                }
                assert!(
                    capture(&f.request).is_err(),
                    "{mode} compressed={compressed_only}"
                );
            }
        }
    }
    #[test]
    fn stored_selection_appearance_replacement_and_bytes_are_fenced_at_each_read() {
        for point in [Point::Opened, Point::FirstRead, Point::SecondRead] {
            for change in ["plain_appears", "compressed_replaced", "compressed_changed"] {
                let mut f = Fixture::new(false, true);
                f.request.protocol_version = 9;
                let compressed = f.file.with_extension("jsonl.zst");
                fs::rename(&f.file, &compressed).unwrap();
                let result = capture_with(&f.request, |at| {
                    if at != point {
                        return;
                    }
                    match change {
                        "plain_appears" => fs::write(&f.file, b"owned rollout\n").unwrap(),
                        "compressed_replaced" => {
                            fs::remove_file(&compressed).unwrap();
                            fs::write(&compressed, b"owned rollout\n").unwrap();
                        }
                        _ => fs::write(&compressed, b"different bytes\n").unwrap(),
                    }
                });
                assert!(result.is_err(), "{change}");
            }
        }
    }
    #[test]
    fn selected_active_archive_and_missing_empty_index_are_distinct() {
        for archive in [false, true] {
            for has_index in [false, true] {
                let f = Fixture::new(archive, has_index);
                let got = capture(&f.request).unwrap();
                assert_eq!(got.rollout.bytes, b"owned rollout\n");
                assert_eq!(got.name_index.is_some(), has_index);
                if has_index {
                    assert_eq!(got.name_index.unwrap().bytes, b"owned index\n");
                }
                fs::write(&f.index, []).unwrap();
                let got = capture(&f.request).unwrap();
                assert!(got.name_index.unwrap().bytes.is_empty());
                assert_eq!(fs::read(&f.file).unwrap(), b"owned rollout\n");
            }
        }
    }
    #[test]
    fn root_binding_symlink_hardlink_and_modes_fail_without_read_fallback() {
        let mut f = Fixture::new(false, true);
        f.request.expected_root.inode = "1".into();
        assert!(matches!(
            capture(&f.request),
            Err(Error::RootIdentityChanged)
        ));
        for index in [false, true] {
            let f = Fixture::new(false, true);
            let selected = if index { &f.index } else { &f.file };
            fs::set_permissions(selected, fs::Permissions::from_mode(0o660)).unwrap();
            assert!(matches!(capture(&f.request), Err(Error::OwnerOrMode)));
            fs::set_permissions(selected, fs::Permissions::from_mode(0o600)).unwrap();
            let other = f.root.join("outside-owned");
            fs::hard_link(selected, &other).unwrap();
            assert!(matches!(capture(&f.request), Err(Error::Hardlinked)));
            fs::remove_file(&other).unwrap();
            fs::rename(selected, &other).unwrap();
            symlink(&other, selected).unwrap();
            assert!(matches!(capture(&f.request), Err(Error::NotRegular)));
        }
    }
    #[test]
    fn either_file_change_or_absence_change_invalidates_the_pair() {
        for point in [Point::Opened, Point::FirstRead, Point::SecondRead] {
            for mode in 0..5 {
                let f = Fixture::new(false, mode != 2);
                let result = capture_with(&f.request, |at| {
                    if at == point {
                        match mode {
                            0 => fs::write(&f.file, b"changed rollout\n").unwrap(),
                            1 => fs::write(&f.index, b"changed index\n").unwrap(),
                            2 => fs::write(&f.index, b"new index\n").unwrap(),
                            3 => fs::remove_file(&f.index).unwrap(),
                            _ => {
                                let other = f.root.join("replacement");
                                fs::write(&other, b"owned index\n").unwrap();
                                fs::rename(other, &f.index).unwrap();
                            }
                        }
                    }
                });
                assert!(matches!(result, Err(Error::Changed)), "mode {mode}");
            }
        }
    }
    #[test]
    fn directory_replacement_file_bounds_and_compressed_format_are_explicit() {
        let mut f = Fixture::new(false, true);
        f.request.source.rollout_path.push_str(".zst");
        assert!(matches!(
            capture(&f.request),
            Err(Error::EncodingUnsupported)
        ));
        f.request
            .source
            .rollout_path
            .truncate(f.request.source.rollout_path.len() - 4);
        fs::OpenOptions::new()
            .write(true)
            .open(&f.file)
            .unwrap()
            .set_len((SOURCE_LIMIT + 1) as u64)
            .unwrap();
        assert!(matches!(capture(&f.request), Err(Error::TooLarge)));
        fs::write(&f.file, []).unwrap();
        assert!(matches!(capture(&f.request), Err(Error::Empty)));
        fs::write(&f.file, b"owned rollout\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&f.index)
            .unwrap()
            .set_len((INDEX_LIMIT + 1) as u64)
            .unwrap();
        assert!(matches!(capture(&f.request), Err(Error::TooLarge)));
        let f = Fixture::new(false, true);
        let result = capture_with(&f.request, |at| {
            if at == Point::SecondRead {
                fs::rename(f.root.join("sessions"), f.root.join("moved")).unwrap();
                fs::create_dir(f.root.join("sessions")).unwrap();
            }
        });
        assert!(matches!(result, Err(Error::Changed)));
    }

    #[test]
    fn every_selected_descriptor_checks_acl_and_directory_mode() {
        for component in 0..7 {
            let f = Fixture::new(false, true);
            let paths = [
                f.root.clone(),
                f.root.join("sessions"),
                f.root.join("sessions/2026"),
                f.root.join("sessions/2026/01"),
                f.root.join("sessions/2026/01/05"),
                f.file.clone(),
                f.index.clone(),
            ];
            super::super::tests::add_acl(&paths[component], false);
            assert!(matches!(capture(&f.request), Err(Error::AclUnsupported)));
        }
        for component in 0..5 {
            let f = Fixture::new(false, true);
            let paths = [
                f.root.clone(),
                f.root.join("sessions"),
                f.root.join("sessions/2026"),
                f.root.join("sessions/2026/01"),
                f.root.join("sessions/2026/01/05"),
            ];
            fs::set_permissions(&paths[component], fs::Permissions::from_mode(0o770)).unwrap();
            assert!(matches!(capture(&f.request), Err(Error::OwnerOrMode)));
        }
        let f = Fixture::new(false, true);
        let changed = capture_with(&f.request, |at| {
            if at == Point::FirstRead {
                super::super::tests::add_acl(&f.index, false);
            }
        });
        assert!(matches!(changed, Err(Error::AclUnsupported)));
    }

    #[test]
    fn index_fifo_and_directory_never_become_absent_or_block() {
        let f = Fixture::new(false, true);
        fs::remove_file(&f.index).unwrap();
        let name = CString::new(f.index.to_str().unwrap()).unwrap();
        // SAFETY: test-owned missing pathname, live NUL-terminated string.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(matches!(capture(&f.request), Err(Error::NotRegular)));
        fs::remove_file(&f.index).unwrap();
        fs::create_dir(&f.index).unwrap();
        assert!(matches!(capture(&f.request), Err(Error::NotRegular)));
    }
}
