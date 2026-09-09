//! Bounded byte-level JSONL scanning for a future large-history capture path.
//!
//! This module does NOT open a path, authenticate a source, parse JSON or publish
//! a page. Its caller must authenticate/hold the source, enforce a deadline in
//! `checkpoint`, validate record semantics, recheck identities/name edges, and
//! confirm physical close before exposing anything to a reader. A digest match
//! is an observation, NOT an atomic filesystem snapshot or native provenance.
use sha2::{Digest, Sha256};
use std::io::{self, Read, Seek, SeekFrom};

pub const SOURCE_BYTES: u64 = 256 * 1024 * 1024;
pub const RECORD_BYTES: usize = 128 * 1024;
pub const RECORDS: u32 = 262_144;
pub const PAGE_RECORDS: u32 = 50;
// Raw byte budget only. A transport must separately bound escaped JSON, its
// envelope and any structure annotations. Never treat this as a wire budget.
pub const PAGE_BYTES: usize = 256 * 1024;
pub const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidSelection,
    SourceLimit,
    Empty,
    RecordLimit,
    IncompleteTail,
    Changed,
    Io,
    Cancelled,
    Budget,
    InvalidRecord,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Record {
    pub record_index: u32,
    pub byte_offset: u64,
    /// Exact original bytes, including LF or CRLF. No lossy UTF-8 conversion.
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Summary {
    pub byte_length: u64,
    pub record_count: u32,
    pub sha256: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub struct Page {
    pub summary: Summary,
    pub offset: u32,
    pub records: Vec<Record>,
    pub next_offset: Option<u32>,
}

fn valid(size: u64, selection: Option<Selection>) -> Result<(), Error> {
    if size == 0 {
        return Err(Error::Empty);
    }
    if size > SOURCE_BYTES {
        return Err(Error::SourceLimit);
    }
    if selection.is_some_and(|s| s.offset > RECORDS || s.limit == 0 || s.limit > PAGE_RECORDS) {
        return Err(Error::InvalidSelection);
    }
    Ok(())
}

/// Scans every byte/record even when the selected page is full. Never returns a
/// prefix as a complete history. `validate` sees one borrowed record at a time,
/// in source order; it must not publish partial data or retain unbounded state.
/// No callbacks run for a partial tail or an oversized record.
fn scan(
    reader: &mut impl Read,
    observed_size: u64,
    selection: Option<Selection>,
    checkpoint: &mut impl FnMut() -> Result<(), Error>,
    validate: &mut impl FnMut(u32, u64, &[u8]) -> Result<(), Error>,
) -> Result<(Summary, Vec<Record>), Error> {
    valid(observed_size, selection)?;
    checkpoint()?;
    let mut chunk = vec![0_u8; CHUNK_BYTES];
    // Allocate once: retained capacity never depends on total source length.
    let mut line = Vec::with_capacity(RECORD_BYTES);
    let mut page = Vec::with_capacity(selection.map_or(0, |s| s.limit as usize));
    let mut page_bytes = 0;
    let mut page_full = false;
    let mut total = 0_u64;
    let mut record_start = 0_u64;
    let mut count = 0_u32;
    let mut digest = Sha256::new();
    loop {
        checkpoint()?;
        // Read at most one byte beyond the observed length, including at EOF.
        // This detects growth without accepting an appended prefix as stable.
        let remaining = observed_size - total;
        let capacity = (remaining + 1).min(CHUNK_BYTES as u64) as usize;
        let length = match reader.read(&mut chunk[..capacity]) {
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(Error::Io),
        };
        checkpoint()?;
        if length == 0 {
            break;
        }
        if length as u64 > remaining {
            return Err(Error::Changed);
        }
        total += length as u64;
        digest.update(&chunk[..length]);
        for fragment in chunk[..length].split_inclusive(|byte| *byte == b'\n') {
            checkpoint()?;
            if line.len() + fragment.len() > RECORD_BYTES {
                return Err(Error::RecordLimit);
            }
            line.extend_from_slice(fragment);
            if fragment.last() != Some(&b'\n') {
                continue;
            }
            if count == RECORDS {
                return Err(Error::RecordLimit);
            }
            validate(count, record_start, &line)?;
            checkpoint()?;
            if let Some(s) = selection
                && count >= s.offset
                && !page_full
            {
                if page.len() == s.limit as usize || page_bytes + line.len() > PAGE_BYTES {
                    page_full = true;
                } else {
                    page_bytes += line.len();
                    page.push(Record {
                        record_index: count,
                        byte_offset: record_start,
                        bytes: line.clone(),
                        sha256: Sha256::digest(&line).into(),
                    });
                }
            }
            record_start += line.len() as u64;
            line.clear();
            count += 1;
        }
    }
    checkpoint()?;
    if total != observed_size {
        return Err(Error::Changed);
    }
    if !line.is_empty() {
        return Err(Error::IncompleteTail);
    }
    if selection.is_some_and(|s| s.offset > count) {
        return Err(Error::InvalidSelection);
    }
    Ok((
        Summary {
            byte_length: total,
            record_count: count,
            sha256: digest.finalize().into(),
        },
        page,
    ))
}

/// Two full scans of the SAME caller-held seekable reader. The second retains
/// no page and checks the entire source digest/count, including unselected data.
/// File identity/ownership and name selection checks remain the caller's job.
/// The first scan validates every record; no page escapes on any later failure.
pub fn scan_matching_page(
    reader: &mut (impl Read + Seek),
    observed_size: u64,
    selection: Selection,
    expected: Option<Summary>,
    mut checkpoint: impl FnMut() -> Result<(), Error>,
    mut validate: impl FnMut(u32, u64, &[u8]) -> Result<(), Error>,
) -> Result<Page, Error> {
    valid(observed_size, Some(selection))?;
    checkpoint()?;
    if expected.is_some_and(|s| s.byte_length != observed_size) {
        return Err(Error::Changed);
    }
    rewind(reader, &mut checkpoint)?;
    let (first, records) = scan(
        reader,
        observed_size,
        Some(selection),
        &mut checkpoint,
        &mut validate,
    )?;
    if expected.is_some_and(|s| s != first) {
        return Err(Error::Changed);
    }
    checkpoint()?;
    rewind(reader, &mut checkpoint)?;
    let (second, _) = scan(
        reader,
        observed_size,
        None,
        &mut checkpoint,
        &mut |_, _, _| Ok(()),
    )?;
    checkpoint()?;
    if first != second {
        return Err(Error::Changed);
    }
    let next = selection.offset + records.len() as u32;
    Ok(Page {
        summary: first,
        offset: selection.offset,
        records,
        next_offset: (next < first.record_count).then_some(next),
    })
}

fn rewind(
    reader: &mut impl Seek,
    checkpoint: &mut impl FnMut() -> Result<(), Error>,
) -> Result<(), Error> {
    checkpoint()?;
    if reader.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)? != 0 {
        return Err(Error::Io);
    }
    checkpoint()
}
