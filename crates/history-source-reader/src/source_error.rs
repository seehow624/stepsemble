//! Stable internal source errors; never include raw paths or OS diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Input,
    PlatformUnsupported,
    Missing,
    NotRegular,
    OwnerOrMode,
    Hardlinked,
    Empty,
    TooLarge,
    RecordLimit,
    RolloutFormat(crate::codex_rollout_format::Error),
    RolloutStructure,
    RolloutCompressionLimit,
    RolloutCompressionInvalid,
    RolloutCompressionUnsupported,
    IncompleteTail,
    Changed,
    AccessDenied,
    Io,
    Budget,
    AclUnavailable,
    AclUnsupported,
    RootIdentityChanged,
    IdentityUnavailable,
    ContainmentUnavailable,
    CloseFailed,
    InventoryLimit,
    EncodingUnsupported,
    DatabaseUnsupported,
    DatabaseUnavailable,
    Busy,
    Cancelled,
    /// A paginated chain exceeded the one-admission stored-byte budget.
    /// Keep this distinct from a single-source size failure so callers do not
    /// mistake a deliberately bounded chain refusal for an empty history.
    PaginatedChainBytesExceeded,
    /// A paginated chain exceeded the independent decoded-byte budget. This
    /// is separate because a compressed source can expand far beyond storage.
    PaginatedChainDecodedBytesExceeded,
    /// A paginated rollout contained a missing, non-sequential or otherwise
    /// unverifiable ordinal/byte boundary.
    PaginatedOrdinalInvalid,
    /// A paginated ancestry/chain/resolution layer rejected the supplied
    /// observation. The nested error retains its stable public code without
    /// exposing paths or OS diagnostics.
    PaginatedAncestry(crate::codex_paginated_ancestry::Error),
    PaginatedChain(crate::codex_paginated_chain::Error),
    PaginatedResolution(crate::codex_paginated_resolution::Error),
    PaginatedConsistency(crate::codex_paginated_consistency::Error),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Input => "invalid_source_input",
            Self::PlatformUnsupported => "source_platform_unsupported",
            Self::Missing => "source_missing",
            Self::NotRegular => "source_not_regular_or_linked",
            Self::OwnerOrMode => "source_owner_or_mode",
            Self::Hardlinked => "source_hardlinked",
            Self::Empty => "source_empty",
            Self::TooLarge => "source_too_large",
            Self::RecordLimit => "source_record_limit",
            Self::RolloutFormat(error) => error.code(),
            Self::RolloutStructure => "rollout_structure_invalid",
            Self::RolloutCompressionLimit => "rollout_compression_limit",
            Self::RolloutCompressionInvalid => "rollout_compression_invalid",
            Self::RolloutCompressionUnsupported => "rollout_compression_unsupported",
            Self::IncompleteTail => "source_incomplete_tail",
            Self::Changed => "source_changed",
            Self::AccessDenied => "source_access_denied",
            Self::Io => "source_io_error",
            Self::Budget => "source_read_budget",
            Self::AclUnavailable => "source_acl_unavailable",
            Self::AclUnsupported => "source_acl_unsupported",
            Self::RootIdentityChanged => "source_root_identity_changed",
            Self::IdentityUnavailable => "source_identity_unavailable",
            Self::ContainmentUnavailable => "source_containment_unavailable",
            Self::CloseFailed => "source_close_failed",
            Self::InventoryLimit => "source_inventory_limit",
            Self::EncodingUnsupported => "source_encoding_unsupported",
            Self::DatabaseUnsupported => "source_database_unsupported",
            Self::DatabaseUnavailable => "source_database_unavailable",
            Self::Busy => "source_busy",
            Self::Cancelled => "source_cancelled",
            Self::PaginatedChainBytesExceeded => "paginated_resolution_bytes_exceeded",
            Self::PaginatedChainDecodedBytesExceeded => {
                "paginated_resolution_decoded_bytes_exceeded"
            }
            Self::PaginatedOrdinalInvalid => "paginated_rollout_ordinal_invalid",
            Self::PaginatedAncestry(error) => error.code(),
            Self::PaginatedChain(error) => error.code(),
            Self::PaginatedResolution(error) => error.code(),
            Self::PaginatedConsistency(error) => error.code(),
        }
    }
}
