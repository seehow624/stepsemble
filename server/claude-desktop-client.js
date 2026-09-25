"use strict";

const http = require("node:http"), fs = require("node:fs/promises"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { Writable, PassThrough } = require("node:stream");
const { desktopPaths, privateDirectory, privateRead, UUID, failure } = require("./claude-desktop-state");
const { normalize } = require("../public/modules/claude-auth");
const {
  STRUCTURED_STREAM_VERSION,
  FRAME_TYPES,
  MAX_PAYLOAD_BYTES,
  MAX_BUFFER_BYTES,
  StructuredFrameDecoder,
  encodeFrame,
  decodeJson,
  safeSignal,
} = require("./claude-desktop-structured-stream");

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PERMISSION_TOOL = /^[A-Za-z0-9_.:-]{1,256}$/;
const STRUCTURED_HANDSHAKE_TIMEOUT_MS = 10000;

function createDesktopClaudeClient({ configDir, timeoutMs = 45000, hasActiveTasks = () => false } = {}) {
  const paths = desktopPaths(configDir), requests = new Set(), upgradedSockets = new Set();
  let cached = null, closed = false;
  function offline(state = "desktop_required") { return { credential: { state, checkedAt: null, liveVerified: false }, canStart: false, blockedReason: null, login: null }; }
  async function call(op, body = {}, { maxBytes = 8192 } = {}) {
    if (closed) throw failure("service_closed");
    await privateDirectory(paths.directory); await privateDirectory(paths.socketDirectory);
    const key = (await privateRead(paths.key, 128)).trim(), socket = await fs.lstat(paths.socket);
    if (!/^[a-f0-9]{64}$/.test(key) || !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077)) throw failure("desktop_required");
    return new Promise((resolve, reject) => {
      let sent = false;
      const req = http.request({ socketPath: paths.socket, method: "POST", path: `/v1/${op}`, agent: false,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "connection": "close" } }, res => {
        let bytes = 0, chunks = [];
        res.on("data", chunk => { bytes += chunk.length; if (bytes > maxBytes) req.destroy(failure("desktop_required", sent)); else chunks.push(chunk); });
        res.on("error", () => req.destroy(failure("desktop_required", sent)));
        res.on("end", () => {
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(failure("desktop_required", sent)); return; }
          if (res.statusCode !== 200) {
            const codes = ["invalid_request", "stale_intent", "active_tasks", "other_auth", "login_unavailable", "service_closed", "claude_login_active", "desktop_recovery_required", "desktop_workspace_denied", "desktop_capacity", "desktop_sign_in_required", "desktop_launch_uncertain", "desktop_structured_unavailable", "desktop_structured_launch_uncertain", "desktop_structured_stream_failed", "desktop_structured_stream_closed",
              "auth_run_active", "run_not_found", "run_ended", "secret_required", "action_unsupported"];
            reject(failure(codes.includes(value.code) ? value.code : "desktop_required", value.uncertain === true)); return;
          }
          resolve(value);
        });
      });
      requests.add(req);
      const deadline = setTimeout(() => req.destroy(failure("desktop_required", sent)), timeoutMs);
      req.once("finish", () => { sent = true; });
      req.once("close", () => { requests.delete(req); clearTimeout(deadline); });
      req.once("error", () => reject(failure("desktop_required", sent)));
      req.end(JSON.stringify(body));
    });
  }
  function accept(value) {
    const clean = normalize(value);
    cached = { ...clean, credential: { ...clean.credential, checkedAt: Number.isSafeInteger(value.credential.checkedAt) ? value.credential.checkedAt : null },
      ...(value.version === 1 && value.context === "Aqua" && UUID.test(value.instance) ? {
        version: 1, context: "Aqua", instance: value.instance,
        ...(value.structuredStreamVersion === STRUCTURED_STREAM_VERSION ? { structuredStreamVersion: STRUCTURED_STREAM_VERSION } : {}),
        ...(Number.isSafeInteger(value.activeStructured) && value.activeStructured >= 0 && value.activeStructured <= 4 ? { activeStructured: value.activeStructured } : {}),
        ...(value.maintenanceVersion === 1 && value.maintenance && typeof value.maintenance === "object" ? { maintenanceVersion: 1, maintenance: {
          active: value.maintenance.active === true,
          expiresAt: Number.isSafeInteger(value.maintenance.expiresAt) ? value.maintenance.expiresAt : null,
        } } : {}),
      } : {}) };
    return { ...cached, canStart: clean.canStart && !hasActiveTasks(), blockedReason: hasActiveTasks() ? "active_tasks" : clean.blockedReason };
  }
  async function status() {
    try {
      const value = await call("status");
      if (value.version !== 1 || value.context !== "Aqua" || !UUID.test(value.instance)) throw failure("desktop_required");
      return accept(value);
    } catch (error) { cached = offline(error.code === "desktop_recovery_required" ? error.code : "desktop_required"); return cached; }
  }
  async function authAction(action, id) {
    if (action !== "cancel" && hasActiveTasks()) throw failure("active_tasks");
    try { return accept(await call(`auth/${action}`, action === "prepare" ? {} : { id })); }
    catch (error) { cached = null; throw error; }
  }
  async function launchTask(task) {
    let prepared;
    try { prepared = await call("task/prepare", task); }
    catch (error) { throw failure(error.code || "desktop_required"); } // Preparation cannot start a CLI.
    if (!UUID.test(prepared.ticket) || !UUID.test(prepared.instance)) throw failure("desktop_required");
    const result = await call("task/launch", { ticket: prepared.ticket, instance: prepared.instance });
    if (!Number.isSafeInteger(result.pid) || result.pid < 2 || !["pty", "pipe"].includes(result.transport)) throw failure("desktop_launch_uncertain", true);
    return { pid: result.pid, transport: result.transport };
  }

  function structuredInputError(code) {
    const error = new Error(code); error.code = code; return error;
  }
  function writeSocketFrame(socket, frame, timeoutMs = timeoutMsDefault()) {
    if (!socket || socket.destroyed || socket.writable === false) return Promise.reject(structuredInputError("desktop_structured_stream_closed"));
    if (!Buffer.isBuffer(frame) || frame.length > MAX_PAYLOAD_BYTES + 5) return Promise.reject(structuredInputError("desktop_structured_frame_too_large"));
    if (socket.write(frame)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(structuredInputError("desktop_structured_frame_timeout")), timeoutMs);
      timer.unref?.();
      const done = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        socket.off("drain", onDrain); socket.off("close", onClose); socket.off("error", onError);
        error ? reject(error) : resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(structuredInputError("desktop_structured_stream_closed"));
      const onError = () => done(structuredInputError("desktop_structured_stream_failed"));
      socket.once("drain", onDrain); socket.once("close", onClose); socket.once("error", onError);
    });
  }
  function timeoutMsDefault() { return Math.min(Math.max(Number(timeoutMs) || 45000, 1000), 45000); }
  function launchStructured({ cwd, sessionId = null, permissionPromptTool = null } = {}) {
    if (closed) return Promise.reject(failure("service_closed"));
    if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || cwd.length > 4096) return Promise.reject(failure("invalid_request"));
    if (!(sessionId === null || typeof sessionId === "string" && sessionId.length <= 256 && SESSION_ID.test(sessionId))) return Promise.reject(failure("invalid_request"));
    if (!(permissionPromptTool === null || typeof permissionPromptTool === "string" && PERMISSION_TOOL.test(permissionPromptTool))) return Promise.reject(failure("invalid_request"));
    const startedAt = Date.now();
    return call("structured/prepare", { cwd, sessionId, permissionPromptTool, startedAt }).then(async prepared => {
      if (!UUID.test(prepared.ticket) || !UUID.test(prepared.instance) || prepared.structuredStreamVersion !== STRUCTURED_STREAM_VERSION) throw failure("desktop_structured_unavailable");
      let key;
      try { key = (await privateRead(paths.key, 128)).trim(); } catch { throw failure("desktop_required"); }
      if (!/^[a-f0-9]{64}$/.test(key)) throw failure("desktop_required");
      return new Promise((resolve, reject) => {
        let settled = false, upgraded = false;
        const req = http.request({ socketPath: paths.socket, method: "GET", path: "/v1/structured/stream", agent: false,
          headers: { authorization: `Bearer ${key}`, connection: "Upgrade", upgrade: "stepsemble-structured-v1",
            "x-stepsemble-ticket": prepared.ticket, "x-stepsemble-instance": prepared.instance } });
        requests.add(req);
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          req.destroy(failure("desktop_structured_launch_uncertain", true));
          reject(failure("desktop_structured_launch_uncertain", true));
        }, STRUCTURED_HANDSHAKE_TIMEOUT_MS);
        timer.unref?.();
        const fail = (code = "desktop_structured_launch_uncertain", uncertain = true) => {
          if (settled) return;
          settled = true; clearTimeout(timer); requests.delete(req);
          reject(failure(code, uncertain));
        };
        req.once("upgrade", (res, socket, head) => {
          upgraded = true;
          const decoder = new StructuredFrameDecoder({ frameTimeoutMs: timeoutMsDefault() });
          const child = new EventEmitter();
          child.on("error", () => {});
          const stdout = new PassThrough({ highWaterMark: MAX_BUFFER_BYTES });
          const stderr = new PassThrough({ highWaterMark: 1024 });
          let closedChild = false, ready = false, outputPaused = false, closeFramePending = false;
          let writeChain = Promise.resolve(), queuedInputBytes = 0;
          const pendingAcks = [];
          upgradedSockets.add(socket);
          child.stdout = stdout; child.stderr = stderr; child.stdin = null; child.pid = null;
          child.killed = false; child.exitCode = null; child.signalCode = null;
          const originalRead = stdout._read.bind(stdout);
          stdout._read = size => {
            originalRead(size);
            if (outputPaused && !closedChild) { outputPaused = false; socket.resume(); }
          };
          const settleChild = (code, signal, lost = false) => {
            if (closedChild) return;
            closedChild = true; clearTimeout(timer); requests.delete(req);
            upgradedSockets.delete(socket);
            while (pendingAcks.length) {
              const pending = pendingAcks.shift();
              clearTimeout(pending.timer);
              pending.reject(structuredInputError("desktop_structured_stream_closed"));
            }
            child.exitCode = Number.isInteger(code) ? code : null;
            child.signalCode = typeof signal === "string" ? signal : null;
            if (lost) {
              child.__cleanupConfirmed = false;
              child.emit("error", structuredInputError("desktop_structured_stream_closed"));
              stdout.end(); stderr.end();
              try { child.stdin?.destroy?.(); } catch {}
              // A dropped IPC connection is not proof that the Aqua process
              // was reaped. Do not emit ChildProcess `close` in this case;
              // the adapter's bounded cleanup timeout remains truthful.
              return;
            }
            stdout.end(); stderr.end();
            try { child.stdin?.destroy?.(); } catch {}
            child.emit("exit", child.exitCode, child.signalCode);
            child.emit("close", child.exitCode, child.signalCode);
          };
          const failStream = code => {
            if (!closedChild) child.emit("error", structuredInputError(code));
            if (!ready && !settled) {
              settled = true; clearTimeout(timer); requests.delete(req);
              reject(failure(code, true));
            }
            if (!closedChild) settleChild(null, null, true);
            try { socket.destroy(); } catch {}
          };
          const send = (frame, { ack = false } = {}) => {
            if (closedChild) return Promise.reject(structuredInputError("desktop_structured_stream_closed"));
            if (queuedInputBytes + frame.length > MAX_BUFFER_BYTES) return Promise.reject(structuredInputError("desktop_structured_input_full"));
            queuedInputBytes += frame.length;
            let ackPromise = Promise.resolve();
            if (ack) {
              ackPromise = new Promise((resolveAck, rejectAck) => {
                const pending = { resolve: resolveAck, reject: rejectAck, timer: null };
                pending.timer = setTimeout(() => {
                  const index = pendingAcks.indexOf(pending);
                  if (index >= 0) pendingAcks.splice(index, 1);
                  rejectAck(structuredInputError("desktop_structured_frame_timeout"));
                  failStream("desktop_structured_frame_timeout");
                }, timeoutMsDefault());
                pending.timer.unref?.();
                pendingAcks.push(pending);
              });
            }
            writeChain = writeChain.catch(() => {}).then(() => writeSocketFrame(socket, frame, timeoutMsDefault()))
              .then(() => ackPromise)
              .finally(() => { queuedInputBytes = Math.max(0, queuedInputBytes - frame.length); });
            return writeChain;
          };
          const stdin = new Writable({ highWaterMark: MAX_BUFFER_BYTES, write(chunk, encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            if (!bytes.length) return callback();
            if (bytes.length > MAX_PAYLOAD_BYTES) return callback(structuredInputError("desktop_structured_frame_too_large"));
            send(encodeFrame(FRAME_TYPES.STDIN, bytes), { ack: true }).then(() => callback(), callback);
          }, final(callback) { send(encodeFrame(FRAME_TYPES.END), { ack: true }).then(() => callback(), callback); }, destroy(error, callback) { callback(error); } });
          child.stdin = stdin;
          child.kill = signal => {
            if (closedChild) return false;
            const requested = safeSignal(signal);
            child.killed = true;
            // Bypass the prompt ACK queue: termination must still reach the
            // helper when a native stdin write is stuck under backpressure.
            void writeSocketFrame(socket, encodeFrame(FRAME_TYPES.KILL, Buffer.from(requested, "utf8")), timeoutMsDefault()).catch(() => {});
            return true;
          };
          decoder.on("frame", frame => {
            if (closedChild) return;
            if (frame.type === FRAME_TYPES.READY) {
              let hello;
              try { hello = decodeJson(frame.payload); } catch { return failStream("desktop_structured_stream_failed"); }
              if (hello.version !== 1 || hello.structuredStreamVersion !== STRUCTURED_STREAM_VERSION || (hello.pid !== null && hello.pid !== undefined && !Number.isSafeInteger(hello.pid))) return failStream("desktop_structured_stream_failed");
              ready = true; child.pid = Number.isSafeInteger(hello.pid) ? hello.pid : null;
              if (!settled) { settled = true; clearTimeout(timer); requests.delete(req); resolve(child); }
            } else if (frame.type === FRAME_TYPES.ACK) {
              const pending = pendingAcks.shift();
              if (!pending) return failStream("desktop_structured_stream_failed");
              clearTimeout(pending.timer);
              pending.resolve();
            } else if (frame.type === FRAME_TYPES.STDOUT) {
              if (!stdout.push(frame.payload) && !outputPaused) {
                outputPaused = true; socket.pause();
              }
            } else if (frame.type === FRAME_TYPES.CLOSE) {
              let close;
              try { close = decodeJson(frame.payload); } catch { return failStream("desktop_structured_stream_failed"); }
              if (!ready && !settled) {
                settled = true; clearTimeout(timer); requests.delete(req);
                reject(failure("desktop_structured_launch_uncertain", true));
              }
              // Resolve launchStructured first, then deliver close on the
              // next microtask. A process that exits in the same packet as
              // READY must still be observed by the adapter listener that is
              // attached immediately after the promise resolves.
              closeFramePending = true;
              setImmediate(() => {
                closeFramePending = false;
                settleChild(Number.isInteger(close.code) ? close.code : null, typeof close.signal === "string" ? close.signal : null);
              });
            } else if (frame.type === FRAME_TYPES.ERROR) {
              let detail; try { detail = decodeJson(frame.payload); } catch { detail = null; }
              failStream(typeof detail?.code === "string" ? detail.code : "desktop_structured_stream_failed");
            } else failStream("desktop_structured_stream_failed");
          });
          decoder.on("error", () => failStream("desktop_structured_stream_failed"));
          socket.on("data", chunk => decoder.push(chunk));
          socket.on("end", () => { decoder.end(); setImmediate(() => { if (!closedChild && !closeFramePending) failStream("desktop_structured_stream_closed"); }); });
          socket.on("close", () => { setImmediate(() => { if (!closedChild && !closeFramePending) failStream("desktop_structured_stream_closed"); }); });
          socket.on("error", () => { if (!closedChild) failStream("desktop_structured_stream_closed"); });
          if (head?.length) decoder.push(head);
        });
        req.once("response", res => {
          let bytes = 0; res.on("data", chunk => { bytes += chunk.length; if (bytes > 8192) req.destroy(); });
          res.on("end", () => fail(res.statusCode === 409 ? "desktop_structured_unavailable" : "desktop_required", false));
        });
        req.once("error", error => fail(error?.uncertain ? error.code : upgraded ? "desktop_structured_stream_closed" : "desktop_structured_launch_uncertain", true));
        req.once("close", () => requests.delete(req));
        req.end();
      });
    });
  }
  async function prepareUpgrade() {
    const value = await call("maintenance/prepare", {});
    if (value.maintenanceVersion !== 1 || !UUID.test(value.instance) || !UUID.test(value.token)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 60000) throw failure("desktop_required");
    return { token: value.token, instance: value.instance, expiresAt: value.expiresAt, maintenanceVersion: 1 };
  }
  async function cancelUpgrade(token, instance = null) {
    if (!UUID.test(token)) throw failure("invalid_request");
    const value = await call("maintenance/cancel", { token, instance: instance || cached?.instance || "" });
    if (value.maintenanceVersion !== 1 || !UUID.test(value.instance)) throw failure("desktop_required");
    return value;
  }
  // Conversation terminal (/login, /logout, /status) for Claude. Older
  // helpers do not report terminalVersion; callers then keep the host-browser
  // sign-in and offer the helper update.
  let terminalCheck = null;
  async function terminalSupported() {
    if (terminalCheck && Date.now() - terminalCheck.at < 30000) return terminalCheck.value;
    let value = false;
    try { const health = await call("health"); value = health?.context === "Aqua" && health.terminalVersion === 1; } catch {}
    terminalCheck = { at: Date.now(), value };
    return value;
  }
  async function terminalStart({ action, choice, cols, rows }) {
    const value = await call("terminal/start", { action, choice, cols, rows });
    if (!UUID.test(value?.id)) throw failure("desktop_required");
    return { id: value.id, state: value.state };
  }
  async function terminalRead({ id, after }) {
    if (!UUID.test(id)) throw failure("invalid_request");
    const value = await call("terminal/read", { id, after }, { maxBytes: 128 * 1024 });
    if (value?.id !== id || !Array.isArray(value.events)) throw failure("desktop_required");
    return value;
  }
  async function terminalInput({ id, data, key, secret }) {
    if (!UUID.test(id)) throw failure("invalid_request");
    return call("terminal/input", { id, ...(typeof key === "string" ? { key } : { data }), ...(secret === true ? { secret: true } : {}) });
  }
  async function terminalCancel({ id }) {
    if (!UUID.test(id)) throw failure("invalid_request");
    return call("terminal/cancel", { id });
  }
  return Object.freeze({ status, health: () => call("health"), prepare: () => authAction("prepare"), start: id => authAction("start", id), cancel: id => authAction("cancel", id), launchTask,
    launchStructured,
    prepareUpgrade, cancelUpgrade,
    terminalSupported, terminalStart, terminalRead, terminalInput, terminalCancel,
    resetTerminalCheck: () => { terminalCheck = null; },
    snapshot: () => cached || offline(), isBusy: () => ["prepared", "starting", "waiting", "verifying", "cancelling"].includes(cached?.login?.state),
    close() { closed = true; for (const req of requests) req.destroy(); for (const socket of upgradedSockets) { try { socket.destroy(); } catch {} } } });
}
module.exports = { createDesktopClaudeClient };
