"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { execFileSync } = require("node:child_process");
const reader = path.resolve(__dirname, "../server/usage-history.js");
const WIDE = "18014398509481985";
const code = `
const fs = require('node:fs/promises');
const original = fs.open;
const source = JSON.parse(process.argv[1]);
fs.open = async function(file, ...args) {
  const handle = await original.call(this, file, ...args);
  if (file === source.file) {
    const stat = handle.stat.bind(handle);
    handle.stat = async options => {
      const row = await stat(options), big = !!options?.bigint;
      row.ino = big ? BigInt(process.argv[3]) : Number(process.argv[3]);
      row.dev = big ? BigInt(process.argv[4]) : Number(process.argv[4]);
      return row;
    };
  }
  return handle;
};
const budget = {deadline:Date.now()+10000,bytes:0,maxBytes:1e8};
require(${JSON.stringify(reader)}).readUsageFile(source, budget, process.argv[2]).then(result => {
  console.log(JSON.stringify({bytes:budget.bytes,rows:result.rows.length,partial:result.partial}));
}).catch(e=>{console.error(e);process.exitCode=1;});`;
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-file-id-"))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pi.jsonl"), index = path.join(dir, "index");
  const message = id => JSON.stringify({ type: "message", id, timestamp: "2026-10-10T17:00:00Z", message: { role: "assistant", model: "test-model", usage: { input: 10, output: 20 } } }) + "\n";
  fs.writeFileSync(file, JSON.stringify({ type: "session", id: "pi-test" }) + "\n" + message("one"));
  const source = { file, root: dir, agent: "pi", expected: "pi-test" };
  const read = (ino = WIDE, dev = WIDE) => JSON.parse(execFileSync(process.execPath, ["-e", code, JSON.stringify(source), index, ino, dev], { encoding: "utf8" }));
  const cachePath = () => path.join(index, fs.readdirSync(index)[0]);
  const cache = () => JSON.parse(fs.readFileSync(cachePath(), "utf8"));
  return { file, read, cache, cachePath, message };
}
test("64-bit inode and device identifiers persist exactly and avoid rescanning in a fresh worker", t => {
  const f = fixture(t); assert(f.read().bytes > 0);
  assert.equal(f.cache().state.file.ino, WIDE); assert.equal(f.cache().state.file.dev, WIDE);
  assert.deepEqual(f.read(), { bytes: 0, rows: 1, partial: false });
  const appended = f.message("two"); fs.appendFileSync(f.file, appended);
  const next = f.read(); assert.deepEqual(next, { bytes: Buffer.byteLength(appended), rows: 2, partial: false });
  assert.equal(f.read().bytes, 0);
});
test("distinct 64-bit file IDs with the same rounded Number never reuse another file's index", t => {
  const f = fixture(t); f.read(); const other = String(BigInt(WIDE) + 1n);
  assert.equal(Number(WIDE), Number(other));
  assert(f.read(other).bytes > 0); assert.equal(f.cache().state.file.ino, other);
  assert.equal(f.read(other).bytes, 0);
});
test("legacy numeric indices rebuild once, then cache normally", t => {
  const f = fixture(t); f.read(); const old = f.cache(); old.version = 3;
  old.state.file.ino = Number(WIDE); old.state.file.dev = Number(WIDE);
  fs.writeFileSync(f.cachePath(), JSON.stringify(old)); assert(f.read().bytes > 0); assert.equal(f.cache().version, 4);
  assert.equal(f.read().bytes, 0);
});
for (const id of [-1, "-1", "18446744073709551616", "01"]) test(`invalid persisted file ID ${id} is safely rebuilt`, t => {
  const f = fixture(t); f.read(); const invalid = f.cache(); invalid.state.file.ino = id;
  fs.writeFileSync(f.cachePath(), JSON.stringify(invalid));
  const result = f.read(); assert(result.bytes > 0); assert.equal(result.rows, 1); assert.equal(result.partial, false);
});
