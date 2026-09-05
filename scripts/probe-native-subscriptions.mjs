#!/usr/bin/env node
// MANUAL, quota-consuming smoke only. Never run from npm test or CI.
// Claude: one explicit turn per prepared run. Codex: preflight only until isolation is reviewed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
export const MARKER = "STEPSEMBLE_NATIVE_OK";
export const PROMPT = `Reply with exactly ${MARKER}. Do not call tools or read any files.`;
const systemPrompt = "This is a harmless native client connectivity check. Return only the requested marker. Never use tools, read files, or perform other work.";
export function nativeEnvironment(home, source = process.env) {
  const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath) + path.delimiter + (process.platform === "win32" ? "" : "/usr/bin:/bin") };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"])
    if (source[key]) env[key] = source[key];
  return env; // Native auth stays at its original HOME; no copied OAuth/API keys.
}
export function numericUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const names = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"];
  return Object.fromEntries(names.filter(key => Object.hasOwn(value, key) && Number.isSafeInteger(value[key]) && value[key] >= 0).map(key => [key, value[key]]));
}
function assert(ok, message) { if (!ok) throw new Error(message); }
class SmokeError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
export async function assertAttemptUnused(run, agent) {
  assert(["claude", "codex"].includes(agent), "Invalid smoke agent");
  try { await fs.lstat(path.join(run, `${agent}.attempt`)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new SmokeError("attempt_already_reserved");
}
export async function reserveAttempt(run, agent, nativeSessionId) {
  assert(["claude", "codex"].includes(agent), "Invalid smoke agent");
  assert(typeof nativeSessionId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(nativeSessionId), "Invalid native session identity");
  const file = await fs.open(path.join(run, `${agent}.attempt`), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ agent, nativeSessionId, attemptedAt: new Date().toISOString(), automaticRetry: false }) + "\n");
    await file.sync();
  } finally { await file.close(); }
}
export function claudeFailureEvidence(rows) {
  const failure = rows.find(row => row?.type === "assistant" && row.error === "authentication_failed" && row.message?.model === "<synthetic>");
  return failure ? { reason: "authentication_failed", usage: numericUsage(failure.message.usage) } : { reason: "native_attempt_failed", usage: null };
}
export function codexOverrides(names) {
  assert(Array.isArray(names) && names.length <= 256 && new Set(names).size === names.length, "Invalid native MCP inventory");
  return ["features.apps=false", "features.plugins=false", "features.hooks=false", "features.shell_snapshot=false", "features.memories=false", "features.shell_tool=false", "web_search=\"disabled\"", "project_doc_max_bytes=0",
    ...names.map(name => { assert(typeof name === "string" && /^[a-zA-Z0-9_-]+$/.test(name), "Unrepresentable native MCP override name; no turn sent"); return `mcp_servers.${name}.enabled=false`; })];
}
export function verifyCodexRoute(effective) {
  const config = effective?.config;
  const nativeUrl = (value, expected) => value == null || value === expected || value === expected + "/";
  if (!config || (config.model_provider ?? "openai") !== "openai"
    || !nativeUrl(config.openai_base_url, "https://api.openai.com/v1")
    || !nativeUrl(config.chatgpt_base_url, "https://chatgpt.com/backend-api"))
    throw new SmokeError("non_native_route");
}
export function verifyCodexPreflight(effective, started) {
  verifyCodexRoute(effective);
  const config = effective.config;
  if (config.project_doc_max_bytes !== 0 || config.web_search !== "disabled" || ["apps", "plugins", "hooks", "shell_snapshot", "memories", "shell_tool"].some(key => config.features?.[key] !== false)
    || Object.values(config.mcp_servers ?? {}).some(server => server.enabled !== false)) throw new SmokeError("isolation_config_mismatch");
  if (!started?.thread?.id || started.thread.modelProvider !== "openai") throw new SmokeError("native_thread_mismatch");
  // The project byte cap does not disable the separate global instruction provider.
  if (!Array.isArray(started.instructionSources)) throw new SmokeError("instruction_sources_unavailable");
  if (started.instructionSources.length) throw new SmokeError("custom_instructions_loaded");
}
export function failureObservation(agent, error, context) {
  const reason = error instanceof SmokeError ? error.reason : "native_probe_failed";
  const safe = {}, observation = context.observation ?? {};
  for (const key of ["nativeVersion", "authType", "subscriptionType"])
    if (typeof observation[key] === "string" && /^[a-zA-Z0-9 ()._-]{1,80}$/.test(observation[key])) safe[key] = observation[key];
  if (Number.isSafeInteger(observation.customInstructionSourceCount) && observation.customInstructionSourceCount >= 0) safe.customInstructionSourceCount = observation.customInstructionSourceCount;
  if (Object.hasOwn(observation, "usage")) safe.usage = numericUsage(observation.usage);
  return { agent, ...safe, result: context.attempted ? "failed" : "blocked", reason,
    turnAttempts: context.attempted ? 1 : 0, automaticTurnRetries: 0, nativeTransportRetryCount: null,
    approvalExercised: false, modelTurnCompletionObserved: context.completed === true };
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
  await closed; clearTimeout(timer);
}
const children = new Set();
async function claude(run, binary, home, context, preflightOnly) {
  const env = nativeEnvironment(home), cwd = path.join(run, "claude-workspace"); await fs.mkdir(cwd, { recursive: true });
  const auth = JSON.parse((await exec(binary, ["--safe-mode", "auth", "status", "--json"], { cwd, env, timeout: 10000 })).stdout);
  assert(auth.loggedIn && auth.authMethod === "claude.ai" && auth.apiProvider === "firstParty", "Claude is not using an existing first-party subscription; no turn sent");
  const version = (await exec(binary, ["--version"], { cwd, env, timeout: 10000 })).stdout.trim();
  assert(version === "2.1.259 (Claude Code)", "Review changed Claude CLI version before consuming quota");
  context.observation = { nativeVersion: version, authType: "claude.ai", subscriptionType: auth.subscriptionType ?? null };
  if (preflightOnly) return { agent: "claude", ...context.observation, result: "preflight_only", turnAttempts: 0, modelTurnCompletionObserved: false };
  const sessionId = crypto.randomUUID(), frames = [], start = performance.now();
  await reserveAttempt(run, "claude", sessionId); context.attempted = true;
  const child = spawn(binary, ["--safe-mode", "-p", PROMPT, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-chrome", "--session-id", sessionId, "--system-prompt", systemPrompt], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child); let bytes = 0, malformed = false;
  const timeout = setTimeout(() => void stop(child), 90000);
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    bytes += Buffer.byteLength(line);
    if (bytes > 4 * 1024 * 1024) { malformed = true; void stop(child); return; }
    try { frames.push(JSON.parse(line)); } catch { malformed = true; void stop(child); }
  });
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert(code === 0 && !malformed, "Claude attempt failed or timed out; do not automatically retry");
    const init = frames.find(row => row.type === "system" && row.subtype === "init"), result = frames.find(row => row.type === "result");
    context.completed = result?.subtype === "success" && result.is_error === false;
    assert(init?.session_id === sessionId && result?.session_id === sessionId, "Claude native session correlation mismatch");
    assert(init.tools?.length === 0 && init.mcp_servers?.length === 0, "Unexpected enabled Claude tools/extensions");
    assert(result?.subtype === "success" && result.is_error === false && result.result?.trim() === MARKER && result.num_turns === 1, "Claude did not complete the single requested marker turn");
    const deltas = frames.filter(row => row.type === "stream_event" && row.event?.type === "content_block_delta" && row.event.delta?.type === "text_delta");
    assert(deltas.map(row => row.event.delta.text).join("").trim() === MARKER, "Claude streamed text did not match its final result");
    // Read only the new session's exact file; never enumerate/read other history.
    const projectKey = (await fs.realpath(cwd)).replace(/[^a-zA-Z0-9]/g, "-");
    const history = await fs.readFile(path.join(home, ".claude/projects", projectKey, `${sessionId}.jsonl`), "utf8");
    const rows = history.trim().split("\n").map(line => JSON.parse(line));
    assert(rows.some(row => row.type === "assistant" && row.sessionId === sessionId && row.message?.content?.some(item => item.type === "text" && item.text.trim() === MARKER)), "New Claude native history did not retain the response");
    return { agent: "claude", nativeVersion: version, authType: "claude.ai", subscriptionType: auth.subscriptionType ?? null, model: init.model,
      result: "passed", turnAttempts: 1, modelTurnCompletionObserved: true, automaticTurnRetries: 0, nativeTransportRetryCount: null, toolCalls: 0, approvalExercised: false, elapsedMs: Math.round(performance.now() - start),
      streamDeltaCount: deltas.length, sessionCorrelated: true, historyReadAfterProcessExit: true, usage: numericUsage(result.usage),
      observedFrameTypes: [...new Set(frames.map(row => row.type))].sort() };
  } catch (error) {
    // Only inspect this attempt's exact native file; never persist raw frames/errors.
    let rows = frames;
    try {
      const projectKey = (await fs.realpath(cwd)).replace(/[^a-zA-Z0-9]/g, "-");
      const filename = path.join(home, ".claude/projects", projectKey, `${sessionId}.jsonl`);
      if ((await fs.stat(filename)).size <= 4 * 1024 * 1024) rows = rows.concat((await fs.readFile(filename, "utf8")).trim().split("\n").map(line => JSON.parse(line)));
    } catch { /* Missing/partial evidence remains unknown, never zero or success. */ }
    const evidence = claudeFailureEvidence(rows); context.observation.usage = evidence.usage;
    if (evidence.reason === "authentication_failed") throw new SmokeError(evidence.reason);
    throw error;
  } finally { clearTimeout(timeout); lines.close(); await stop(child); children.delete(child); }
}
export function rpc(binary, cwd, env, configArgs) {
  const child = spawn(binary, ["app-server", "--listen", "stdio://", ...configArgs], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child); child.stderr.resume();
  const waiting = new Map(), notifications = []; let sequence = 0, bytes = 0, unexpectedRequest = false;
  const lines = readline.createInterface({ input: child.stdout });
  const send = value => child.stdin.write(JSON.stringify(value) + "\n");
  const fail = () => { for (const row of waiting.values()) { clearTimeout(row.timer); row.reject(new Error("Native Codex transport ended; no automatic retry")); } waiting.clear(); };
  child.on("error", fail); child.on("close", fail); child.stdin.on("error", fail);
  lines.on("line", line => {
    bytes += Buffer.byteLength(line); if (bytes > 8 * 1024 * 1024) { fail(); void stop(child); return; }
    let value; try { value = JSON.parse(line); } catch { fail(); void stop(child); return; }
    if (value.method && value.id !== undefined) {
      unexpectedRequest = true;
      send({ id: value.id, error: { code: -32601, message: "Tool and permission requests are disabled for this smoke test" } });
      void stop(child); return;
    }
    if (value.method) { notifications.push(value); return; }
    const row = waiting.get(value.id); if (!row) return;
    waiting.delete(value.id); clearTimeout(row.timer);
    if (value.error) row.reject(new Error(`Native Codex ${row.method} rejected (${value.error.code}); no retry`)); else row.resolve(value.result);
  });
  const request = (method, params, timeout = 20000) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Native Codex ${method} timed out; no retry`)); }, timeout);
    waiting.set(id, { method, resolve, reject, timer }); send({ id, method, params });
  });
  return { request, send, notifications, get unexpectedRequest() { return unexpectedRequest; },
    async close() { await stop(child); fail(); lines.close(); children.delete(child); } };
}
async function initialize(client) {
  await client.request("initialize", { clientInfo: { name: "stepsemble_native_smoke", title: "Stepsemble native smoke", version: "1.0.0" } });
  client.send({ method: "initialized", params: {} });
}
async function codex(run, binary, home, context) {
  const env = nativeEnvironment(home), cwd = path.join(run, "codex-workspace"); await fs.mkdir(cwd, { recursive: true });
  const version = (await exec(binary, ["--version"], { cwd, env, timeout: 10000 })).stdout.trim();
  assert(version === "codex-cli 0.153.3", "Review changed Codex CLI version before consuming quota");
  context.observation = { nativeVersion: version };
  // Parse only native config server names, never return keys/URLs or copy auth.
  const names = JSON.parse((await exec("python3", ["-c", "import tomllib,json,pathlib,sys; print(json.dumps(list(tomllib.loads(pathlib.Path(sys.argv[1]).read_text()).get('mcp_servers',{}))))", path.join(home, ".codex/config.toml")], { cwd, timeout: 10000 })).stdout);
  const overrides = codexOverrides(names);
  const args = overrides.flatMap(value => ["-c", value]);
  const client = rpc(binary, cwd, env, args);
  try {
    await initialize(client);
    const account = await client.request("account/read", { refreshToken: false });
    assert(account.account?.type === "chatgpt", "Codex is not using existing ChatGPT subscription auth; no turn sent");
    Object.assign(context.observation, { authType: "chatgpt", subscriptionType: account.account.planType ?? null });
    const effective = await client.request("config/read", { includeLayers: false });
    verifyCodexRoute(effective); // Refuse routing drift before creating a thread.
    const started = await client.request("thread/start", { cwd, ephemeral: false, sandbox: "read-only", approvalPolicy: "never",
      baseInstructions: systemPrompt, developerInstructions: "Do not use tools or read files. Return the user's fixed marker only.", serviceName: "stepsemble-native-smoke" });
    if (Array.isArray(started.instructionSources)) context.observation.customInstructionSourceCount = started.instructionSources.length;
    verifyCodexPreflight(effective, started);
    // Do not ship a turn path before native instruction/tool isolation is reviewed.
    // ApprovalPolicy "never" is not a no-tools policy and must not be used as one.
    return { agent: "codex", ...context.observation, result: "preflight_only", turnAttempts: 0, modelTurnCompletionObserved: false };
  } finally { await client.close(); }
}
export async function main(argv) {
  if (argv.length === 1 && argv[0] === "prepare") {
    const run = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-smoke-"));
    await fs.writeFile(path.join(run, "prepared.json"), JSON.stringify({ version: 1, id: crypto.randomUUID() }), { mode: 0o600 });
    console.log(run); return;
  }
  const [agent, suppliedRun, binary, flag] = argv;
  assert(argv.length === 4 && ["claude", "codex"].includes(agent) && ["--execute-one-turn", "--preflight-only"].includes(flag), "Requires agent, prepared local run, trusted absolute native binary, and explicit preflight/one-turn mode");
  assert(agent !== "codex" || flag === "--preflight-only", "Codex model execution is disabled pending native route/instruction/tool isolation review");
  assert(path.isAbsolute(binary), "Trusted native binary must be absolute");
  const run = await fs.realpath(suppliedRun), temp = await fs.realpath(os.tmpdir());
  assert(path.dirname(run) === temp && path.basename(run).startsWith("stepsemble-native-smoke-") && JSON.parse(await fs.readFile(path.join(run, "prepared.json"), "utf8")).version === 1, "Not an owned prepared smoke directory");
  await assertAttemptUnused(run, agent); // Reject before starting even a metadata subprocess.
  const context = { attempted: false, observation: {} }; let output;
  try { output = await (agent === "claude" ? claude : codex)(run, await fs.realpath(binary), os.homedir(), context, flag === "--preflight-only"); }
  catch (error) { output = failureObservation(agent, error, context); }
  // Unique sanitized reports preserve preflight failures without blocking a later authorized attempt.
  await fs.writeFile(path.join(run, `${agent}-result-${crypto.randomUUID()}.json`), JSON.stringify(output, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(output)); return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { for (const child of children) await stop(child); process.exit(1); });
  try { const output = await main(process.argv.slice(2)); if (output && !["passed", "preflight_only"].includes(output.result)) process.exitCode = 1; }
  catch { console.error("Native smoke refused or incomplete; inspect its private attempt marker. Do not automatically retry."); process.exitCode = 1; }
}
