// Pi 1.4 native ChatGPT boundary. Credentials never leave this process.
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const { unknownSpeed } = createRequire(import.meta.url)("./agent-speed");
const PROVIDER = "openai-codex", API = "openai-codex-responses";
const BASE = "https://chatgpt.com/backend-api";
const CATALOG = BASE + "/codex/models?client_version=0.163.0";
const MAX_BYTES = 2 * 1024 * 1024;
const route = model => model?.provider === PROVIDER && model.api === API && [BASE, BASE + "/"].includes(model.baseUrl)
  && typeof model.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(model.id);
const record = value => value && typeof value === "object" && !Array.isArray(value);
const forbiddenEnv = /^(https?_proxy|all_proxy|openai_base_url|openai_codex_base_url|chatgpt_base_url|openai_api_key|openai_org_id|openai_project_id|node_use_env_proxy)$/i;
const forbiddenHeader = /^(authorization|proxy-authorization|chatgpt-account-id|host|cookie|forwarded|x-forwarded-host|openai-organization|openai-project|x-api-key|x-service-tier|x-codex-service-tier|x-openai-service-tier)$/i;
export function createPiNativeSpeed({ fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 4000, cleanupSessionResources } = {}) {
  const salt = randomBytes(32), active = new Map();
  let installed = null, retired = false;
  const owned = ctx => !!installed && !retired && installed.registry === ctx?.modelRegistry
    && ctx.modelRegistry?.getRegisteredNativeProvider?.(PROVIDER) === installed.wrapper;
  function account(model, auth) {
    if (!route(model) || !auth?.ok || typeof auth.apiKey !== "string" || auth.apiKey.length > 32768
      || auth.baseUrl && ![BASE, BASE + "/"].includes(auth.baseUrl)) throw new Error("route");
    for (const values of [env, auth.env]) {
      if (values && (!record(values) || Object.entries(values).some(([key, value]) => forbiddenEnv.test(key) && value))) throw new Error("environment");
    }
    for (const headers of [model.headers, auth.headers]) {
      if (headers && (!record(headers) || Object.keys(headers).some(key => forbiddenHeader.test(key)))) throw new Error("headers");
    }
    const parts = auth.apiKey.split(".");
    if (parts.length !== 3) throw new Error("credential");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)
      || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256
      || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error("credential");
    const fingerprint = createHmac("sha256", salt).update(JSON.stringify([PROVIDER, API, BASE, model.id, id, claims.sub, "priority"])).digest("hex");
    return { id, fingerprint };
  }
  async function read(model, ctx, capturedAuth) {
    const controller = new AbortController(), expiresAt = Date.now() + timeoutMs;
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        if (!owned(ctx) || typeof cleanupSessionResources !== "function" || !route(model) || !ctx.modelRegistry.isUsingOAuth(model)
          || ctx.modelRegistry.getProviderAuthStatus(PROVIDER)?.source !== "stored") throw new Error("runtime");
        const auth = capturedAuth || await ctx.modelRegistry.getApiKeyAndHeaders(model);
        controller.signal.throwIfAborted();
        const binding = account(model, auth);
        const response = await fetchImpl(CATALOG, { method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { Authorization: "Bearer " + auth.apiKey, "chatgpt-account-id": binding.id, accept: "application/json", "cache-control": "no-cache", originator: "pi" } });
        if (response.status !== 200 || response.redirected || response.url && response.url !== CATALOG
          || Number(response.headers.get("age")) > 0 || Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) throw new Error("response");
        const reader = response.body.getReader(), chunks = [];
        const cancel = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            controller.signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error("size");
            chunks.push(Buffer.from(value));
          }
        } finally { controller.signal.removeEventListener("abort", cancel); cancel(); }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const rows = Array.isArray(data?.models) ? data.models.filter(row => row?.slug === model.id) : [];
        if (rows.length !== 1 || !Array.isArray(rows[0].service_tiers)) throw new Error("offering");
        const tiers = rows[0].service_tiers;
        if (tiers.some(tier => !record(tier) || typeof tier.id !== "string" || !tier.id)
          || new Set(tiers.map(tier => tier.id)).size !== tiers.length) throw new Error("offering");
        const latest = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!owned(ctx) || !ctx.modelRegistry.isUsingOAuth(model)
          || ctx.modelRegistry.getProviderAuthStatus(PROVIDER)?.source !== "stored"
          || account(model, latest).fingerprint !== binding.fingerprint) throw new Error("account_changed");
        controller.signal.throwIfAborted();
        if (Date.now() >= expiresAt) throw new Error("timeout");
        const offered = tiers.some(tier => tier.id === "priority");
        return { ...unknownSpeed(offered ? "speed_next_turn" : "speed_not_offered"), support: offered ? "supported" : "unavailable",
          choices: offered ? ["standard", "fast"] : ["standard"], route: "pi-native-chatgpt", model: model.id,
          tier: offered ? "priority" : null, fingerprint: binding.fingerprint };
      })()]);
    } catch { return unknownSpeed("speed_route_unverified"); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  function install(pi, ctx, prepare) {
    if (owned(ctx)) return;
    if (installed || !ctx.isIdle?.() || ctx.modelRegistry?.getRegisteredProviderIds?.().includes(PROVIDER)) return;
    // Public facade has no uncomposed-provider accessor. This read-only Pi 1.4
    // seam preserves the original remote catalog + OAuth, composing settings
    // exactly once. Never wrap getProvider(): it is already composed.
    const registry = ctx.modelRegistry, base = registry?.runtime?.builtins?.get(PROVIDER);
    if (base?.id !== PROVIDER || base.baseUrl !== BASE || !base.auth?.oauth || base.auth.apiKey
      || !["stream", "streamSimple", "getModels", "refreshModels"].every(key => typeof base[key] === "function")
      || typeof pi.registerProvider !== "function" || typeof registry.getRegisteredNativeProvider !== "function") return;
    const wrap = method => (model, context, options = {}) => {
      const requestModel = { ...model, ...(model.headers ? { headers: { ...model.headers } } : {}) };
      const requestOptions = { ...options, headers: { ...options.headers }, ...(options.env ? { env: { ...options.env } } : {}) };
      const { finish, assertOwner, abortIfOwned } = prepare(ctx, requestModel, requestOptions), sid = options.sessionId;
      const requestFetch = options.fetch ?? globalThis.fetch;
      let authorizedFast = false;
      active.set(sid, (active.get(sid) || 0) + 1);
      const done = () => { const remaining = active.get(sid) - 1; if (remaining) active.set(sid, remaining); else active.delete(sid); };
      try {
        const result = base[method](requestModel, context, { ...requestOptions, serviceTier: undefined,
          // The SDK uses this same supported fetch option for SSE and auto's
          // SSE fallback. Constrain only this request after paid authorization;
          // Standard and the caller's fetch implementation remain unchanged.
          fetch: (url, init) => {
            if (!authorizedFast) return requestFetch(url, init);
            assertOwner();
            if (url !== BASE + "/codex/responses") throw new Error("speed_revalidation_required");
            return requestFetch(url, { ...init, redirect: "error" });
          },
          onPayload: async (payload, selected) => {
            assertOwner();
            const transformed = await options.onPayload?.(payload, selected);
            // This runs AFTER all extension payload hooks, with the exact auth
            // already resolved by ModelRuntime and captured by the native SDK.
            return finish(transformed === undefined ? payload : transformed, () => {
              if (!owned(ctx) || typeof sid !== "string" || !sid || sid !== ctx.sessionManager.getSessionId?.()
                || active.get(sid) !== 1 || typeof cleanupSessionResources !== "function") {
                abortIfOwned(); throw new Error("speed_revalidation_required");
              }
              // SDK WS pools are keyed by session+account, NOT access token.
              // Only our next, sole request may release the previous idle
              // session resources. Never call the SDK's global/empty-ID form.
              try { cleanupSessionResources(sid); }
              catch { abortIfOwned(); throw new Error("speed_revalidation_required"); }
              assertOwner();
              authorizedFast = true;
            });
          } });
        // result() observes completion without consuming the event iterator.
        // An incompatible SDK must not look idle while its stream is running.
        if (typeof result?.result !== "function") { retired = true; abortIfOwned(); return result; }
        result.result().then(done, done);
        return result;
      } catch (error) { done(); throw error; }
    };
    const wrapper = { ...base, stream: wrap("stream"), streamSimple: wrap("streamSimple") };
    pi.registerProvider(wrapper);
    installed = { registry, wrapper };
  }
  function uninstall(pi) {
    // Do not lose ownership accounting across reload with an unfinished call.
    // Leave the retired wrapper registered: a replacement fails paid-closed.
    if (active.size) { retired = true; return; }
    if (installed && installed.registry.getRegisteredNativeProvider(PROVIDER) === installed.wrapper) pi.unregisterProvider(PROVIDER);
    installed = null;
  }
  return { read, install, uninstall, owned, route };
}
