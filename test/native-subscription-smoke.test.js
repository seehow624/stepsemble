"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const api = () => import("../scripts/probe-native-subscriptions.mjs");
const effective = () => ({ config: { model_provider: "openai", project_doc_max_bytes: 0, web_search: "disabled", features: { apps: false, plugins: false, hooks: false, shell_snapshot: false, memories: false, shell_tool: false }, mcp_servers: { synthetic: { enabled: false } } } });
const started = () => ({ thread: { id: "synthetic-thread", modelProvider: "openai" }, instructionSources: [] });
async function temporary(t) {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-smoke-"));
  t.after(() => fs.rm(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return run;
}

test("subscription smoke retains native home/user identity without inheriting auth, routes, loaders or proxies", async () => {
  const { nativeEnvironment } = await api(), home = path.resolve("synthetic-home");
  const env = nativeEnvironment(home, { USER: "synthetic", LOGNAME: "synthetic", SHELL: "/bin/sh", LANG: "en_US.UTF-8", PATH: "/unsafe", HOME: "/unsafe",
    CODEX_HOME: "/unsafe", CLAUDE_CONFIG_DIR: "/unsafe", OPENAI_API_KEY: "private", ANTHROPIC_API_KEY: "private", ANTHROPIC_AUTH_TOKEN: "private",
    HTTP_PROXY: "private", OPENAI_BASE_URL: "private", NODE_OPTIONS: "private", DYLD_INSERT_LIBRARIES: "private" });
  assert.equal(env.HOME, home); assert.equal(env.USERPROFILE, home); assert.equal(env.USER, "synthetic"); assert.equal(env.LOGNAME, "synthetic");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "USER", "USERPROFILE"]);
  assert.ok(!JSON.stringify(env).includes("private")); assert.ok(!env.PATH.includes("/unsafe"));
});
test("usage evidence preserves observed zero but never converts unknowns into zero or exports arbitrary fields", async () => {
  const { numericUsage } = await api();
  assert.deepEqual(numericUsage({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: -1, inputTokens: "10", totalTokens: NaN, token: "private" }), { input_tokens: 0, output_tokens: 1 });
  assert.deepEqual(numericUsage(Object.create({ input_tokens: 42 })), {});
  for (const v of [null, undefined, [], "unknown"]) assert.equal(numericUsage(v), null);
});
test("Claude auth failures are classified only from explicit native synthetic errors, without raw messages", async () => {
  const { claudeFailureEvidence } = await api();
  const failure = { type: "assistant", error: "authentication_failed", message: { model: "<synthetic>", content: [{ text: "private detail" }], usage: { input_tokens: 0, output_tokens: 0 } } };
  assert.deepEqual(claudeFailureEvidence([failure]), { reason: "authentication_failed", usage: { input_tokens: 0, output_tokens: 0 } });
  for (const rows of [[], [{ ...failure, error: undefined }], [{ ...failure, message: { model: "ordinary" } }]])
    assert.deepEqual(claudeFailureEvidence(rows), { reason: "native_attempt_failed", usage: null });
});
test("MCP overrides use native dotted keys and reject ambiguous, duplicate or injected names", async () => {
  const { codexOverrides } = await api();
  const result = codexOverrides(["node_repl", "computer-use"]);
  assert.ok(result.includes("mcp_servers.node_repl.enabled=false")); assert.ok(result.includes("mcp_servers.computer-use.enabled=false"));
  assert.ok(!result.some(v => /model_provider|base_url|retry|auth/.test(v)));
  for (const names of [null, [""], ["x.y"], ['"x"'], ["x\n"], ["x", "x"], [null], Array.from({ length: 257 }, (_, i) => `x${i}`)]) assert.throws(() => codexOverrides(names));
});
test("Codex zero project budget does not exempt nonempty global instruction sources", async () => {
  const { verifyCodexPreflight } = await api();
  assert.doesNotThrow(() => verifyCodexPreflight(effective(), started()));
  assert.throws(() => verifyCodexPreflight(effective(), { ...started(), instructionSources: ["file:///synthetic/AGENTS.md"] }), /custom_instructions_loaded/);
  for (const sources of [null, undefined, ""]) assert.throws(() => verifyCodexPreflight(effective(), { ...started(), instructionSources: sources }), /instruction_sources_unavailable/);
});
test("native provider/account labels cannot hide a custom API or ChatGPT endpoint", async () => {
  const { verifyCodexRoute } = await api();
  for (const suffix of ["", "/"]) {
    const e = effective(); Object.assign(e.config, { openai_base_url: `https://api.openai.com/v1${suffix}`, chatgpt_base_url: `https://chatgpt.com/backend-api${suffix}` });
    assert.doesNotThrow(() => verifyCodexRoute(e));
  }
  for (const change of [{ model_provider: "third-party" }, { openai_base_url: "http://127.0.0.1:1234/v1" }, { chatgpt_base_url: "https://example.invalid" },
    { openai_base_url: "https://api.openai.com/v1?token=private" }, { openai_base_url: "https://api.openai.com.example.invalid/v1" }]) {
    const e = effective(); Object.assign(e.config, change); assert.throws(() => verifyCodexRoute(e), /non_native_route/);
  }
});
test("route preflight refuses malformed evidence, built-in override attempts and API-only auth without exposing settings", async () => {
  const { verifyCodexRoute, failureObservation } = await api();
  for (const config of [null, [], "private"]) assert.throws(() => verifyCodexRoute({ config }), /native_config_unavailable/);
  for (const model_providers of [[], "private", { openai: { base_url: "https://private.invalid", auth: { command: "private" } } }, { openai: null }]) {
    const e = effective(); e.config.model_providers = model_providers;
    assert.throws(() => verifyCodexRoute(e), /ambiguous_native_provider_config/);
  }
  for (const forced_login_method of ["api", "unknown", false, []]) {
    const e = effective(); e.config.forced_login_method = forced_login_method;
    assert.throws(() => verifyCodexRoute(e), error => {
      const result = failureObservation("codex", error, {});
      assert.equal(result.reason, "non_subscription_auth_config");
      assert.ok(!JSON.stringify(result).includes("private")); return true;
    });
  }
  const e = effective(); e.config.forced_login_method = "chatgpt";
  e.config.model_providers = { third_party: { base_url: "https://private.invalid" } };
  assert.doesNotThrow(() => verifyCodexRoute(e)); // Inactive routes remain untouched.
});
test("metadata-only Codex preflight resolves cwd and route before reading account and never creates sessions", async () => {
  const { codexMetadataPreflight } = await api(), calls = [], cwd = path.resolve("synthetic-workspace");
  const replies = { initialize: {}, "config/read": effective(), "account/read": { requiresOpenaiAuth: true, account: { type: "chatgpt", planType: "pro" } } };
  const client = { async request(method, params) { calls.push({ method, params }); assert.ok(Object.hasOwn(replies, method)); return replies[method]; },
    send(value) { assert.equal(value.method, "initialized"); }, assertHealthy() {} };
  const output = await codexMetadataPreflight(client, cwd, { observation: { nativeVersion: "codex-cli 0.153.4" } });
  assert.deepEqual(calls, [{ method: "initialize", params: { clientInfo: { name: "stepsemble_native_smoke", title: "Stepsemble native smoke", version: "1.0.0" } } },
    { method: "config/read", params: { includeLayers: false, cwd } }, { method: "account/read", params: { refreshToken: false } }]);
  assert.equal(output.threadCreated, false); assert.equal(output.turnAttempts, 0);
  assert.equal(output.instructionIsolationVerified, false); assert.equal(output.toolIsolationVerified, false);
  assert.equal(output.scope, "version_schema_route_account_metadata");
  replies["account/read"].account.planType = { private: "must not be exported" };
  const unknownPlan = await codexMetadataPreflight(client, cwd, { observation: {} });
  assert.equal(unknownPlan.subscriptionType, null); assert.ok(!JSON.stringify(unknownPlan).includes("private"));
  replies["config/read"].config.openai_base_url = "http://127.0.0.1:1/private"; calls.length = 0;
  await assert.rejects(codexMetadataPreflight(client, cwd, { observation: {} }), /non_native_route/);
  assert.deepEqual(calls.map(row => row.method), ["initialize", "config/read"]);
  replies["config/read"] = effective();
  replies["account/read"].requiresOpenaiAuth = false;
  await assert.rejects(codexMetadataPreflight(client, cwd, { observation: {} }), /native_subscription_unavailable/);
  replies["account/read"].requiresOpenaiAuth = true;
  for (const account of [null, { type: "apiKey" }, { type: "chatgptAuthTokens" }]) {
    replies["account/read"].account = account;
    await assert.rejects(codexMetadataPreflight(client, cwd, { observation: {} }), /native_subscription_unavailable/);
  }
});
test("native version and schema failures preserve safe causes rather than a generic Failed", async () => {
  const { failureObservation } = await api();
  const { reviewedVersion, verifySnapshot } = await import("../scripts/check-native-codex-schema.mjs");
  for (const [check, reason, version] of [
    [() => reviewedVersion("codex-cli 0.153.5"), "unsupported_native_version", "codex-cli 0.153.5"],
    [() => reviewedVersion("private credential"), "invalid_native_version", undefined],
    [() => verifySnapshot({ nativeVersion: "0.153.4" }, {}), "native_schema_mismatch", "codex-cli 0.153.4"],
  ]) assert.throws(check, error => {
    const result = failureObservation("codex", error, {});
    assert.equal(result.reason, reason); assert.equal(result.nativeVersion, version);
    assert.equal(result.result, "blocked"); assert.equal(result.turnAttempts, 0);
    assert.ok(!JSON.stringify(result).includes("private")); return true;
  });
});
test("Codex preflight refuses isolation drift and missing or mismatched thread metadata", async () => {
  const { verifyCodexPreflight } = await api();
  for (const change of [{ project_doc_max_bytes: 32768 }, { web_search: "cached" }, { features: { apps: false, plugins: false } }, { mcp_servers: { x: {} } }]) {
    const e = effective(); Object.assign(e.config, change); assert.throws(() => verifyCodexPreflight(e, started()), /isolation_config_mismatch/);
  }
  for (const thread of [null, {}, { id: "x", modelProvider: "custom" }]) assert.throws(() => verifyCodexPreflight(effective(), { ...started(), thread }), /native_thread_mismatch/);
});
test("atomic attempt reservation permits only one concurrent caller and retains exact native identity", async t => {
  const { reserveAttempt, assertAttemptUnused } = await api(), run = await temporary(t);
  await assertAttemptUnused(run, "claude");
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveAttempt(run, "claude", "synthetic-session")));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 11);
  const row = JSON.parse(await fs.readFile(path.join(run, "claude.attempt"), "utf8"));
  assert.equal(row.nativeSessionId, "synthetic-session"); assert.equal(row.automaticRetry, false);
  await assert.rejects(assertAttemptUnused(run, "claude"), /attempt_already_reserved/);
  await assertAttemptUnused(run, "codex");
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(run, "claude.attempt"))).mode & 0o777, 0o600);
});
test("partial attempt markers are retained as uncertain and rejected before any binary lookup or spawn", async t => {
  const { main, reserveAttempt } = await api(), run = await temporary(t);
  await fs.writeFile(path.join(run, "prepared.json"), '{"version":1}');
  await fs.writeFile(path.join(run, "claude.attempt"), "");
  await assert.rejects(main(["claude", run, path.join(run, "not-a-binary"), "--execute-one-turn"]), /attempt_already_reserved/);
  await assert.rejects(reserveAttempt(run, "../outside", "x"), /Invalid smoke agent/);
  await assert.rejects(reserveAttempt(run, "codex", "private\nvalue"), /Invalid native session identity/);
  assert.equal(await fs.readFile(path.join(run, "claude.attempt"), "utf8"), "");
});
test("failed smoke output cannot expose raw SDK errors, credentials, instruction paths or arbitrary observations", async () => {
  const { failureObservation } = await api();
  const context = { attempted: true, observation: { nativeVersion: "codex-cli 0.153.3", usage: { inputTokens: 0, token: "private" }, apiKey: "private", instructionSources: ["/private/AGENTS.md"] } };
  const row = failureObservation("codex", new Error("private transport URL and token"), context);
  assert.equal(row.result, "failed"); assert.equal(row.turnAttempts, 1); assert.equal(row.modelTurnCompletionObserved, false);
  assert.equal(row.automaticTurnRetries, 0); assert.equal(row.nativeTransportRetryCount, null); assert.deepEqual(row.usage, { inputTokens: 0 });
  assert.ok(!JSON.stringify(row).includes("private"));
  assert.equal(failureObservation("codex", new Error(), { ...context, attempted: false }).result, "blocked");
  assert.equal(failureObservation("codex", new Error(), { ...context, completed: true }).modelTurnCompletionObserved, true);
});
test("ordinary test and CI entrypoints never invoke quota-consuming native smoke", async () => {
  const pkg = require("../package.json");
  assert.ok(!Object.values(pkg.scripts).some(command => command.includes("probe-native-subscriptions")));
  const dir = path.join(__dirname, "../.github/workflows");
  for (const name of await fs.readdir(dir)) assert.ok(!(await fs.readFile(path.join(dir, name), "utf8")).includes("probe-native-subscriptions"), name);
});
test("Codex model execution remains disabled even with an explicit one-turn flag until isolation is reviewed", async () => {
  const { main } = await api();
  await assert.rejects(main(["codex", "not-a-run", "not-a-binary", "--execute-one-turn"]), /Codex model execution is disabled/);
});
