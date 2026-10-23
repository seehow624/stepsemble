import { installPiSpeed } from "../server/pi-speed-runtime.mjs";
export const fakeToken = (account = "account-a", subject = "user-a") => ["e30", Buffer.from(JSON.stringify({ sub: subject, exp: 4102444800,
  "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url"), "synthetic"].join(".");
export async function nativeSpeedFixture({ fetchImpl, timeoutMs, baseProvider, cleanupSessionResources = () => {} } = {}) {
  const hooks = {}, commands = {}, entries = [], metadata = [], wire = [];
  const control = { sessionId: "native-fixture", offered: true, aborted: false, oauth: true, source: "stored", auth: { ok: true, apiKey: fakeToken() } };
  const model = { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", id: "gpt-6-astra", name: "Synthetic",
    reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], contextWindow: 32000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const delegate = (selected, _context, options) => {
    const result = (async () => {
      const payload = await options.onPayload({ model: selected.id, reasoning: { effort: "xhigh" }, service_tier: "priority" }, selected);
      wire.push({ model: selected, options, payload }); return payload;
    })();
    result.result = () => result;
    return result;
  };
  const base = baseProvider || { id: model.provider, baseUrl: model.baseUrl, auth: { oauth: {} }, getModels: () => [model], refreshModels() {}, stream: delegate, streamSimple: delegate };
  let registered;
  const registry = { runtime: { builtins: new Map([[model.provider, base]]) },
    getRegisteredProviderIds: () => registered ? [model.provider] : [], getRegisteredNativeProvider: () => registered,
    getApiKeyAndHeaders: async () => control.auth, isUsingOAuth: () => control.oauth,
    getProviderAuthStatus: () => ({ source: control.source }) };
  control.controller = new AbortController();
  const ctx = { model, modelRegistry: registry, get signal() { return control.controller.signal; }, abort: () => { control.aborted = true; control.controller?.abort(); }, isIdle: () => true,
    sessionManager: { getSessionId: () => control.sessionId, getBranch: () => entries } };
  const pi = { on: (name, handler) => { hooks[name] = handler; }, registerCommand: (name, command) => { commands[name] = command.handler; },
    appendEntry: (customType, data) => entries.push({ id: "receipt-" + entries.length, parentId: entries.at(-1)?.id || null, type: "custom", customType, data }),
    registerProvider: provider => { registered = provider; }, unregisterProvider: () => { registered = undefined; } };
  installPiSpeed(pi, { nativeOptions: { env: {}, timeoutMs, cleanupSessionResources, fetchImpl: async (url, options) => {
    metadata.push({ url, options });
    return fetchImpl ? fetchImpl(url, options) : new Response(JSON.stringify({ models: [{ slug: ctx.model.id, service_tiers: control.offered ? [{ id: "priority" }] : [] }] }));
  } } });
  hooks.session_start({}, ctx);
  const command = async (action = "get", speed, fingerprint) => {
    await commands["stepsemble-speed"](JSON.stringify({ nonce: "fixture-nonce", action, speed, fingerprint, expectedSessionId: control.sessionId }), ctx);
    return entries.at(-1).data;
  };
  const dispatch = (options = {}) => {
    if (control.controller.signal.aborted) control.controller = new AbortController();
    return registered.streamSimple(ctx.model, { messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }, {
    apiKey: control.auth.apiKey, signal: ctx.signal, sessionId: control.sessionId, reasoning: "xhigh", transport: "sse",
    onPayload: payload => hooks.before_provider_request({ payload }, ctx), ...options });
  };
  return { ctx, pi, base, registry, hooks, command, commands, control, entries, metadata, wire, dispatch, provider: () => registered };
}
