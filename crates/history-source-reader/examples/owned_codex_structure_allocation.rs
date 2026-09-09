//! Generated maximum-source/identifier-cardinality gate, not a disk/Host/RSS
//! benchmark. Retains three record templates, never a complete input file.
#[path = "support/measured_allocator.rs"]
mod measured;
use measured::{LIVE, MeasuredAllocator, PEAK};
use std::{
    io::{self, Read, Seek, SeekFrom},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use stepsemble_history_source_reader::{codex_rollout_structure as structure, jsonl_scan as scan};
#[global_allocator]
static ALLOCATOR: MeasuredAllocator = MeasuredAllocator;
const ID: &str = "01234567-89ab-4def-8123-456789abcdef";
struct Generated {
    meta: Vec<u8>,
    start: Vec<u8>,
    record: Vec<u8>,
    mode: &'static str,
    size: u64,
    position: u64,
    bytes_read: u64,
    largest_request: usize,
    id_offset: Option<usize>,
}
fn padded(s: String, width: usize) -> Vec<u8> {
    let mut b = s.into_bytes();
    assert!(b.len() < width);
    b.resize(width - 1, b' ');
    b.push(b'\n');
    b
}
impl Generated {
    fn new(mode: &'static str, count: u32, width: usize) -> Self {
        let meta = padded(
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\",\"cli_version\":\"0.153.4\"}}}}"
            ),
            width,
        );
        let start = padded(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"A\"}}"
                .into(),
            width,
        );
        let text=match mode {
            "turns" => "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"00000000\"}}".into(),
            "calls" => "{\"type\":\"event_msg\",\"payload\":{\"type\":\"exec_command_begin\",\"turn_id\":\"A\",\"call_id\":\"00000000\"}}".into(),
            "text" => {let p="{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"";
                format!("{p}{}\"}}}}", "x".repeat(width-p.len()-4))},
            _=>panic!("fixed_owned_mode"),
        };
        let record = padded(text, width);
        let id_offset = record.windows(8).position(|p| p == b"00000000");
        Self {
            meta,
            start,
            record,
            mode,
            size: u64::from(count) * width as u64,
            position: 0,
            bytes_read: 0,
            largest_request: 0,
            id_offset,
        }
    }
}
impl Read for Generated {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        self.largest_request = self.largest_request.max(target.len());
        let size = target.len().min((self.size - self.position) as usize);
        let mut used = 0;
        while used < size {
            let width = self.record.len();
            let row = self.position / width as u64;
            let start = self.position as usize % width;
            if let Some(offset) = self.id_offset {
                let mut value = row;
                for i in (0..8).rev() {
                    self.record[offset + i] = b'0' + (value % 10) as u8;
                    value /= 10;
                }
            }
            let record = if row == 0 {
                &self.meta
            } else if self.mode == "calls" && row == 1 {
                &self.start
            } else {
                &self.record
            };
            let n = (size - used).min(width - start);
            target[used..used + n].copy_from_slice(&record[start..start + n]);
            used += n;
            self.position += n as u64;
        }
        self.bytes_read += size as u64;
        Ok(size)
    }
}
impl Seek for Generated {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        if p != SeekFrom::Start(0) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.position = 0;
        Ok(0)
    }
}
fn measure(mode: &'static str, count: u32, width: usize) -> serde_json::Value {
    let mut input = Generated::new(mode, count, width);
    let size = input.size;
    let baseline = LIVE.load(Ordering::SeqCst);
    PEAK.store(baseline, Ordering::SeqCst);
    let start = Instant::now();
    let p = structure::scan_page(
        &mut input,
        size,
        scan::Selection {
            offset: count / 2,
            limit: 50,
        },
        ID,
        "0.153.4",
        None,
        || {
            if start.elapsed() > Duration::from_secs(30) {
                Err(scan::Error::Budget)
            } else {
                Ok(())
            }
        },
    )
    .expect("owned_structure_scan");
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    let peak = PEAK.load(Ordering::SeqCst) - baseline;
    let retained = LIVE.load(Ordering::SeqCst) - baseline;
    assert_eq!(p.records.summary.record_count, count);
    assert_eq!(p.validation.records_validated, count);
    assert_eq!(
        p.structure.total_turns,
        if mode == "turns" { count - 1 } else { 1 }
    );
    assert_eq!(p.structure.annotations.len(), p.records.records.len());
    assert!(p.structure.annotations.len() <= 50);
    assert!(p.structure.turns.len() <= 50);
    assert_eq!(input.bytes_read, size * 2);
    assert!(input.largest_request <= scan::CHUNK_BYTES);
    assert!(
        peak <= 96 * 1024 * 1024,
        "bounded_compact_index_peak {peak}"
    );
    assert!(retained <= 512 * 1024, "bounded_returned_page {retained}");
    let output_records = p.records.records.len();
    let turns = p.structure.total_turns;
    drop(p);
    assert_eq!(
        LIVE.load(Ordering::SeqCst),
        baseline,
        "all_index_allocations_released"
    );
    serde_json::json!({"mode":mode,"sourceBytes":size,"records":count,"recordBytes":width,"totalTurns":turns,"pageRecords":output_records,
        "sourceBytesRead":input.bytes_read,"peakLiveAllocationDeltaBytes":peak,"retainedAllocationBytes":retained,"releasedToBaseline":true,"elapsedMs":elapsed})
}
fn main() {
    assert_eq!(std::env::args_os().count(), 1, "no_paths_or_options");
    let workloads = [
        ("text", 16384, 1024),
        ("text", 16384, 16 * 1024),
        ("turns", scan::RECORDS, 1024),
        ("calls", scan::RECORDS, 1024),
    ]
    .into_iter()
    .map(|(m, n, w)| measure(m, n, w))
    .collect::<Vec<_>>();
    println!(
        "{}",
        serde_json::json!({"gate":"owned_codex_structure_allocation","profile":structure::PROFILE,
        "buildProfile":if cfg!(debug_assertions){"debug"}else{"release"},"heapMetric":"peak_live_requested_allocations_not_rss",
        "privateSourceReads":0,"nativeInvocations":0,"modelCalls":0,"workloads":workloads})
    );
}
