//! Reusable internal primitives, not a source grant or a production endpoint.
//! SQLite connections must come from a separately authenticated source boundary.
pub mod codex_locator;
pub mod codex_paginated_ancestry;
pub mod codex_paginated_chain;
pub mod codex_paginated_consistency;
pub mod codex_paginated_resolution;
pub mod codex_rollout_format;
pub mod codex_rollout_structure;
pub mod jsonl_scan;
pub mod source_error;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod source_filesystem;
pub mod sqlite_metadata;
pub mod sqlite_paginated;
pub mod sqlite_readonly_vfs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod sqlite_source;
pub mod zstd_framing;
