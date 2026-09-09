//! Generated, isolated large-history allocation gate. Does not open files or
//! use a native account/model. The generator retains ONE record, not the input.
//! Global allocator instrumentation is confined to this example executable.
use sha2::{Digest, Sha256};
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use stepsemble_history_source_reader::jsonl_scan::{
    self, Error, Selection, Summary, scan_matching_page,
};

struct MeasuredAllocator;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
fn added(size: usize) {
    let live = LIVE.fetch_add(size, Ordering::SeqCst) + size;
    PEAK.fetch_max(live, Ordering::SeqCst);
}
// SAFETY: Every operation delegates the same pointer/layout to System. Counters
// only observe successful allocation sizes and never dereference user memory.
unsafe impl GlobalAlloc for MeasuredAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: GlobalAlloc's caller supplies a valid layout.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            added(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: Same layout contract as the delegated allocator call.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            added(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: The caller supplies the original live pointer and layout.
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: The caller provides the original allocation and valid new size.
        let result = unsafe { System.realloc(pointer, layout, new_size) };
        if !result.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
            added(new_size);
        }
        result
    }
}
#[global_allocator]
static ALLOCATOR: MeasuredAllocator = MeasuredAllocator;

struct Generated {
    record: Vec<u8>,
    size: u64,
    position: u64,
    bytes_read: u64,
    largest_request: usize,
}
impl Read for Generated {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        self.largest_request = self.largest_request.max(target.len());
        let length = target.len().min((self.size - self.position) as usize);
        let mut used = 0;
        while used < length {
            let start = self.position as usize % self.record.len();
            let n = (length - used).min(self.record.len() - start);
            target[used..used + n].copy_from_slice(&self.record[start..start + n]);
            self.position += n as u64;
            used += n;
        }
        self.bytes_read += length as u64;
        Ok(length)
    }
}
impl Seek for Generated {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        if position != SeekFrom::Start(0) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.position = 0;
        Ok(0)
    }
}

fn measure(size: u64, width: usize) -> serde_json::Value {
    let prefix = b"{\"type\":\"owned_allocation_fixture\",\"text\":\"";
    let suffix = b"\"}\n";
    let mut record = vec![b'a'; width];
    record[..prefix.len()].copy_from_slice(prefix);
    record[width - suffix.len()..].copy_from_slice(suffix);
    let count = (size / width as u64) as u32;
    assert_eq!(u64::from(count) * width as u64, size);
    let mut expected_hash = Sha256::new();
    for _ in 0..count {
        expected_hash.update(&record);
    }
    let expected = Summary {
        byte_length: size,
        record_count: count,
        sha256: expected_hash.finalize().into(),
    };
    let mut input = Generated {
        record,
        size,
        position: 0,
        bytes_read: 0,
        largest_request: 0,
    };
    let before = LIVE.load(Ordering::SeqCst);
    PEAK.store(before, Ordering::SeqCst);
    let start = Instant::now();
    let mut validated = 0;
    let offset = count / 2;
    let page = scan_matching_page(
        &mut input,
        size,
        Selection { offset, limit: 50 },
        Some(expected),
        || {
            if start.elapsed() > Duration::from_secs(30) {
                Err(Error::Budget)
            } else {
                Ok(())
            }
        },
        |index, offset, bytes| {
            assert_eq!(index, validated);
            assert_eq!(offset, u64::from(index) * width as u64);
            // Real per-record parsing, discarded before the next record. This is
            // syntactic JSON validation, NOT a Codex metadata or structure adapter.
            let value: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|_| Error::InvalidRecord)?;
            if value["type"] != "owned_allocation_fixture" {
                return Err(Error::InvalidRecord);
            }
            validated += 1;
            Ok(())
        },
    )
    .expect("bounded generated scan");
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let peak_delta = PEAK.load(Ordering::SeqCst) - before;
    let retained = LIVE.load(Ordering::SeqCst) - before;
    let expected_records = (jsonl_scan::PAGE_BYTES / width)
        .min(50)
        .min((count - offset) as usize);
    assert_eq!(page.summary, expected);
    assert_eq!(page.records.len(), expected_records);
    for (index, item) in page.records.iter().enumerate() {
        assert_eq!(item.record_index, offset + index as u32);
        assert_eq!(
            item.byte_offset,
            u64::from(item.record_index) * width as u64
        );
        assert_eq!(item.bytes, input.record);
    }
    assert_eq!(validated, count);
    assert_eq!(input.bytes_read, size * 2);
    assert!(input.largest_request <= jsonl_scan::CHUNK_BYTES);
    // A source-size-independent allocated-byte bound, including serde's one
    // record parse and the retained page. Not an OS RSS/allocator reserve bound.
    assert!(
        peak_delta <= 768 * 1024,
        "peak live allocation {peak_delta}"
    );
    assert!(retained <= jsonl_scan::PAGE_BYTES + 16 * 1024);
    let returned = page.records.iter().map(|r| r.bytes.len()).sum::<usize>();
    drop(page);
    assert_eq!(
        LIVE.load(Ordering::SeqCst),
        before,
        "scanner allocations must be released"
    );
    serde_json::json!({"sourceBytes":size,"recordBytes":width,"records":count,
        "validatedRecords":validated,"pageOffset":offset,"returnedRecords":expected_records,
        "returnedBytes":returned,"sourceBytesRead":input.bytes_read,"maximumReadRequest":input.largest_request,
        "peakLiveAllocationDeltaBytes":peak_delta,"retainedAllocationBytes":retained,
        "releasedToBaseline":true,"elapsedMs":elapsed_ms})
}

fn main() {
    assert_eq!(
        std::env::args_os().count(),
        1,
        "no source path or options accepted"
    );
    let workloads: Vec<_> = [
        (1024 * 1024, 1024),
        (32 * 1024 * 1024, 1024),
        (jsonl_scan::SOURCE_BYTES, 1024),
        (1024 * 1024, jsonl_scan::RECORD_BYTES),
        (jsonl_scan::SOURCE_BYTES, jsonl_scan::RECORD_BYTES),
    ]
    .into_iter()
    .map(|(size, width)| measure(size, width))
    .collect();
    println!(
        "{}",
        serde_json::json!({"kind":"owned_jsonl_scan_allocation_gate",
        "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
        "privateSourceReads":0,"nativeInvocations":0,"modelCalls":0,
        "buildProfile":if cfg!(debug_assertions) {"debug"} else {"release"},
        "heapMetric":"peak_live_requested_allocations_not_rss","workloads":workloads})
    );
}
