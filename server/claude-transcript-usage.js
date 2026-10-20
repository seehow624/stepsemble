"use strict";

// The last turn a Claude Code conversation recorded in its own transcript
// (<config>/projects/<cwd>/<session>.jsonl): the model it answered with, the
// level it thought at and the context its last call was sent. A conversation
// whose process has stopped, or was let go before the Host restarted, shows
// these as last observed. Transcripts grow past 100 MB, so the file is read
// from its end in chunks until the last assistant message with usage.

const fs = require("node:fs");
const { modelKey, modelTags, matchModel, contextCapacity } = require("../public/modules/model-presentation");

const CHUNK_BYTES = 256 * 1024;
// How far back the last message with usage is looked for. A turn ends with
// one; a longer stretch without one is a transcript this does not read.
const MAX_SCAN_BYTES = 48 * 1024 * 1024;
// A line can be a whole file Claude wrote; one longer than this is skipped.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const CACHE_LIMIT = 64;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]~-]{0,255}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Claude's own models answer with a 200k or a 1M context; more than 200k
// used means the 1M one.
const CLAUDE_STANDARD_CONTEXT = 200_000;
const MARKERS = [Buffer.from('"assistant"'), Buffer.from('"usage"')];

const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
function count(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}
const modelName = value => typeof value === "string" && value !== "<synthetic>" && MODEL.test(value) ? value : null;

/** The figures of one assistant transcript row, or null when it has none. */
function transcriptTurn(row) {
  if (!plain(row) || row.type !== "assistant" || row.isSidechain === true || !plain(row.message) || !plain(row.message.usage)) return null;
  const model = modelName(row.message.model);
  if (!model) return null;
  const raw = row.message.usage;
  const input = count(raw.input_tokens), cacheRead = count(raw.cache_read_input_tokens), cacheWrite = count(raw.cache_creation_input_tokens);
  const output = count(raw.output_tokens);
  const known = [input, cacheRead, cacheWrite].filter(value => value !== null);
  if (!known.length) return null;
  const contextTokens = known.reduce((sum, value) => sum + value, 0);
  const effort = [row.perTurnEffort, row.effort].map(value => String(value || "").toLowerCase()).find(value => EFFORTS.has(value)) || null;
  const usage = { totalTokens: contextTokens + (output ?? 0) };
  if (input !== null) usage.inputTokens = input;
  if (output !== null) usage.outputTokens = output;
  if (cacheRead !== null) usage.cachedInputTokens = cacheRead;
  if (cacheWrite !== null) usage.cacheWriteInputTokens = cacheWrite;
  const observedAt = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? new Date(Date.parse(row.timestamp)).toISOString() : null;
  return { model, requestedModel: modelName(row.requestedModel), effort, contextTokens, usage, observedAt };
}

const relevant = line => MARKERS.every(marker => line.indexOf(marker) >= 0);
const COMPACTED = Buffer.from('"compact_boundary"');

// A compaction Claude recorded: the context it left, in place of the last
// message's, which is from before it.
function compaction(row) {
  if (!plain(row) || row.type !== "system" || row.subtype !== "compact_boundary" || row.isSidechain === true) return null;
  const metadata = plain(row.compactMetadata) ? row.compactMetadata : plain(row.compact_metadata) ? row.compact_metadata : {};
  const observedAt = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? new Date(Date.parse(row.timestamp)).toISOString() : null;
  return { contextTokens: count(metadata.postTokens ?? metadata.post_tokens), observedAt };
}

/**
 * Reads the transcript backwards for its last assistant message with usage.
 * A compaction after it gives the context instead.
 * @returns {{ model, requestedModel, effort, contextTokens, usage, observedAt } | null}
 */
function readLastTurn(file, { chunkBytes = CHUNK_BYTES, maxScanBytes = MAX_SCAN_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    let position = stat.size, scanned = 0, carry = Buffer.alloc(0), overlong = false, compacted = null;
    const found = turn => !compacted ? turn : { ...turn, contextTokens: compacted.contextTokens,
      usage: compacted.contextTokens === null ? null : { totalTokens: compacted.contextTokens }, observedAt: compacted.observedAt || turn.observedAt };
    while (position > 0 && scanned < maxScanBytes) {
      const length = Math.min(chunkBytes, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const bytes = fs.readSync(fd, chunk, read, length - read, position + read);
        if (!bytes) return null;
        read += bytes;
      }
      scanned += length;
      // A line that started in an earlier chunk is completed by the next one read.
      const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      const first = position > 0 ? buffer.indexOf(0x0a) : -1;
      const complete = first < 0 ? (position > 0 ? null : buffer) : buffer.subarray(first + 1);
      if (complete) {
        let end = complete.length;
        while (end > 0) {
          const start = complete.lastIndexOf(0x0a, end - 1) + 1;
          const line = complete.subarray(start, end);
          // The line the last chunk held only the start of is let go of.
          const whole = !(overlong && end === complete.length) && line.length > 0;
          if (whole && relevant(line)) {
            let row = null;
            try { row = JSON.parse(line.toString("utf8")); } catch {}
            const turn = transcriptTurn(row);
            if (turn) return found(turn);
          } else if (whole && !compacted && line.indexOf(COMPACTED) >= 0) {
            let row = null;
            try { row = JSON.parse(line.toString("utf8")); } catch {}
            compacted = compaction(row);
          }
          if (overlong && end === complete.length) overlong = false;
          end = start - 1;
        }
      }
      carry = first < 0 ? buffer : buffer.subarray(0, first);
      if (carry.length > MAX_LINE_BYTES) { carry = Buffer.alloc(0); overlong = true; }
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

/**
 * The context a stopped conversation was at, as the composer's gauge shows a
 * last observation. Its capacity is the one its model states: Claude's "[1m]",
 * the catalog row the model matches, or the 1M context that more than 200k
 * used tokens of a Claude model mean.
 */
function lastObservedContext(turn, { models = [], effort = null } = {}) {
  if (!turn) return null;
  const row = matchModel(models, turn.requestedModel || turn.model, { effort: effort || turn.effort })
    || matchModel(models, turn.model, { effort: effort || turn.effort });
  const named = modelTags(turn.requestedModel || "").wide ? 1_000_000 : null;
  const claude = /^claude-/.test(modelKey(turn.model));
  const contextWindow = named ?? contextCapacity(row) ?? (claude && turn.contextTokens > CLAUDE_STANDARD_CONTEXT ? 1_000_000 : null);
  return {
    // As Claude names a model it runs, with its 1M context when it had it.
    model: turn.model + (named && !modelTags(turn.model).wide ? "[1m]" : ""),
    contextWindow,
    contextTokens: turn.contextTokens,
    contextPercent: contextWindow && turn.contextTokens !== null ? Number(Math.min(100, turn.contextTokens / contextWindow * 100).toFixed(6)) : null,
    usage: turn.usage ? { ...turn.usage } : null,
    effort: turn.effort,
    source: "last_observed",
    observedAt: turn.observedAt,
    stale: true,
  };
}

// One read per version of a transcript: its path, size and modification time.
function createClaudeTranscriptUsage({ read = readLastTurn } = {}) {
  const cache = new Map();
  return Object.freeze({
    lastTurn(file) {
      if (typeof file !== "string" || !file) return null;
      let stat;
      try { stat = fs.statSync(file); } catch { return null; }
      if (!stat.isFile()) return null;
      const version = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      const hit = cache.get(file);
      if (hit && hit.version === version) return hit.turn;
      const turn = read(file);
      cache.delete(file);
      cache.set(file, { version, turn });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return turn;
    },
  });
}

module.exports = { readLastTurn, transcriptTurn, lastObservedContext, createClaudeTranscriptUsage, LIMITS: Object.freeze({ CHUNK_BYTES, MAX_SCAN_BYTES, MAX_LINE_BYTES }) };
