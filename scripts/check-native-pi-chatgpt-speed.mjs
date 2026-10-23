// Installed bundled Pi, fake OAuth in a unique private HOME, injected fetch/WS.
// No sockets, real credentials, paid calls, installed writes or global settings.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2];
assert(entry && path.isAbsolute(entry), "absolute installed bundled Pi CLI entry required");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-chatgpt-speed-"));
let child;
try {
  for (const transport of ["sse", "websocket", "auto"]) {
    const dir = path.join(temp, transport); await fs.mkdir(dir);
    const capturePath = path.join(dir, "captures.jsonl"), authPath = path.join(dir, "auth.json"), countPath = path.join(dir, "header-count");
    const access = ["e30", Buffer.from(JSON.stringify({ sub: "fake-user", exp: 4102444800,
      "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url"), "first"].join(".");
    await fs.writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "fake-only", expires: 4102444800000 } }), { mode: 0o600 });
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ transport, cacheWarming: { mode: "off" } }));
    const headerScript = path.join(dir, "header.cjs");
    await fs.writeFile(headerScript, `require('node:fs').appendFileSync(${JSON.stringify(countPath)}, 'x'); process.stdout.write('preserved');`);
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await fs.writeFile(path.join(dir, "models.json"), JSON.stringify({ providers: { "openai-codex": {
      headers: { "x-fixture": "!" + quote(process.execPath) + " " + quote(headerScript) },
      modelOverrides: { "gpt-6-astra": { name: "Configured synthetic" } } } } }));
    const env = { HOME: dir, PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1",
      STEPSEMBLE_FAKE_CAPTURE: capturePath, STEPSEMBLE_FAKE_AUTH: authPath, STEPSEMBLE_FAKE_HEADER_COUNT: countPath };
    child = spawn(process.execPath, [entry, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "-e", path.join(root, "test-support/pi-native-speed-bootstrap.ts"), "-e", path.join(root, "server/pi-speed-extension.mjs"),
      "--provider", "openai-codex", "--model", "gpt-6-astra", "--thinking", "xhigh", "--session", path.join(dir, "session.jsonl")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "close"), frames = [], pending = new Set(); let buffer = "", id = 0;
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        frames.push(frame); for (const waiter of [...pending]) if (waiter.match(frame)) waiter.resolve(frame);
      }
    });
    const wait = (match, start = frames.length) => {
      const existing = frames.slice(start).find(match); if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: frame => { clearTimeout(timer); pending.delete(waiter); resolve(frame); } };
        const timer = setTimeout(() => { pending.delete(waiter); reject(new Error(`synthetic ${transport} RPC timed out (exit ${child.exitCode})`)); }, 20000);
        pending.add(waiter);
      });
    };
    const rpc = async (type, fields = {}) => {
      const requestId = "fixture-" + ++id, response = wait(frame => frame.type === "response" && frame.id === requestId);
      child.stdin.write(JSON.stringify({ type, id: requestId, ...fields }) + "\n");
      const result = await response; assert.equal(result.success, true, type); return result.data;
    };
    const control = async (action, speed, fingerprint) => {
      const nonce = "speed-" + ++id;
      await rpc("prompt", { message: "/stepsemble-speed " + JSON.stringify({ action, speed, fingerprint, nonce }) });
      const entries = await rpc("get_entries");
      const receipt = entries.entries.findLast(row => row.customType === "stepsemble-speed" && row.data?.nonce === nonce)?.data;
      assert.equal(receipt?.ok, true, "owned native capability receipt"); return receipt;
    };
    const readCaptures = async () => (await fs.readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const prompt = async () => { const start = frames.length; await rpc("prompt", { message: "synthetic" }); await wait(frame => frame.type === "agent_end", start); };
    const state = await rpc("get_state"); assert.equal(state.model.id, "gpt-6-astra");
    await rpc("prompt", { message: "/fixture auth-once" });
    const composition = (await readCaptures()).find(row => row.kind === "composition");
    assert.deepEqual(composition, { kind: "composition", headerExecutions: 1, authPreserved: true, refreshPreserved: true, catalogPreserved: true, configuredName: "Configured synthetic", cleanupAvailable: true });
    const cap = await control("get"); assert.equal(cap.capability.support, "supported"); assert.equal(cap.requested, "standard");
    await control("set", "standard"); await prompt();
    await rpc("prompt", { message: "/fixture warm-other" });
    await rpc("prompt", { message: "/fixture rotate" });
    await control("set", "fast", cap.capability.fingerprint); await prompt();
    await control("set", "standard"); await prompt();
    const captures = await readCaptures(), own = captures.filter(row => row.kind === "wire" && row.session === state.sessionId);
    assert.equal(own.length, 3, "Standard/Fast/Standard actual requests");
    assert.deepEqual(own.map(row => row.tier), [null, "priority", null]);
    assert(own.every(row => row.model === "gpt-6-astra" && row.effort === "xhigh" && row.accountMatches && row.unrelatedHeader === "preserved"));
    assert.equal(own[1].credential, "rotated", "paid WS cannot reuse old credential's warm connection");
    if (transport !== "sse") {
      assert.notEqual(own[0].connection, own[1].connection);
      assert(captures.some(row => row.kind === "close" && row.connection === own[0].connection));
    }
    const other = captures.find(row => row.kind === "wire" && row.session === "synthetic-other-session");
    assert(other); assert.equal(captures.some(row => row.kind === "close" && row.connection === other.connection), false, "never close another session");
    await rpc("prompt", { message: "/fixture busy" });
    const busyBefore = await readCaptures(), busyWire = busyBefore.filter(row => row.kind === "wire").at(-1);
    await control("set", "fast", cap.capability.fingerprint); await prompt();
    const busyAfter = await readCaptures();
    assert.equal(busyAfter.filter(row => row.kind === "wire").length, busyBefore.filter(row => row.kind === "wire").length, "busy same-session call forbids paid dispatch");
    assert.equal(busyAfter.filter(row => row.kind === "close").length, busyBefore.filter(row => row.kind === "close").length, "never close an in-flight connection");
    assert.equal(busyWire.session, state.sessionId);
    await rpc("prompt", { message: "/fixture finish-busy" });
    const beforeRevoke = (await readCaptures()).filter(row => row.kind === "wire").length;
    await rpc("prompt", { message: "/fixture revoke" }); await prompt();
    assert.equal((await readCaptures()).filter(row => row.kind === "wire").length, beforeRevoke, "revoked paid dispatch never sends fallback inference");
    await control("set", "standard"); await prompt();
    assert.equal((await readCaptures()).filter(row => row.kind === "wire" && row.session === state.sessionId).at(-1).tier, null);
    await rpc("prompt", { message: "/fixture offer" });
    if (transport !== "websocket") for (const status of [307, 308]) {
      await control("set", "fast", cap.capability.fingerprint);
      await rpc("prompt", { message: "/fixture redirect " + status });
      const before = await readCaptures(); await prompt(); const after = await readCaptures(), delta = after.slice(before.length);
      const redirect = delta.find(row => row.kind === "redirect");
      assert.equal(redirect?.status, status); assert.equal(redirect.policy, "error", "paid SSE must not follow redirects");
      assert.equal(delta.some(row => row.kind === "redirect-target"), false, "no redirected target receives paid body or account header");
      assert(delta.some(row => row.kind === "wire" && row.transport === "sse" && row.tier === "priority"));
      if (transport === "auto" && status === 307) assert(delta.some(row => row.kind === "websocket-rejected"), "exercise actual auto to SSE fallback");
      await control("set", "standard"); await prompt();
      const standard = (await readCaptures()).slice(after.length);
      assert(standard.some(row => row.kind === "redirect-target" && !row.paidBody), "Standard recovery retains normal fetch redirect semantics");
      await rpc("prompt", { message: "/fixture redirect 0" });
    }
    const beforeStale = (await readCaptures()).filter(row => row.kind === "wire").length;
    await rpc("prompt", { message: "/fixture stale-probe" });
    const stale = await readCaptures();
    assert.deepEqual(stale.findLast(row => row.kind === "stale-owner"), { kind: "stale-owner", oldRequestBlocked: true, newTurnAborted: false, foreignReceiptCount: 0 });
    assert.equal(stale.filter(row => row.kind === "wire").length, beforeStale, "stale actual SDK callback dispatches no inference");
    await control("set", "fast", cap.capability.fingerprint);
    await rpc("prompt", { message: "/fixture switch-at-payload" });
    const beforeSwitch = (await readCaptures()).filter(row => row.kind === "wire").length;
    await prompt();
    assert.equal((await readCaptures()).filter(row => row.kind === "wire").length, beforeSwitch, "captured A versus current B aborts in actual SDK ordering");
    child.kill("SIGTERM"); await exited; child = null;
    console.log(JSON.stringify({ transport, result: "passed", exactModel: "gpt-6-astra", effort: "xhigh", tiers: [null, "priority", null],
      paidRedirectRejection: transport !== "websocket", staleOwnerSideEffectsPrevented: true, sameBundledCacheCleanup: true, refreshedCredential: true, otherSessionPreserved: true, singleHeaderComposition: true, busySessionPreserved: true, capturedAccountSwitchAborted: true, revokedAbort: true, standardRecovery: true, networkCalls: 0, paidCalls: 0 }));
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close"); child.kill("SIGTERM"); await closed.catch(() => {});
  }
  await fs.rm(temp, { recursive: true, force: true });
}
