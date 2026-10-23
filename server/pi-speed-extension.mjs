// Loaded only by Stepsemble's owned Pi launcher. Custom entries never enter
// model context. The provider hook returns the complete payload, not a wrapper.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createMagpieGatewayService } = require("./magpie-gateway-service");
const { unknownSpeed, speedValue } = require("./agent-speed");
const TYPE = "stepsemble-speed";
const identity = model => JSON.stringify([model?.provider, model?.api, model?.baseUrl, model?.id]);
export function installPiSpeed(pi, { capability } = {}) {
  const gateway = capability ? null : createMagpieGatewayService();
  const read = capability || (async model => model?.provider === "magpie"
    ? gateway.speedCapability({ baseUrl: model.baseUrl, model: model.id, api: model.api }) : unknownSpeed("speed_route_unverified"));
  let state = { requested: "standard", identity: null, fingerprint: null };
  const append = data => pi.appendEntry(TYPE, data);
  pi.on("session_start", (_event, ctx) => {
    const own = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === TYPE).at(-1)?.data;
    state = own && ["standard", "fast"].includes(own.requested)
      ? { requested: own.requested, identity: own.identity, fingerprint: own.fingerprint } : { requested: "standard", identity: null, fingerprint: null };
  });
  pi.on("model_select", (event, ctx) => {
    state = { requested: "standard", identity: identity(event.model || ctx.model), fingerprint: null };
    append({ ...state, ok: true, reason: "model_changed" });
  });
  pi.registerCommand(TYPE, { description: "Read or set this conversation's verified speed preference",
    handler: async (args, ctx) => {
      let input;
      try { input = JSON.parse(args); } catch { return; }
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.nonce || "") || !["get", "set"].includes(input.action)) return;
      const sessionId = ctx.sessionManager.getSessionId?.();
      const current = identity(ctx.model), cap = typeof ctx.abort === "function" ? await read(ctx.model) : unknownSpeed("speed_runtime_unverified");
      if (input.expectedSessionId !== undefined && (sessionId !== input.expectedSessionId || ctx.sessionManager.getSessionId?.() !== sessionId)) {
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
    // Only the selected, exact model on an identified Magpie input route.
    // Never attach a paid parameter to a virtual model or another provider.
    let cap;
    try { cap = await read(ctx.model); } catch { cap = unknownSpeed("speed_route_unverified"); }
    const owned = state.identity === identity(ctx.model);
    if (cap.support !== "supported" && !(owned && state.requested === "fast")) return;
    const next = { ...payload };
    const fast = owned && state.requested === "fast" && cap.support === "supported" && cap.fingerprint === state.fingerprint && payload.model === ctx.model?.id;
    if (owned && state.requested === "fast" && !fast) {
      // Pi catches hook errors and continues. Abort its operation instead;
      // the provider SDK receives the aborted signal before network dispatch.
      ctx.abort?.();
      append({ ...state, ok: false, reason: "speed_revalidation_required" });
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
export default function stepsembleSpeed(pi) { installPiSpeed(pi); }
