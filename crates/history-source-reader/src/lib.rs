//! Reusable internal primitives, not a source grant or a production endpoint.
//! SQLite connections must come from a separately authenticated source boundary.
pub mod source_error;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod source_filesystem;
pub mod sqlite_metadata;
pub mod sqlite_readonly_vfs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod sqlite_source;
