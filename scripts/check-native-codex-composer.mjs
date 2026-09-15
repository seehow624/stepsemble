#!/usr/bin/env node
// Owned end-to-end Codex composer oracle. The official CLI is pointed at a
// deterministic localhost Responses fixture, so no account, credential, or
// paid model request is involved. The probe exercises model/list, image input,
// model/effort forwarding, usage notification handling, and cleanup through
// the same native adapter used by the HTTP route.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createCodexNativeHistoryAdapter } from "../server/codex-native-history-adapter.js";
import { codexImageInputs } from "../server/prompt-attachments.js";
import { probeEnvironment } from "./check-native-codex-schema.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_VERSION = "0.154.0";
function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii"), body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length, 0);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, body])), 0);
  return Buffer.concat([header, name, body, checksum]);
}
// Valid 1x1 PNG with a bounded ancillary text chunk just over 1 MiB. The
// payload is still a real image, and the size exercises the enlarged native
// turn frame without making the JSONL decoder accept unbounded output.
const LARGE_PNG = (() => {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA, 8-bit
  const scanline = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  const metadata = Buffer.concat([Buffer.from("fixture\0", "ascii"), Buffer.alloc(1_200_000, 0x41)]);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", scanline), pngChunk("tEXt", metadata), pngChunk("IEND", Buffer.alloc(0))]);
})();
const IMAGE_DATA = LARGE_PNG.toString("base64");
const IMAGE_URL = `data:image/png;base64,${IMAGE_DATA}`;

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

async function waitFor(check, ms = 12000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("native_composer_probe_timeout");
}

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function isolatedEnvironment(home) {
  const env = probeEnvironment(home);
  for (const key of [
    "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_REMOTE_TOKEN", "OPENCODEX_API_AUTH_TOKEN",
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  ]) delete env[key];
  return env;
}

export async function checkNativeComposer(binary) {
  assert(typeof binary === "string" && path.isAbsolute(binary), "absolute official native executable required");
  const executable = await fs.realpath(binary);
  const version = (await execFileAsync(executable, ["--version"], {
    cwd: root, env: isolatedEnvironment(root), shell: false, timeout: 5000, maxBuffer: 64 * 1024,
  })).stdout.trim();
  assert.equal(version, `codex-cli ${NATIVE_VERSION}`);

  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-composer-owned-")));
  const codexHome = path.join(home, "codex");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  let server;
  let adapter;
  let child;
  let childClosed;
  let endpointRequests = 0;
  let endpointRequest;
  let endpointFailure;
  let resolveRequest;
  let rejectRequest;
  const requestReady = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
  const stderr = [];
  try {
    server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404); res.end(); return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > 12 * 1024 * 1024) {
          req.destroy();
          endpointFailure = new Error("native_composer_endpoint_body_too_large");
        }
      });
      req.on("error", error => { endpointFailure = error; rejectRequest(error); });
      req.on("end", () => {
        if (endpointFailure) return;
        let parsed;
        try { parsed = JSON.parse(body); } catch (error) { endpointFailure = error; rejectRequest(error); return; }
        endpointRequests += 1;
        endpointRequest = parsed;
        if (endpointRequests !== 1) {
          endpointFailure = new Error("unexpected_second_model_request");
          rejectRequest(endpointFailure);
          res.writeHead(503); res.end();
          return;
        }
        resolveRequest(parsed);
        const message = { type: "message", id: "msg-owned-composer", role: "assistant",
          content: [{ type: "output_text", text: "Owned composer fixture response.", annotations: [] }] };
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
        res.end(sse([
          { type: "response.created", response: { id: "resp-owned-composer" } },
          { type: "response.output_item.done", output_index: 0, item: message },
          { type: "response.completed", response: { id: "resp-owned-composer", output: [],
            usage: { input_tokens: 17, output_tokens: 9, total_tokens: 26 } } },
        ]));
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await fs.writeFile(path.join(codexHome, "config.toml"), `model = "mock-model"
model_provider = "owned_fixture"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[model_providers.owned_fixture]
name = "Owned local composer fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[features]
apps = false
plugins = false
hooks = false
shell_snapshot = false
memories = false
shell_tool = false
`, { flag: "wx", mode: 0o600 });

    const env = isolatedEnvironment(home);
    adapter = createCodexNativeHistoryAdapter({
      env,
      executable,
      cwd: home,
      enabled: true,
      mutationEnabled: true,
      includeKnownPaths: false,
      journalFile: path.join(home, "journal", "native-mutations.json"),
      // Keep a direct child handle so cleanup is independently verified. A
      // custom launcher (rather than transportFactory) preserves the adapter's
      // production schema/version compatibility probe.
      launch: options => {
        child = spawn(options.executable, ["app-server", "--listen", "stdio://"], {
          cwd: options.cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"],
        });
        childClosed = new Promise(resolve => child.once("close", resolve));
        child.stderr.on("data", chunk => stderr.push(String(chunk).slice(-4096)));
        const transport = createCodexNativeHistoryTransport(options, child);
        return transport;
      },
    });

    const status = await adapter.refresh();
    assert.equal(status.ready, true, JSON.stringify(status));
    assert.equal(status.nativeVersion, NATIVE_VERSION);
    const models = await adapter.listModels({ limit: 10, includeHidden: false });
    assert.ok(Array.isArray(models.data) && models.data.length > 0, "native model/list returned no models");
    assert.ok(models.data.every(model => typeof model.id === "string" && Array.isArray(model.inputModalities)));

    const started = await adapter.startThread({ model: "mock-model", modelProvider: "owned_fixture", cwd: home,
      approvalPolicy: "never", sandbox: "read-only" });
    assert.equal(started.kind, "started", JSON.stringify(started));
    const image = codexImageInputs([{ data: IMAGE_URL, mimeType: "image/png" }]);
    assert.deepEqual(image, [{ type: "image", url: IMAGE_URL }]);
    const turn = await adapter.startTurn([{ type: "text", text: "Describe this owned fixture." }, ...image],
      { model: "mock-model", effort: "high" }, started.threadId);
    assert.equal(turn.kind, "started", JSON.stringify(turn));
    await deadline(requestReady, 12000, "native_composer_request_not_observed");
    if (endpointFailure) throw endpointFailure;
    assert.equal(endpointRequest.model, "mock-model");
    assert.equal(endpointRequest.reasoning?.effort, "high");
    const requestMessages = Array.isArray(endpointRequest.input) ? endpointRequest.input.filter(item => item?.role === "user") : [];
    const requestImage = requestMessages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(item => item?.type === "input_image");
    assert.equal(requestImage?.image_url, IMAGE_URL);
    assert.equal(requestImage?.detail, "high");

    const context = await waitFor(async () => {
      const value = await adapter.contextUsage(started.threadId);
      return value.contextTokens === 26 ? value : null;
    });
    assert.equal(context.model, "mock-model");
    assert.equal(context.contextWindow, 258400);
    assert.equal(context.contextTokens, 26);
    assert.equal(context.contextPercent, (26 / 258400) * 100);
    assert.deepEqual(context.usage, {
      cachedInputTokens: 0, inputTokens: 17, outputTokens: 9,
      reasoningOutputTokens: 0, totalTokens: 26, cacheWriteInputTokens: 0,
    });
    assert.equal(endpointRequests, 1, "the oracle must not make a second/provider request");

    const closed = await adapter.close();
    assert.equal(closed.cleanupConfirmed, true, JSON.stringify(closed));
    await deadline(childClosed, 5000, "native_composer_child_not_reaped");
    return {
      result: "passed",
      nativeVersion: NATIVE_VERSION,
      modelCount: models.data.length,
      modelListNextCursor: models.nextCursor,
      endpointRequests,
      forwardedModel: endpointRequest.model,
      forwardedEffort: endpointRequest.reasoning?.effort || null,
      forwardedImage: requestImage?.type === "input_image" && requestImage.image_url === IMAGE_URL,
      forwardedImageBytes: LARGE_PNG.length,
      context,
      paidModelRequests: 0,
      cleanupConfirmed: true,
    };
  } catch (error) {
    error.message += `; endpointRequests=${endpointRequests}; nativeState=${JSON.stringify(adapter?.nativeState?.())}; stderr=${stderr.join("").slice(-4096)}`;
    try { await adapter?.close?.(); } catch {}
    throw error;
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

// Keep transport construction local to the oracle; it lets the adapter own
// compatibility and lifecycle while the script independently owns the child.
function createCodexNativeHistoryTransport(options, child) {
  const { createCodexAppServerTransport } = require("../server/codex-app-server-transport.js");
  return createCodexAppServerTransport({ ...options, child, trustedNative: true, requestTimeoutMs: 20000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [binary, ...rest] = process.argv.slice(2);
  assert(binary && rest.length === 0, "Usage: check-native-codex-composer.mjs /absolute/official/native/codex");
  console.log(JSON.stringify(await checkNativeComposer(binary)));
}
