//! Incremental, allocation-free Zstandard frame-envelope validation.
//!
//! This does not decompress or authenticate bytes. A caller must still use a
//! bounded decoder, validate its output and bind the physical input to a held
//! source. The limits match the existing permissioned Node decoder.

pub const WINDOW_BYTES: u64 = 8 * 1024 * 1024;
pub const FRAMES: u32 = 256;
pub const BLOCKS: u32 = 65_536;
const BLOCK_BYTES: u64 = 128 * 1024;
const ZSTD_MAGIC: u32 = 0xfd2f_b528;
const SKIPPABLE_MIN: u32 = 0x184d_2a50;
const SKIPPABLE_MAX: u32 = 0x184d_2a5f;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Unsupported,
    Limit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Magic,
    SkippableSize,
    Skip { remaining: u64, next: Next },
    Descriptor,
    Window,
    Dictionary,
    ContentSize,
    BlockHeader,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Next {
    Magic,
    BlockHeader,
    Checksum,
}

/// Validates complete standard and skippable frames while bytes stream past.
/// Retained state is fixed-size regardless of the physical source length.
pub struct Verifier {
    state: State,
    scratch: [u8; 8],
    scratch_len: usize,
    frames: u32,
    data_frames: u32,
    blocks: u32,
    single: bool,
    checksum: bool,
    dictionary_bytes: usize,
    content_size_bytes: usize,
    window: u64,
    known_decoded_bytes: u64,
}

impl Default for Verifier {
    fn default() -> Self {
        Self {
            state: State::Magic,
            scratch: [0; 8],
            scratch_len: 0,
            frames: 0,
            data_frames: 0,
            blocks: 0,
            single: false,
            checksum: false,
            dictionary_bytes: 0,
            content_size_bytes: 0,
            window: 0,
            known_decoded_bytes: 0,
        }
    }
}

impl Verifier {
    pub fn push(&mut self, mut bytes: &[u8]) -> Result<(), Error> {
        while !bytes.is_empty() {
            match self.state {
                State::Skip { remaining, next } => {
                    let used = remaining.min(bytes.len() as u64);
                    bytes = &bytes[used as usize..];
                    let remaining = remaining - used;
                    if remaining == 0 {
                        self.state = match next {
                            Next::Magic => State::Magic,
                            Next::BlockHeader => State::BlockHeader,
                            Next::Checksum => State::Skip {
                                remaining: 4,
                                next: Next::Magic,
                            },
                        };
                    } else {
                        self.state = State::Skip { remaining, next };
                    }
                }
                State::Magic => {
                    if !self.collect(&mut bytes, 4) {
                        continue;
                    }
                    let magic = u32::from_le_bytes(self.scratch[..4].try_into().unwrap());
                    self.clear_scratch();
                    self.frames = self.frames.checked_add(1).ok_or(Error::Limit)?;
                    if self.frames > FRAMES {
                        return Err(Error::Limit);
                    }
                    self.state = if (SKIPPABLE_MIN..=SKIPPABLE_MAX).contains(&magic) {
                        State::SkippableSize
                    } else if magic == ZSTD_MAGIC {
                        self.data_frames += 1;
                        State::Descriptor
                    } else {
                        return Err(Error::Invalid);
                    };
                }
                State::SkippableSize => {
                    if !self.collect(&mut bytes, 4) {
                        continue;
                    }
                    let remaining =
                        u32::from_le_bytes(self.scratch[..4].try_into().unwrap()) as u64;
                    self.clear_scratch();
                    self.state = if remaining == 0 {
                        State::Magic
                    } else {
                        State::Skip {
                            remaining,
                            next: Next::Magic,
                        }
                    };
                }
                State::Descriptor => {
                    if !self.collect(&mut bytes, 1) {
                        continue;
                    }
                    let descriptor = self.scratch[0];
                    self.clear_scratch();
                    if descriptor & 0b0001_1000 != 0 {
                        return Err(Error::Unsupported);
                    }
                    self.single = descriptor & 0b0010_0000 != 0;
                    self.checksum = descriptor & 0b0000_0100 != 0;
                    self.dictionary_bytes = [0, 1, 2, 4][(descriptor & 3) as usize];
                    let flag = (descriptor >> 6) as usize;
                    self.content_size_bytes = [if self.single { 1 } else { 0 }, 2, 4, 8][flag];
                    self.window = 0;
                    self.state = if self.single {
                        self.after_window()
                    } else {
                        State::Window
                    };
                }
                State::Window => {
                    if !self.collect(&mut bytes, 1) {
                        continue;
                    }
                    let descriptor = self.scratch[0];
                    self.clear_scratch();
                    let base = 1_u64 << (10 + u32::from(descriptor >> 3));
                    self.window = base + base / 8 * u64::from(descriptor & 7);
                    if self.window > WINDOW_BYTES {
                        return Err(Error::Limit);
                    }
                    self.state = self.after_window();
                }
                State::Dictionary => {
                    if !self.collect(&mut bytes, self.dictionary_bytes) {
                        continue;
                    }
                    let dictionary = little(&self.scratch, self.dictionary_bytes);
                    self.clear_scratch();
                    if dictionary != 0 {
                        return Err(Error::Unsupported);
                    }
                    self.state = self.after_dictionary();
                }
                State::ContentSize => {
                    if !self.collect(&mut bytes, self.content_size_bytes) {
                        continue;
                    }
                    let mut size = little(&self.scratch, self.content_size_bytes);
                    if self.content_size_bytes == 2 {
                        size += 256;
                    }
                    self.clear_scratch();
                    self.known_decoded_bytes = self
                        .known_decoded_bytes
                        .checked_add(size)
                        .ok_or(Error::Limit)?;
                    if self.known_decoded_bytes > crate::jsonl_scan::SOURCE_BYTES {
                        return Err(Error::Limit);
                    }
                    if self.single {
                        self.window = size;
                        if self.window > WINDOW_BYTES {
                            return Err(Error::Limit);
                        }
                    }
                    self.state = State::BlockHeader;
                }
                State::BlockHeader => {
                    if !self.collect(&mut bytes, 3) {
                        continue;
                    }
                    let header = little(&self.scratch, 3);
                    self.clear_scratch();
                    self.blocks = self.blocks.checked_add(1).ok_or(Error::Limit)?;
                    if self.blocks > BLOCKS {
                        return Err(Error::Limit);
                    }
                    let last = header & 1 != 0;
                    let block_type = (header >> 1) & 3;
                    let size = header >> 3;
                    if block_type == 3 || size > self.window.min(BLOCK_BYTES) {
                        return Err(Error::Invalid);
                    }
                    let remaining = if block_type == 1 { 1 } else { size };
                    let next = if last {
                        if self.checksum {
                            Next::Checksum
                        } else {
                            Next::Magic
                        }
                    } else {
                        Next::BlockHeader
                    };
                    if remaining == 0 {
                        self.state = match next {
                            Next::Magic => State::Magic,
                            Next::BlockHeader => State::BlockHeader,
                            Next::Checksum => State::Skip {
                                remaining: 4,
                                next: Next::Magic,
                            },
                        };
                    } else {
                        self.state = State::Skip { remaining, next };
                    }
                }
            }
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<u32, Error> {
        if self.state == State::Magic && self.scratch_len == 0 && self.data_frames > 0 {
            Ok(self.frames)
        } else {
            Err(Error::Invalid)
        }
    }

    fn collect(&mut self, bytes: &mut &[u8], needed: usize) -> bool {
        let count = (needed - self.scratch_len).min(bytes.len());
        self.scratch[self.scratch_len..self.scratch_len + count].copy_from_slice(&bytes[..count]);
        self.scratch_len += count;
        *bytes = &bytes[count..];
        self.scratch_len == needed
    }

    fn clear_scratch(&mut self) {
        self.scratch.fill(0);
        self.scratch_len = 0;
    }

    fn after_window(&self) -> State {
        if self.dictionary_bytes > 0 {
            State::Dictionary
        } else {
            self.after_dictionary()
        }
    }

    fn after_dictionary(&self) -> State {
        if self.content_size_bytes > 0 {
            State::ContentSize
        } else {
            State::BlockHeader
        }
    }
}

fn little(bytes: &[u8; 8], length: usize) -> u64 {
    let mut value = [0_u8; 8];
    value[..length].copy_from_slice(&bytes[..length]);
    u64::from_le_bytes(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn encoded(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        encoder
            .set_pledged_src_size(Some(bytes.len() as u64))
            .unwrap();
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn encoded_unknown_size(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn incremental_complete_concatenated_and_skippable_frames() {
        let mut bytes = vec![0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3];
        bytes.extend(encoded(b"one\n"));
        bytes.extend(encoded(b"two\n"));
        bytes.extend([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
        for width in [1, 2, 7, 64] {
            let mut verifier = Verifier::default();
            for chunk in bytes.chunks(width) {
                verifier.push(chunk).unwrap();
            }
            assert_eq!(verifier.finish(), Ok(4));
        }
    }

    #[test]
    fn truncated_trailing_dictionary_reserved_and_limits_reject() {
        let bytes = encoded(b"one\n");
        for end in 0..bytes.len() {
            let mut verifier = Verifier::default();
            let pushed = verifier.push(&bytes[..end]);
            assert!(pushed.is_err() || verifier.finish().is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        let mut verifier = Verifier::default();
        verifier.push(&trailing).unwrap();
        assert_eq!(verifier.finish(), Err(Error::Invalid));

        let mut reserved = bytes;
        reserved[4] |= 0b0000_1000;
        let mut verifier = Verifier::default();
        assert_eq!(verifier.push(&reserved), Err(Error::Unsupported));

        let mut too_many = Vec::new();
        for _ in 0..=FRAMES {
            too_many.extend([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
        }
        let mut verifier = Verifier::default();
        assert_eq!(verifier.push(&too_many), Err(Error::Limit));
    }

    #[test]
    fn unknown_content_size_is_accepted_but_remains_stream_bounded() {
        let bytes = encoded_unknown_size(b"owned\n");
        // A streaming encoder without a pledged size leaves the frame content
        // size absent. The decoded-byte scanner, rather than this envelope
        // verifier, enforces the aggregate 256 MiB ceiling.
        assert_eq!(bytes[4] >> 6, 0);
        assert_eq!(bytes[4] & 0b0010_0000, 0);
        let mut verifier = Verifier::default();
        verifier.push(&bytes).unwrap();
        assert_eq!(verifier.finish(), Ok(1));
    }
}
