//! Windows source capture remains deliberately unsupported.
//!
//! The tests below exercise actual handle-relative opens, owner SID and DACL
//! inspection on newly created fixtures. They do not enable a reader, establish
//! native provenance, audit every Windows privilege or turn path checks into
//! atomic containment. No probe accepts public request paths or prints SIDs.

#[cfg(windows)]
pub fn capture(_request: &crate::Request) -> Result<crate::Capture, crate::Error> {
    Err(crate::Error::PlatformUnsupported)
}

#[cfg(test)]
mod policy {
    // File/directory mutation, metadata/ACL takeover and generic write/all.
    // FILE_DELETE_CHILD matters even if the child's own DACL denies deletion.
    const MUTATION: u32 = 0x0000_0002
        | 0x0000_0004
        | 0x0000_0010
        | 0x0000_0040
        | 0x0000_0100
        | 0x0001_0000
        | 0x0004_0000
        | 0x0008_0000
        | 0x4000_0000
        | 0x1000_0000;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Principal {
        Owner,
        System,
        Administrators,
        Other,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Kind {
        Allow,
        Deny,
        Unknown,
    }
    #[derive(Clone, Copy, Debug)]
    pub(super) struct Ace {
        pub kind: Kind,
        pub principal: Principal,
        pub mask: u32,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Rejected {
        OwnerMismatch,
        MissingDacl,
        UnreviewedAcl,
        UntrustedWriter,
    }

    pub(super) fn check(owner_matches: bool, dacl: Option<&[Ace]>) -> Result<(), Rejected> {
        if !owner_matches {
            return Err(Rejected::OwnerMismatch);
        }
        let entries = dacl.ok_or(Rejected::MissingDacl)?;
        if entries.len() > 1024 {
            return Err(Rejected::UnreviewedAcl);
        }
        for ace in entries {
            match ace.kind {
                Kind::Unknown => return Err(Rejected::UnreviewedAcl),
                Kind::Allow if ace.principal == Principal::Other && ace.mask & MUTATION != 0 => {
                    return Err(Rejected::UntrustedWriter);
                }
                _ => {}
            }
        }
        // SYSTEM/Administrators are explicitly trusted privileged principals.
        // This is a conservative allow-ACE policy, NOT an AccessCheck emulator:
        // deny ordering never rescues an otherwise untrusted mutation grant,
        // and inherited/inherit-only allow ACEs are conservatively included.
        Ok(())
    }

    #[test]
    fn owner_and_privileged_writers_are_distinct_from_other_identities() {
        for principal in [
            Principal::Owner,
            Principal::System,
            Principal::Administrators,
        ] {
            assert_eq!(
                check(
                    true,
                    Some(&[Ace {
                        kind: Kind::Allow,
                        principal,
                        mask: u32::MAX
                    }])
                ),
                Ok(())
            );
        }
        assert_eq!(
            check(
                true,
                Some(&[Ace {
                    kind: Kind::Allow,
                    principal: Principal::Other,
                    mask: 0x8000_0089
                }])
            ),
            Ok(())
        );
        for bit in [
            0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000,
        ] {
            assert_eq!(
                check(
                    true,
                    Some(&[Ace {
                        kind: Kind::Allow,
                        principal: Principal::Other,
                        mask: bit
                    }])
                ),
                Err(Rejected::UntrustedWriter)
            );
        }
    }

    #[test]
    fn null_unknown_and_foreign_owner_fail_closed_even_if_caller_can_read() {
        assert_eq!(check(true, None), Err(Rejected::MissingDacl));
        assert_eq!(check(false, Some(&[])), Err(Rejected::OwnerMismatch));
        assert_eq!(
            check(
                true,
                Some(&[Ace {
                    kind: Kind::Unknown,
                    principal: Principal::Owner,
                    mask: 0
                }])
            ),
            Err(Rejected::UnreviewedAcl)
        );
        let denied_then_allowed = [
            Ace {
                kind: Kind::Deny,
                principal: Principal::Other,
                mask: u32::MAX,
            },
            Ace {
                kind: Kind::Allow,
                principal: Principal::Other,
                mask: 0x2,
            },
        ];
        assert_eq!(
            check(true, Some(&denied_then_allowed)),
            Err(Rejected::UntrustedWriter)
        );
        assert_eq!(
            check(
                true,
                Some(&vec![
                    Ace {
                        kind: Kind::Deny,
                        principal: Principal::Other,
                        mask: 0
                    };
                    1025
                ])
            ),
            Err(Rejected::UnreviewedAcl)
        );
    }
}

#[cfg(all(windows, test))]
mod owned_windows_probe {
    use super::policy::{self, Ace, Kind, Principal};
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
        ptr::{null, null_mut},
    };
    use windows_sys::Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
            FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
        },
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, HANDLE, INVALID_HANDLE_VALUE, LocalFree, OBJ_CASE_INSENSITIVE,
            OBJ_DONT_REPARSE, UNICODE_STRING,
        },
        Security::{
            ACE_HEADER, ACL,
            Authorization::{
                EXPLICIT_ACCESS_W, GetSecurityInfo, SE_FILE_OBJECT, SET_ACCESS, SetEntriesInAclW,
                SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
            },
            CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetLengthSid,
            GetSecurityDescriptorDacl, GetTokenInformation, IsValidAcl, IsValidSid,
            OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID, TOKEN_QUERY,
            TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid, WinWorldSid,
        },
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
            FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, FILE_STANDARD_INFO, FILE_TYPE_DISK, FileAttributeTagInfo, FileIdInfo,
            FileStandardInfo, GetFileInformationByHandleEx, GetFileType, OPEN_EXISTING,
            READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
        },
        System::{
            IO::IO_STATUS_BLOCK,
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };

    #[derive(Debug, PartialEq, Eq)]
    enum ProbeError {
        Open,
        Metadata,
        Security,
        Reparse,
        WrongType,
        Hardlink,
        RootMismatch,
        Component,
        Policy(policy::Rejected),
    }
    type Result<T> = std::result::Result<T, ProbeError>;

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: This wrapper owns the successful open's handle exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct LocalAllocation(*mut c_void);
    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            // SAFETY: Win32 allocated this pointer with LocalAlloc (or it is null).
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    #[derive(Clone)]
    struct Sid {
        words: Vec<u32>,
    }
    impl Sid {
        fn pointer(&self) -> PSID {
            self.words.as_ptr().cast_mut().cast()
        }
        unsafe fn copy(pointer: PSID) -> Result<Self> {
            // SAFETY: Caller supplies a SID inside an OS-owned token buffer that
            // remains live until this bounded copy completes.
            if pointer.is_null() || unsafe { IsValidSid(pointer) } == 0 {
                return Err(ProbeError::Security);
            }
            // SAFETY: The SID has just been validated in the caller's live buffer.
            let length = unsafe { GetLengthSid(pointer) } as usize;
            if !(8..=68).contains(&length) {
                return Err(ProbeError::Security);
            }
            let mut words = vec![0u32; length.div_ceil(4)];
            // SAFETY: Validated SID length fits the separate aligned destination.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    pointer.cast::<u8>(),
                    words.as_mut_ptr().cast::<u8>(),
                    length,
                );
            }
            Ok(Self { words })
        }
        fn known(kind: i32) -> Result<Self> {
            let mut words = vec![0u32; 17];
            let mut length = 68;
            // SAFETY: The aligned output buffer holds SECURITY_MAX_SID_SIZE bytes.
            if unsafe {
                CreateWellKnownSid(kind, null_mut(), words.as_mut_ptr().cast(), &mut length)
            } == 0
            {
                return Err(ProbeError::Security);
            }
            Ok(Self { words })
        }
        fn current_user() -> Result<Self> {
            let mut raw = null_mut();
            // SAFETY: Pseudo-process handle and writable handle out-parameter are valid.
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
                return Err(ProbeError::Security);
            }
            let token = OwnedHandle(raw);
            let mut length = 0;
            // SAFETY: A null zero-size buffer intentionally queries the required size.
            unsafe {
                GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length);
            }
            if length < size_of::<TOKEN_USER>() as u32 || length > 16384 {
                return Err(ProbeError::Security);
            }
            // Token structures contain pointers; use naturally aligned storage.
            let mut storage = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
            // SAFETY: The token is live; aligned allocation covers the bounded size.
            if unsafe {
                GetTokenInformation(
                    token.0,
                    TokenUser,
                    storage.as_mut_ptr().cast(),
                    length,
                    &mut length,
                )
            } == 0
            {
                return Err(ProbeError::Security);
            }
            // SAFETY: Successful TokenUser populated this aligned allocation; copy
            // finishes while both its structure and contained SID remain live.
            unsafe { Self::copy((*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid) }
        }
        fn equals(&self, other: PSID) -> bool {
            // SAFETY: Callers pass an OS-returned SID after IsValidSid; self is owned.
            unsafe { EqualSid(self.pointer(), other) != 0 }
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Identity {
        volume: u64,
        file: [u8; 16],
    }
    struct TrustedFixtureRoot {
        handle: OwnedHandle,
        expected: Identity,
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    fn open_fixture_path(path: &Path, writable_security: bool) -> Result<OwnedHandle> {
        // Fixture-only bootstrap. This is NOT a general canonical-root resolver;
        // all callers below pass paths created in Fixture::new(). Capture never
        // invokes it, and no public CLI/API exposes an arbitrary-path probe.
        let access = FILE_READ_ATTRIBUTES
            | READ_CONTROL
            | if writable_security {
                WRITE_DAC | WRITE_OWNER
            } else {
                0
            };
        // SAFETY: UTF-16 string is terminated and live for the synchronous call;
        // all optional pointers are null and access is limited to owned fixtures.
        let raw = unsafe {
            CreateFileW(
                wide(path).as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            Err(ProbeError::Open)
        } else {
            Ok(OwnedHandle(raw))
        }
    }
    fn information<T>(handle: HANDLE, class: i32) -> Result<T> {
        // SAFETY: Private call sites use only zero-valid Win32 FILE_*_INFO POD
        // structures, paired with their exact information classes.
        let mut value: T = unsafe { zeroed() };
        // SAFETY: Live handle and correctly sized/aligned POD output as above.
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                class,
                (&mut value as *mut T).cast(),
                size_of::<T>() as u32,
            )
        } == 0
        {
            return Err(ProbeError::Metadata);
        }
        Ok(value)
    }
    fn identity(handle: HANDLE) -> Result<Identity> {
        let value: FILE_ID_INFO = information(handle, FileIdInfo)?;
        if value.FileId.Identifier == [0; 16] {
            return Err(ProbeError::Metadata);
        }
        Ok(Identity {
            volume: value.VolumeSerialNumber,
            file: value.FileId.Identifier,
        })
    }
    fn audit(handle: HANDLE, directory: bool, user: &Sid) -> Result<Identity> {
        // SAFETY: Handle belongs to a live OwnedHandle in all callers.
        if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
            return Err(ProbeError::WrongType);
        }
        let tags: FILE_ATTRIBUTE_TAG_INFO = information(handle, FileAttributeTagInfo)?;
        if tags.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || tags.ReparseTag != 0 {
            return Err(ProbeError::Reparse);
        }
        let standard: FILE_STANDARD_INFO = information(handle, FileStandardInfo)?;
        if standard.Directory != directory || standard.DeletePending {
            return Err(ProbeError::WrongType);
        }
        if !directory && standard.NumberOfLinks != 1 {
            return Err(ProbeError::Hardlink);
        }
        security(handle, user)?;
        identity(handle)
    }
    fn security(handle: HANDLE, user: &Sid) -> Result<()> {
        let mut owner = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: Live handle and initialized writable out-pointers; API allocates
        // one descriptor containing the returned owner/DACL pointers.
        if unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        } != 0
            || descriptor.is_null()
        {
            return Err(ProbeError::Security);
        }
        let _allocation = LocalAllocation(descriptor);
        // SAFETY: Non-null owner belongs to the still-live OS descriptor allocation.
        if owner.is_null() || unsafe { IsValidSid(owner) } == 0 {
            return Err(ProbeError::Security);
        }
        if !user.equals(owner) {
            return Err(ProbeError::Policy(policy::Rejected::OwnerMismatch));
        }
        let mut present = 0;
        let mut defaulted = 0;
        // SAFETY: OS-produced descriptor remains live; outputs are writable.
        if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
            == 0
        {
            return Err(ProbeError::Security);
        }
        if present == 0 || dacl.is_null() {
            return Err(ProbeError::Policy(policy::Rejected::MissingDacl));
        }
        // SAFETY: Non-null DACL pointer belongs to the still-live descriptor.
        if unsafe { IsValidAcl(dacl) } == 0 {
            return Err(ProbeError::Security);
        }
        // SAFETY: IsValidAcl validated this OS-owned ACL's header and entries.
        let header = unsafe { &*dacl };
        if header.AceCount > 1024 {
            return Err(ProbeError::Policy(policy::Rejected::UnreviewedAcl));
        }
        let system = Sid::known(WinLocalSystemSid)?;
        let administrators = Sid::known(WinBuiltinAdministratorsSid)?;
        let mut entries = Vec::with_capacity(header.AceCount as usize);
        for index in 0..header.AceCount {
            let mut raw = null_mut();
            // SAFETY: Valid ACL, bounded index below AceCount and writable output.
            if unsafe { GetAce(dacl, index as u32, &mut raw) } == 0 || raw.is_null() {
                return Err(ProbeError::Security);
            }
            let start = dacl as usize;
            let end = start
                .checked_add(header.AclSize as usize)
                .ok_or(ProbeError::Security)?;
            let address = raw as usize;
            if address < start + size_of::<ACL>()
                || address
                    .checked_add(size_of::<ACE_HEADER>())
                    .is_none_or(|n| n > end)
            {
                return Err(ProbeError::Security);
            }
            // SAFETY: Header fits the valid ACL allocation; use unaligned read so
            // pointer alignment is not assumed beyond the OS-returned byte range.
            let ace = unsafe { std::ptr::read_unaligned(raw.cast::<ACE_HEADER>()) };
            if address
                .checked_add(ace.AceSize as usize)
                .is_none_or(|n| n > end)
            {
                return Err(ProbeError::Security);
            }
            // Only the simple access-allowed/denied ACE layouts are reviewed.
            // Object/callback/conditional and all future ACEs fail closed.
            let kind = match ace.AceType {
                0 => Kind::Allow,
                1 => Kind::Deny,
                _ => Kind::Unknown,
            };
            if kind == Kind::Unknown {
                return Err(ProbeError::Policy(policy::Rejected::UnreviewedAcl));
            }
            let bytes = raw.cast::<u8>();
            if ace.AceSize < 16 {
                return Err(ProbeError::Security);
            }
            // SAFETY: The complete ACE fits the ACL and AceSize is at least 16.
            let sid_length = 8 + unsafe { *bytes.add(9) as usize } * 4;
            if sid_length > 68 || 8 + sid_length > ace.AceSize as usize {
                return Err(ProbeError::Security);
            }
            // SAFETY: The SID prefix and full declared length fit the ACE.
            let sid = unsafe { bytes.add(8).cast::<c_void>() };
            // SAFETY: SID length was checked against the containing allocation.
            if unsafe { IsValidSid(sid) } == 0 {
                return Err(ProbeError::Security);
            }
            let principal = if user.equals(sid) {
                Principal::Owner
            } else if system.equals(sid) {
                Principal::System
            } else if administrators.equals(sid) {
                Principal::Administrators
            } else {
                Principal::Other
            };
            // SAFETY: Four-byte mask is inside this validated simple ACE layout.
            let mask = unsafe { std::ptr::read_unaligned(bytes.add(4).cast::<u32>()) };
            entries.push(Ace {
                kind,
                principal,
                mask,
            });
        }
        policy::check(true, Some(&entries)).map_err(ProbeError::Policy)
    }
    fn relative(parent: &OwnedHandle, component: &str, directory: bool) -> Result<OwnedHandle> {
        if component.is_empty()
            || component.len() > 255
            || component.starts_with('.')
            || component.ends_with('.')
            || !component
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(ProbeError::Component);
        }
        let mut name: Vec<u16> = component.encode_utf16().collect();
        let text = UNICODE_STRING {
            Length: (name.len() * 2) as u16,
            MaximumLength: (name.len() * 2) as u16,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: parent.0,
            ObjectName: &text,
            Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut raw = null_mut();
        // SAFETY: IO_STATUS_BLOCK's raw union/scalar representation accepts zero.
        let mut status: IO_STATUS_BLOCK = unsafe { zeroed() };
        let options = FILE_OPEN_REPARSE_POINT
            | FILE_SYNCHRONOUS_IO_NONALERT
            | if directory {
                FILE_DIRECTORY_FILE
            } else {
                FILE_NON_DIRECTORY_FILE
            };
        // SAFETY: Root handle, one-component UTF-16 buffer and all output storage
        // remain live for this synchronous, non-creating relative open.
        let result = unsafe {
            NtCreateFile(
                &mut raw,
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
                &attributes,
                &mut status,
                null(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_OPEN,
                options,
                null(),
                0,
            )
        };
        if result < 0 || raw.is_null() {
            return Err(ProbeError::Open);
        }
        Ok(OwnedHandle(raw))
    }
    fn probe(root: &TrustedFixtureRoot, user: &Sid) -> Result<()> {
        if audit(root.handle.0, true, user)? != root.expected {
            return Err(ProbeError::RootMismatch);
        }
        let project = relative(&root.handle, "-fixture", true)?;
        audit(project.0, true, user)?;
        let file = relative(
            &project,
            "00000000-0000-0000-0000-000000000001.jsonl",
            false,
        )?;
        audit(file.0, false, user)?;
        // No file bytes are read or returned: bounded double-read and cleanup
        // integration still need a reviewed Windows source-capture gate.
        Ok(())
    }

    fn set_fixture_security(
        path: &Path,
        user: &Sid,
        world_write: bool,
        null_dacl: bool,
    ) -> Result<()> {
        let handle = open_fixture_path(path, true)?;
        let system = Sid::known(WinLocalSystemSid)?;
        let admins = Sid::known(WinBuiltinAdministratorsSid)?;
        let world = Sid::known(WinWorldSid)?;
        let mut access = Vec::new();
        for (sid, mask) in [
            (user, 0x001f01ffu32),
            (&system, 0x001f01ff),
            (&admins, 0x001f01ff),
            (&world, if world_write { 0x2 } else { 0 }),
        ] {
            if mask == 0 {
                continue;
            }
            access.push(EXPLICIT_ACCESS_W {
                grfAccessPermissions: mask,
                grfAccessMode: SET_ACCESS,
                grfInheritance: 0,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_UNKNOWN,
                    ptstrName: sid.pointer().cast(),
                },
            });
        }
        let mut dacl = null_mut();
        if !null_dacl
            // SAFETY: Entries reference live owned SID buffers; Win32 allocates
            // the output, freed after SetSecurityInfo copies it.
            && unsafe { SetEntriesInAclW(access.len() as u32, access.as_ptr(), null(), &mut dacl) }
                != 0
        {
            return Err(ProbeError::Security);
        }
        let _allocation = LocalAllocation(dacl.cast());
        // SAFETY: Handle is exclusively a newly created fixture; owner SID and
        // optional ACL are live and the API copies their security information.
        if unsafe {
            SetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                user.pointer(),
                null_mut(),
                dacl,
                null(),
            )
        } != 0
        {
            return Err(ProbeError::Security);
        }
        Ok(())
    }
    struct Fixture {
        root: PathBuf,
        user: Sid,
    }
    impl Fixture {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "stepsemble-windows-gate-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            let root = std::fs::canonicalize(root).unwrap();
            let result = Self {
                root,
                user: Sid::current_user().unwrap(),
            };
            std::fs::create_dir(result.project()).unwrap();
            std::fs::write(result.file(), b"owned synthetic fixture\n").unwrap();
            for path in [&result.root, &result.project(), &result.file()] {
                set_fixture_security(path, &result.user, false, false).unwrap();
            }
            result
        }
        fn project(&self) -> PathBuf {
            self.root.join("-fixture")
        }
        fn file(&self) -> PathBuf {
            self.project()
                .join("00000000-0000-0000-0000-000000000001.jsonl")
        }
        fn trusted(&self) -> TrustedFixtureRoot {
            let handle = open_fixture_path(&self.root, false).unwrap();
            let expected = identity(handle.0).unwrap();
            TrustedFixtureRoot { handle, expected }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn windows_owned_handle_owner_dacl_and_relative_open_are_observed_without_reading_history() {
        let fixture = Fixture::new();
        let trusted = fixture.trusted();
        assert_eq!(probe(&trusted, &fixture.user), Ok(()));
        let foreign = Sid::known(WinWorldSid).unwrap();
        assert_eq!(
            probe(&trusted, &foreign),
            Err(ProbeError::Policy(policy::Rejected::OwnerMismatch))
        );
        set_fixture_security(&fixture.file(), &fixture.user, true, false).unwrap();
        assert_eq!(
            probe(&trusted, &fixture.user),
            Err(ProbeError::Policy(policy::Rejected::UntrustedWriter))
        );
        set_fixture_security(&fixture.file(), &fixture.user, false, true).unwrap();
        assert_eq!(
            probe(&trusted, &fixture.user),
            Err(ProbeError::Policy(policy::Rejected::MissingDacl))
        );
    }
    #[test]
    fn windows_expected_root_identity_components_and_hardlinks_fail_closed() {
        let fixture = Fixture::new();
        let mut trusted = fixture.trusted();
        trusted.expected.file[0] ^= 1;
        assert_eq!(
            probe(&trusted, &fixture.user),
            Err(ProbeError::RootMismatch)
        );
        for component in [
            "..",
            "../outside",
            "C:\\outside",
            "file:stream",
            "file.",
            "file ",
            "a\\b",
        ] {
            assert!(matches!(
                relative(&trusted.handle, component, false),
                Err(ProbeError::Component)
            ));
        }
        std::fs::hard_link(fixture.file(), fixture.project().join("owned-hardlink")).unwrap();
        assert_eq!(
            probe(&fixture.trusted(), &fixture.user),
            Err(ProbeError::Hardlink)
        );
    }
    #[test]
    fn windows_junction_and_available_file_symlink_never_become_regular_source_handles() {
        let fixture = Fixture::new();
        let project = fixture.project();
        let original = fixture.root.join("original-project");
        std::fs::rename(&project, &original).unwrap();
        // mklink only touches two fixture-owned paths. Remove canonicalize's
        // verbatim prefix for this cmd builtin, and reject shell metacharacters
        // rather than interpreting an unusual TEMP/user-profile path as syntax.
        // This fixture utility is deliberately not a general path converter.
        let command_path = |path: &Path| {
            let text = path.to_str().expect("owned fixture path must be Unicode");
            let text = text.strip_prefix(r"\\?\").unwrap_or(text);
            assert!(
                !text.contains(['%', '!', '&', '|', '^', '<', '>', '"', '\r', '\n']),
                "owned junction fixture path contains unsupported shell syntax"
            );
            PathBuf::from(text)
        };
        // Junction creation does not require enabling Developer Mode or changing
        // the user's privileges. Output is captured, never published as evidence.
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(command_path(&project))
            .arg(command_path(&original))
            .output()
            .unwrap()
            .status;
        assert!(status.success(), "owned junction fixture creation failed");
        let observed = probe(&fixture.trusted(), &fixture.user);
        assert!(matches!(
            observed,
            Err(ProbeError::Open | ProbeError::Reparse)
        ));
        std::fs::remove_dir(&project).unwrap();
        std::fs::rename(&original, &project).unwrap();
        let file = fixture.file();
        let original_file = fixture.project().join("original.jsonl");
        std::fs::rename(&file, &original_file).unwrap();
        match std::os::windows::fs::symlink_file(&original_file, &file) {
            Ok(()) => assert!(matches!(
                probe(&fixture.trusted(), &fixture.user),
                Err(ProbeError::Open | ProbeError::Reparse)
            )),
            Err(error) if error.raw_os_error() == Some(1314) => {
                // No SeCreateSymbolicLinkPrivilege/Developer Mode: junction was
                // still exercised above. Never elevate or alter machine policy.
                std::fs::rename(&original_file, &file).unwrap();
            }
            Err(_) => panic!("owned symlink fixture creation failed"),
        }
    }
}
