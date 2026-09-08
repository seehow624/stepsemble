"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), syncFs = require("node:fs");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), Module = require("node:module");
const { pathToFileURL } = require("node:url"), { spawn } = require("node:child_process");
const filename = path.resolve(__dirname, "../protocol/native/claude/history-sdk.js"), implementation = syncFs.readFileSync(filename, "utf8");
const source = 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);const path=require("node:path");export function getSessionMessages(){return path.basename("/synthetic/verified")};\n';
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
// Test-only isolated CommonJS instances change the compiled-in SDK pin to an
// owned synthetic module. Production loadReader has no injection/override API.
function loader(expected = source, { io = fs, hooks = Module.registerHooks } = {}) {
  const child = new Module(filename, module), counters = { registered: 0, deregistered: 0, loaded: 0 };
  child.filename = filename; child.paths = module.paths;
  child.require = name => name === "node:fs/promises" ? io : name === "../../../public/modules/claude-history"
    ? { READER: { sdkVersion: "fixture", nativeVersion: "fixture", sdkSha256: digest(expected) } }
    : name === "node:module" ? { registerHooks: hooks && (options => {
      counters.registered++;
      const handle = hooks({ ...options, load(url, context, next) {
        const result = options.load(url, context, next); if (result.shortCircuit && result.source) counters.loaded++; return result;
      } });
      return { deregister() { counters.deregistered++; handle.deregister(); } };
    }) } : require(name);
  child._compile(implementation, filename);
  return { ...child.exports, counters };
}
async function fixture(t, bytes = source) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-sdk-loader-")));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const sdkPath = path.join(home, "sdk.mjs"); await fs.writeFile(sdkPath, bytes, { mode: 0o600 });
  return { home, sdkPath };
}
test("verified bytes supply exactly one module load while retaining file URL createRequire semantics", async t => {
  const f = await fixture(t), sdk = loader(), read = await sdk.loadReader(f.sdkPath);
  assert.equal(read(), "verified"); assert.deepEqual(sdk.counters, { registered: 1, deregistered: 1, loaded: 1 });
  await assert.rejects(sdk.loadReader(f.sdkPath), /^Error: sdk_unavailable$/);
  assert.deepEqual(sdk.counters, { registered: 1, deregistered: 1, loaded: 1 });
});
test("same-path preexisting ESM namespace cannot replace the freshly verified SDK module", async t => {
  const poison = 'export function getSessionMessages(){return "old-cache"}\n', f = await fixture(t, poison);
  const old = await import(pathToFileURL(f.sdkPath).href); assert.equal(old.getSessionMessages(), "old-cache");
  await fs.writeFile(f.sdkPath, source);
  const sdk = loader(), reader = await sdk.loadReader(f.sdkPath); assert.equal(reader(), "verified"); assert.notEqual(reader, old.getSessionMessages);
  assert.equal(sdk.counters.loaded, 1);
});
test("swap and restore between verification and import executes only captured hash-verified bytes", async t => {
  const f = await fixture(t); let swapped = false;
  const evil = 'globalThis.__stepsembleSdkWrongBytes=true;export function getSessionMessages(){return "wrong"}\n';
  delete globalThis.__stepsembleSdkWrongBytes;
  const sdk = loader(source, { hooks(options) {
    return Module.registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.includes("?stepsemble_verified=")) { syncFs.writeFileSync(f.sdkPath, evil); swapped = true; }
      return options.resolve(specifier, context, nextResolve);
    }, load(url, context, nextLoad) {
      const result = options.load(url, context, nextLoad);
      if (url.includes("?stepsemble_verified=")) syncFs.writeFileSync(f.sdkPath, source);
      return result;
    } });
  } });
  assert.equal((await sdk.loadReader(f.sdkPath))(), "verified"); assert.equal(swapped, true);
  assert.equal(globalThis.__stepsembleSdkWrongBytes, undefined); assert.equal(sdk.counters.deregistered, 1);
});
test("a swapped symlink cannot redirect default module resolution before the verified load hook", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), alternate = path.join(f.home, "alternate.mjs");
  await fs.writeFile(alternate, 'globalThis.__stepsembleSdkSymlinkExecuted=true;export function getSessionMessages(){return "wrong"}\n');
  delete globalThis.__stepsembleSdkSymlinkExecuted;
  const sdk = loader(source, { hooks(options) {
    return Module.registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.includes("?stepsemble_verified=")) { syncFs.unlinkSync(f.sdkPath); syncFs.symlinkSync(alternate, f.sdkPath); }
      return options.resolve(specifier, context, nextResolve);
    }, load(url, context, nextLoad) {
      const result = options.load(url, context, nextLoad);
      if (url.includes("?stepsemble_verified=")) { syncFs.unlinkSync(f.sdkPath); syncFs.writeFileSync(f.sdkPath, source, { mode: 0o600 }); }
      return result;
    } });
  } });
  assert.equal((await sdk.loadReader(f.sdkPath))(), "verified");
  assert.equal(globalThis.__stepsembleSdkSymlinkExecuted, undefined); assert.equal(sdk.counters.deregistered, 1);
});
test("post-evaluation artifact drift still rejects a verified module and deregisters hooks", async t => {
  const f = await fixture(t), sdk = loader(source, { hooks(options) {
    return Module.registerHooks({ ...options, load(url, context, next) {
      const result = options.load(url, context, next);
      if (url.includes("?stepsemble_verified=")) syncFs.writeFileSync(f.sdkPath, "changed artifact\n");
      return result;
    } });
  } });
  await assert.rejects(sdk.loadReader(f.sdkPath), /^Error: sdk_unavailable$/);
  assert.deepEqual(sdk.counters, { registered: 1, deregistered: 1, loaded: 1 });
  await fs.writeFile(f.sdkPath, source); await assert.rejects(sdk.loadReader(f.sdkPath), /sdk_unavailable/);
});
test("hash failure, unavailable hook API and failed evaluation each consume the sole attempt", async t => {
  const f = await fixture(t, "untrusted bytes"), sdk = loader();
  await assert.rejects(sdk.loadReader(f.sdkPath), /^Error: sdk_unavailable$/); assert.equal(sdk.counters.registered, 0);
  await fs.writeFile(f.sdkPath, source); await assert.rejects(sdk.loadReader(f.sdkPath), /sdk_unavailable/);
  const unsupported = loader(source, { hooks: null }); await assert.rejects(unsupported.loadReader(f.sdkPath), /sdk_unavailable/);
  const invalid = 'throw new Error("private-path-do-not-expose");export function getSessionMessages(){}\n';
  await fs.writeFile(f.sdkPath, invalid); const broken = loader(invalid);
  await assert.rejects(broken.loadReader(f.sdkPath), /^Error: sdk_unavailable$/);
  assert.deepEqual(broken.counters, { registered: 1, deregistered: 1, loaded: 1 });
  await assert.rejects(broken.loadReader(f.sdkPath), /sdk_unavailable/);
});
test("read uses bounded chunks and rejects growth, short reads and uncertain close without importing", async t => {
  for (const kind of ["growth", "short", "close"]) {
    const f = await fixture(t); let reads = 0, closes = 0; const lengths = [];
    const io = { ...fs, async open(...args) {
      const handle = await fs.open(...args);
      return { stat: options => handle.stat(options), async read(buffer, offset, length, position) {
        reads++; lengths.push(length);
        if (kind === "short") return { bytesRead: 0 };
        const result = await handle.read(buffer, offset, length, position);
        if (kind === "growth" && reads === 1) await fs.appendFile(f.sdkPath, Buffer.alloc(4 * 1024 * 1024));
        return result;
      }, async close() { closes++; await handle.close(); if (kind === "close") throw new Error("private-close-state"); } };
    } };
    const sdk = loader(source, { io }); await assert.rejects(sdk.loadReader(f.sdkPath), /^Error: sdk_unavailable$/);
    assert.equal(closes, 1); assert.equal(sdk.counters.registered, 0); assert.ok(lengths.every(n => n <= 64 * 1024));
    assert.ok(reads <= 2); await assert.rejects(sdk.loadReader(f.sdkPath), /sdk_unavailable/); assert.equal(closes, 1);
  }
});
test("oversize and symlink SDK entries reject before opening or registering a loader", async t => {
  const f = await fixture(t, Buffer.alloc(4 * 1024 * 1024 + 1)); let opens = 0;
  const io = { ...fs, async open(...args) { opens++; return fs.open(...args); } }, oversized = loader(source, { io });
  await assert.rejects(oversized.loadReader(f.sdkPath), /sdk_unavailable/); assert.equal(opens, 0);
  if (process.platform !== "win32") {
    const linked = path.join(f.home, "real-sdk.mjs"); await fs.rename(f.sdkPath, linked); await fs.symlink(linked, f.sdkPath);
    const sdk = loader(source, { io }); await assert.rejects(sdk.loadReader(f.sdkPath), /sdk_unavailable/); assert.equal(opens, 0);
  }
});
test("synchronous verified-source hooks work inside the existing permission profile without worker or child grants", async t => {
  const f = await fixture(t), sourceJSON = JSON.stringify(source), url = pathToFileURL(f.sdkPath).href;
  const script = `const {registerHooks}=require('node:module');const url=${JSON.stringify(url)}+'?canary';const source=${sourceJSON};
    const hook=registerHooks({resolve(s,c,next){return s===url?{url,format:'module',shortCircuit:true}:next(s,c)},load(s,c,next){return s===url?{format:'module',source,shortCircuit:true}:next(s,c)}});
    import(url).then(m=>{hook.deregister();if(m.getSessionMessages()!=='verified'||process.permission.has('worker')||process.permission.has('child')||process.permission.has('fs.write'))process.exitCode=1;else process.stdout.write('verified');},()=>{hook.deregister();process.exitCode=2;});`;
  const child = spawn(process.execPath, ["--permission", "--no-warnings", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: {} });
  const chunks = []; child.stdout.on("data", b => chunks.push(b)); child.stderr.resume();
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0); assert.equal(Buffer.concat(chunks).toString(), "verified");
});
