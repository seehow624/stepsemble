"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  createOpenCodeManagedService,
  resolveOpenCodeExecutable,
} = require("../server/opencode-managed-service");

function executableFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-opencode-managed-"));
  const executable = path.join(directory, "opencode");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return executable;
}

function childFixture() {
  const child = new EventEmitter();
  child.pid = 3210;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedSignals = [];
  child.kill = signal => {
    child.killedSignals.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

function jsonResponse(value, status = 200) {
  const bytes = Buffer.from(value === undefined ? "" : JSON.stringify(value));
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => bytes,
  };
}

function serviceFixture(t, options = {}) {
  const executable = executableFixture(t);
  const child = childFixture();
  const calls = [];
  const env = {
    PATH: path.dirname(executable),
    OPENCODE_SERVER_PASSWORD: "inherited-must-not-win",
    OPENCODE_SERVER_USERNAME: "inherited-user",
    ...options.env,
  };
  const service = createOpenCodeManagedService({
    env,
    resolveExecutable: () => executable,
    spawnImpl: (file, args, launch) => {
      calls.push({ file, args, launch });
      if (options.spawnImpl) return options.spawnImpl(file, args, launch);
      return child;
    },
    fetchImpl: options.fetchImpl || (async () => jsonResponse({ healthy: true, version: "synthetic" })),
    portAllocator: options.portAllocator || (async () => 43123),
    randomBytes: options.randomBytes || (() => Buffer.alloc(32, "x")),
    startupTimeoutMs: options.startupTimeoutMs || 1000,
    requestTimeoutMs: options.requestTimeoutMs || 100,
    closeTimeoutMs: options.closeTimeoutMs || 500,
    maxOutputBytes: options.maxOutputBytes || 1024,
  });
  t.after(async () => { await service.close(); });
  return { service, child, calls, env };
}

test("managed OpenCode starts only on demand, binds loopback, and returns private config separately", async t => {
  const requests = [];
  const f = serviceFixture(t, {
    env: {
      OPENCODE_SERVER_HOSTNAME: "0.0.0.0",
      OPENCODE_SERVER_PORT: "9999",
      OPENCODE_SERVER_MDNS: "1",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), headers: options.headers });
      return requests.length === 1 ? jsonResponse({ error: "auth required" }, 401) : jsonResponse({ healthy: true, version: "1.18.5" });
    },
  });

  assert.equal(f.calls.length, 0, "construction must not launch OpenCode");
  const started = await f.service.start();
  assert.equal(started.mode, "managed");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ["serve", "--hostname", "127.0.0.1", "--port", "43123"]);
  assert.equal(f.calls[0].launch.shell, false);
  assert.equal(f.calls[0].launch.env.OPENCODE_SERVER_USERNAME, "opencode");
  assert.notEqual(f.calls[0].launch.env.OPENCODE_SERVER_PASSWORD, "inherited-must-not-win");
  assert.equal(f.calls[0].launch.env.OPENCODE_SERVER_PASSWORD, started.config.password);
  assert.equal(f.calls[0].launch.env.OPENCODE_SERVER_URL, undefined);
  assert.equal(f.calls[0].launch.env.STEPSEMBLE_OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(f.calls[0].launch.env.OPENCODE_SERVER_HOSTNAME, undefined);
  assert.equal(f.calls[0].launch.env.OPENCODE_SERVER_PORT, undefined);
  assert.equal(f.calls[0].launch.env.OPENCODE_SERVER_MDNS, undefined);
  assert.equal(new URL(started.config.baseUrl).hostname, "127.0.0.1");
  assert.ok(started.config.password.length >= 32);
  assert.equal(requests[0].headers.Authorization, undefined, "health must fail closed without auth first");
  assert.match(requests[1].headers.Authorization, /^Basic /);
  assert.equal(f.service.status().password, undefined);
  assert.equal(f.service.status().username, undefined);
  assert.ok(!JSON.stringify(f.service.status()).includes(started.config.password));
  assert.deepEqual(f.service.env(), {
    STEPSEMBLE_OPENCODE_SERVER_URL: started.config.baseUrl,
    STEPSEMBLE_OPENCODE_SERVER_USERNAME: "opencode",
    STEPSEMBLE_OPENCODE_SERVER_PASSWORD: started.config.password,
  });

  await f.service.close();
  assert.deepEqual(f.child.killedSignals, ["SIGTERM"]);
  assert.equal(f.service.status().state, "closed");
  assert.equal(f.service.status().password, undefined);
});

test("start is idempotent while ready and startup logs stop counting after readiness", async t => {
  const f = serviceFixture(t, {
    fetchImpl: async (_url, options) => options.headers.Authorization
      ? jsonResponse({ healthy: true })
      : jsonResponse({ error: "auth required" }, 401),
  });
  await f.service.start();
  await f.service.start();
  assert.equal(f.calls.length, 1, "a ready manager never spawns a second child");
  f.child.stdout.write(Buffer.alloc(16 * 1024, "normal runtime log"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().state, "ready");
  assert.deepEqual(f.child.killedSignals, []);
});

test("explicit endpoint is reused and never overwritten or killed", async t => {
  let spawned = 0;
  let randomCalls = 0;
  const service = createOpenCodeManagedService({
    env: {
      STEPSEMBLE_OPENCODE_SERVER_URL: "http://127.0.0.1:4196",
      STEPSEMBLE_OPENCODE_SERVER_USERNAME: "existing-user",
      STEPSEMBLE_OPENCODE_SERVER_PASSWORD: "existing-password",
    },
    resolveExecutable: () => { throw new Error("must not resolve CLI"); },
    spawnImpl: () => { spawned += 1; throw new Error("must not spawn"); },
    randomBytes: () => { randomCalls += 1; return Buffer.alloc(32); },
  });
  t.after(() => service.close());
  const result = await service.start();
  assert.equal(result.mode, "external");
  assert.equal(result.managed, false);
  assert.equal(result.config.baseUrl, "http://127.0.0.1:4196");
  assert.equal(result.config.password, "existing-password");
  assert.equal(service.status().state, "external");
  assert.equal(service.status().managed, false);
  assert.equal(spawned, 0);
  assert.equal(randomCalls, 0);
  await service.close();
  assert.equal(service.status().state, "closed");
});

test("an existing unauthenticated server on the selected port is never adopted", async t => {
  const calls = [];
  const f = serviceFixture(t, {
    fetchImpl: async (_url, options) => {
      calls.push(options.headers);
      return jsonResponse({ healthy: true, version: "unrelated" }, 200);
    },
  });
  await assert.rejects(f.service.start(), error => error.code === "unauthenticated_health_allowed");
  assert.equal(calls.length, 1, "must stop after an unauthenticated health response");
  assert.equal(f.child.killedSignals[0], "SIGTERM");
  assert.equal(f.service.status().state, "failed");
  assert.equal(f.service.status().password, undefined);
});

test("authentication failure, child startup failure, and port failure are bounded and sanitized", async t => {
  const auth = serviceFixture(t, {
    fetchImpl: async (_url, options) => options.headers.Authorization
      ? jsonResponse({ error: "wrong password" }, 401)
      : jsonResponse({ error: "auth required" }, 401),
  });
  await assert.rejects(auth.service.start(), error => error.code === "authentication_failed");
  assert.equal(auth.child.killedSignals[0], "SIGTERM");
  assert.ok(!JSON.stringify(auth.service.status()).includes("wrong password"));

  const spawnError = serviceFixture(t, { spawnImpl: () => { throw new Error("private inherited password"); } });
  await assert.rejects(spawnError.service.start(), error => error.code === "spawn_failed");
  assert.equal(spawnError.service.status().lastError, "spawn_failed");
  assert.ok(!JSON.stringify(spawnError.service.status()).includes("private"));

  const portError = serviceFixture(t, { portAllocator: async () => 1 });
  await assert.rejects(portError.service.start(), error => error.code === "port_unavailable");
  assert.equal(portError.service.status().state, "failed");
});

test("startup timeout and output limit always clean up the owned process", async t => {
  const timeout = serviceFixture(t, {
    startupTimeoutMs: 250,
    fetchImpl: async () => { throw new Error("ECONNREFUSED private detail"); },
  });
  await assert.rejects(timeout.service.start(), error => error.code === "startup_timeout");
  assert.equal(timeout.child.killedSignals[0], "SIGTERM");
  assert.equal(timeout.service.status().state, "failed");

  const output = serviceFixture(t, {
    fetchImpl: async () => new Promise(() => {}),
    maxOutputBytes: 1024,
    startupTimeoutMs: 500,
  });
  const pending = output.service.start();
  output.child.stdout.write(Buffer.alloc(2048, "x"));
  await assert.rejects(pending, error => error.code === "output_limit");
  assert.equal(output.child.killedSignals[0], "SIGTERM");
  assert.equal(output.service.status().lastError, "output_limit");
  assert.ok(!JSON.stringify(output.service.status()).includes("x".repeat(64)));

  const ignoredAbort = serviceFixture(t, {
    startupTimeoutMs: 250,
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(ignoredAbort.service.start(), error => error.code === "startup_timeout");
  assert.equal(ignoredAbort.child.killedSignals[0], "SIGTERM");
});

test("close during executable or port resolution cannot spawn after cancellation", async t => {
  let releaseExecutable;
  let spawned = 0;
  const executable = executableFixture(t);
  const service = createOpenCodeManagedService({
    env: {},
    resolveExecutable: () => new Promise(resolve => { releaseExecutable = resolve; }),
    portAllocator: async () => 43124,
    spawnImpl: () => { spawned += 1; throw new Error("must not spawn"); },
  });
  const starting = service.start();
  assert.equal(service.status().state, "starting");
  const closing = service.close();
  releaseExecutable(executable);
  await closing;
  await assert.rejects(starting, error => error.code === "service_closed");
  assert.equal(spawned, 0);
  assert.equal(service.status().cleanupConfirmed, true);
});

test("a stubborn owned child remains quarantined when close cannot confirm reaping", async t => {
  const executable = executableFixture(t);
  const child = childFixture();
  child.kill = signal => { child.killedSignals.push(signal); return true; };
  const service = createOpenCodeManagedService({
    env: {}, resolveExecutable: () => executable, portAllocator: async () => 43125,
    spawnImpl: () => child, fetchImpl: async () => jsonResponse({ healthy: true }, 200),
    closeTimeoutMs: 100,
  });
  await assert.rejects(service.start(), error => error.code === "unauthenticated_health_allowed");
  assert.equal(service.status().cleanupConfirmed, false);
  assert.equal(service.status().pid, child.pid);
  await assert.rejects(service.start(), error => error.code === "cleanup_pending");
  await service.close();
  assert.equal(service.status().cleanupConfirmed, false);
});

test("startup cancellation aborts the losing health probe and cancels unauthenticated bodies", async t => {
  let cancelled = false;
  let bodyCancelled = false;
  const f = serviceFixture(t, {
    fetchImpl: async (_url, options) => {
      if (!options.headers.Authorization) {
        return { status: 401, body: { cancel: async () => { bodyCancelled = true; } } };
      }
      return new Promise((resolve, reject) => {
        const abort = () => { cancelled = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
        options.signal.addEventListener("abort", abort, { once: true });
        // This would be an authenticated health response if close() did not
        // cancel the losing promise.
        void resolve;
      });
    },
  });
  const pending = f.service.start();
  await new Promise(resolve => setImmediate(resolve));
  await f.service.close();
  await assert.rejects(pending, error => error.code === "service_closed" || error.code === "health_timeout");
  assert.equal(cancelled, true);
  assert.equal(bodyCancelled, true);
});

test("binary resolution honors only an absolute opencode binary and the ~/.opencode/bin fallback", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-opencode-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, ".opencode", "bin");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fallback = path.join(directory, "opencode");
  fs.writeFileSync(fallback, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(resolveOpenCodeExecutable({ env: { HOME: home, PATH: "" }, platform: process.platform }), fallback);
  assert.equal(resolveOpenCodeExecutable({ env: { STEPSEMBLE_OPENCODE_BIN: "/tmp/not-opencode", HOME: home }, platform: process.platform }), null);
  assert.equal(resolveOpenCodeExecutable({ env: { STEPSEMBLE_OPENCODE_BIN: fallback, HOME: home }, platform: process.platform }), fallback);
});

test("unexpected child exit degrades a ready managed service without retaining its secret", async t => {
  const f = serviceFixture(t, {
    fetchImpl: async (_url, options) => options.headers.Authorization
      ? jsonResponse({ healthy: true })
      : jsonResponse({ error: "auth required" }, 401),
  });
  const result = await f.service.start();
  const secret = result.config.password;
  f.child.emit("close", 17, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().state, "failed");
  assert.equal(f.service.status().lastError, "process_exit");
  assert.ok(!JSON.stringify(f.service.status()).includes(secret));
  assert.equal(f.service.config().password, null);
});

test("a child that exits during the final health response is rejected before ready", async t => {
  const f = serviceFixture(t, {
    fetchImpl: async (_url, options) => {
      if (!options.headers.Authorization) return jsonResponse({ error: "auth required" }, 401);
      f.child.emit("close", 17, null);
      return jsonResponse({ healthy: true });
    },
  });
  await assert.rejects(f.service.start(), error => error.code === "process_exit");
  assert.equal(f.service.status().state, "failed");
  assert.equal(f.service.status().ready, false);
});
