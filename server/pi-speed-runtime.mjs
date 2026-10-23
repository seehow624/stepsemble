// Loaded only by Stepsemble's owned Pi launcher. Custom entries never enter
// model context. The provider hook returns the complete payload, not a wrapper.
import { createRequire } from "node:module";
import { createPiNativeSpeed } from "./pi-native-speed.mjs";
const require = createRequire(import.meta.url);
const { createMagpieGatewayService } = require("./magpie-gateway-service");
const { unknownSpeed, speedValue } = require("./agent-speed");
const TYPE = "stepsemble-speed";
const identity = model => JSON.stringify([model?.provider, model?.api, model?.baseUrl, model?.id]);
export function installPiSpeed(pi, { capability, nativeOptions } = {}) {
  const gateway = capability ? null : createMagpieGatewayService();
  const native = createPiNativeSpeed(nativeOptions);
  const read = capability || (async (model, ctx) => model?.provider === "magpie"
    ? gateway.speedCapability({ baseUrl: model.baseUrl, model: model.id, api: model.api }) : native.read(model, ctx));
  let state = { requested: "standard", identity: null, fingerprint: null }, generation = 0;
  const nativeTurnOwner = (ctx, signal, sessionId) => {
    const owner = generation, selected = identity(ctx.model);
    return () => {
      try { return typeof sessionId === "string" && !!sessionId && typeof signal?.aborted === "boolean"
        && typeof signal?.addEventListener === "function" && owner === generation
        && sessionId === ctx.sessionManager.getSessionId?.() && signal === ctx.signal && selected === identity(ctx.model); }
      catch { return false; }
    };
  };
  const prepareNative = (ctx, model, options) => {
    const snapshot = state, owner = generation, sessionId = ctx.sessionManager.getSessionId?.();
    const selected = identity(ctx.model);
    const ownsContext = nativeTurnOwner(ctx, options.signal, sessionId);
    const eligible = options.sessionId === sessionId && typeof options.onPayload === "function" && ownsContext();
    // Context getters are live: a suspended callback can resume in turn B.
    // Rejecting SDK onPayload stops A; abort/receipts may only target A's owner.
    const ownsTurn = () => eligible && ownsContext();
    const abortIfOwned = () => { if (ownsTurn()) ctx.abort?.(); };
    const assertOwner = () => { if (eligible && !ownsTurn()) throw new Error("speed_revalidation_required"); };
    const finish = async (payload, beforePaid) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        abortIfOwned(); throw new Error("speed_revalidation_required");
      }
      const next = { ...payload }; delete next.service_tier;
      if (!eligible || snapshot.requested !== "fast") return next;
      const cap = await native.read(model, ctx, { ok: true, apiKey: options.apiKey, headers: options.headers, env: options.env });
      if (owner !== generation || state !== snapshot || sessionId !== ctx.sessionManager.getSessionId?.()
        || snapshot.identity !== selected || selected !== identity(model) || selected !== identity(ctx.model)
        || options.signal !== ctx.signal || payload.model !== model.id || !native.owned(ctx)
        || cap.support !== "supported" || cap.fingerprint !== snapshot.fingerprint || options.signal?.aborted) {
        abortIfOwned();
        if (ownsTurn()) append({ ...snapshot, ok: false, reason: "speed_revalidation_required" });
        // Unlike extension handlers, the SDK's onPayload rejects before wire
        // dispatch. Abort as well: Pi catches ordinary extension hook throws.
        throw new Error("speed_revalidation_required");
      }
      beforePaid();
      next.service_tier = "priority";
      return next;
    };
    return { finish, assertOwner, abortIfOwned };
  };
  const append = data => pi.appendEntry(TYPE, data);
  pi.on("session_start", (_event, ctx) => {
    generation++;
    native.install(pi, ctx, prepareNative);
    const own = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === TYPE).at(-1)?.data;
    state = own && ["standard", "fast"].includes(own.requested)
      ? { requested: own.requested, identity: own.identity, fingerprint: own.fingerprint } : { requested: "standard", identity: null, fingerprint: null };
  });
  pi.on("session_shutdown", () => { generation++; native.uninstall(pi); });
  pi.on("model_select", (event, ctx) => {
    generation++;
    state = { requested: "standard", identity: identity(event.model || ctx.model), fingerprint: null };
    append({ ...state, ok: true, reason: "model_changed" });
  });
  pi.registerCommand(TYPE, { description: "Read or set this conversation's verified speed preference",
    handler: async (args, ctx) => {
      let input;
      try { input = JSON.parse(args); } catch { return; }
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.nonce || "") || !["get", "set"].includes(input.action)) return;
      const sessionId = ctx.sessionManager.getSessionId?.();
      const owner = generation, current = identity(ctx.model);
      let cap;
      try { cap = typeof ctx.abort === "function" ? await read(ctx.model, ctx) : unknownSpeed("speed_runtime_unverified"); }
      catch { cap = unknownSpeed("speed_route_unverified"); }
      if (owner !== generation || current !== identity(ctx.model) || ctx.sessionManager.getSessionId?.() !== sessionId
        || input.expectedSessionId !== undefined && sessionId !== input.expectedSessionId) {
        append({ nonce: input.nonce, ok: false, reason: "speed_revalidation_required" }); return;
      }
      if (state.identity !== current) state = { requested: "standard", identity: current, fingerprint: null };
      if (input.action === "set") {
        let requested;
        try { requested = speedValue(input.speed); } catch { append({ nonce: input.nonce, ok: false, reason: "speed_invalid" }); return; }
        if (requested === "ultrafast" || !ctx.isIdle() || requested === "fast" && (cap.support !== "supported" || input.fingerprint !== cap.fingerprint)) {
          append({ nonce: input.nonce, ok: false, reason: "speed_revalidation_required" }); return;
        }
        state = { requested, identity: current, fingerprint: cap.fingerprint || null };
      }
      append({ ...state, nonce: input.nonce, ok: true, capability: cap });
    } });
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    // Native requests are finalized inside the delegated provider, where the
    // actual request auth is available. A second registry lookup here cannot
    // identify the credential that the SDK already captured.
    if (ctx.model?.provider === "openai-codex" && native.owned(ctx)) return;
    const mayAffectTurn = ctx.model?.provider === "openai-codex"
      ? nativeTurnOwner(ctx, ctx.signal, ctx.sessionManager.getSessionId?.()) : () => true;
    // Only the selected, exact model on an identified Magpie input route.
    // Never attach a paid parameter to a virtual model or another provider.
    let cap;
    try { cap = await read(ctx.model, ctx); } catch { cap = unknownSpeed("speed_route_unverified"); }
    const owned = state.identity === identity(ctx.model);
    if (cap.support !== "supported" && !(owned && state.requested === "fast")) return;
    const next = { ...payload };
    const fast = owned && state.requested === "fast" && cap.support === "supported" && cap.fingerprint === state.fingerprint && payload.model === ctx.model?.id;
    if (owned && state.requested === "fast" && !fast) {
      // Pi catches hook errors and continues. Abort its operation instead;
      // the provider SDK receives the aborted signal before network dispatch.
      if (mayAffectTurn()) ctx.abort?.();
      if (mayAffectTurn()) append({ ...state, ok: false, reason: "speed_revalidation_required" });
    }
    if (ctx.model?.api === "anthropic-messages") {
      delete next.speed;
      const beta = "fast-mode-2026-02-01";
      const betas = (Array.isArray(payload.betas) ? payload.betas : []).filter(value => value !== beta);
      if (fast) { next.speed = "fast"; betas.push(beta); }
      if (betas.length) next.betas = betas; else delete next.betas;
    } else {
      delete next.service_tier;
      if (fast) next.service_tier = cap.tier;
    }
    return next;
  });
}
