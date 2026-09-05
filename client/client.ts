/// <reference path="./protocol-types.d.ts" />
/** Dependency-free SDK. Compile with scripts/build-client.mjs; generated JS ships with the PWA. */
declare const StepsembleProtocol: {
  validate(definition: string, value: unknown): { valid: boolean; code?: string };
  checkEvent(value: unknown): { valid: boolean; code?: string };
  checkProfile(value: unknown): { valid: boolean; code?: string };
  checkReplayBatch(value: unknown): { valid: boolean; code?: string };
  checkCommandContext(command: unknown, context: unknown): { valid: boolean; code?: string };
  inspectReplay(cursor: unknown, batch: unknown): StepsembleClient.ReplayResult;
};
namespace StepsembleClient {
  // Reserved domain shapes. Parsing is not a declaration that the Host has
  // durable sessions, approvals or journal endpoints enabled yet.
  export interface Domains { nativeReference: NativeReference; session: Session; run: Run; approval: Approval; launchProfile: LaunchProfile; event: WireEvent; cursor: Cursor; command: Command; page: Page; replayBatch: ReplayBatch; }
  export function parse<D extends keyof Domains>(domain: D, value: unknown): Domains[D] {
    const result = domain === "event" ? StepsembleProtocol.checkEvent(value)
      : domain === "launchProfile" ? StepsembleProtocol.checkProfile(value)
      : domain === "replayBatch" ? StepsembleProtocol.checkReplayBatch(value)
      : StepsembleProtocol.validate(domain, value);
    if (!result.valid) throw new HttpError("Invalid protocol payload", 502, "", result.code || "invalid_payload");
    return value as Domains[D];
  }
  export type ReplayResult = { kind: "apply"; events: WireEvent[]; cursor: Cursor } | { kind: "duplicate" } | { kind: "snapshot_required"; reason: string };
  export function inspectReplay(cursor: Cursor, batch: unknown): ReplayResult { return StepsembleProtocol.inspectReplay(cursor, batch); }
  export interface CommandContext { session: Session; run: Run | null; authenticatedDeviceId: string; launchProfile?: LaunchProfile; approval?: Approval; now?: number; }
  /** Preflight only. Durable authorization/idempotency still belong to the Host transaction. */
  export function checkCommand(command: Command, context: CommandContext): { valid: boolean; code?: string } { return StepsembleProtocol.checkCommandContext(command, context); }
  export class HttpError extends Error {
    constructor(message: string, public status: number, public path: string, public code?: string) { super(message); }
  }
  export interface Options {
    fetch?: typeof fetch;
    onUnauthorized?: (base: string, path: string) => Error;
  }
  export class Client {
    private transport: typeof fetch;
    constructor(private options: Options = {}) { this.transport = options.fetch || globalThis.fetch.bind(globalThis); }
    async request<T = unknown>(base: string, path: string, options: RequestInit = {}): Promise<T | null> {
      // Capture base before awaiting. A host switch cannot retarget an in-flight request.
      const url = base + path;
      const response = await this.transport(url, { credentials: "same-origin", ...options });
      if (response.status === 401 && this.options.onUnauthorized) throw this.options.onUnauthorized(base, url);
      if (!response.ok) {
        let message = response.statusText;
        let code: string | undefined;
        try {
          const body = await response.json();
          if (typeof body.error === "string") message = body.error;
          else if (body.error && typeof body.error.message === "string") { message = body.error.message; code = body.error.code; }
        } catch { /* Keep HTTP failure even when the body is malformed. */ }
        throw new HttpError(message, response.status, url, code);
      }
      return response.status === 204 ? null : response.json() as Promise<T>;
    }
    async negotiate(base: string, hello: Handshake, signal?: AbortSignal): Promise<Negotiated | null> {
      if (!StepsembleProtocol.validate("handshake", hello).valid || hello.protocolMin > hello.protocolMax) {
        throw new HttpError("Invalid protocol handshake", 400, base + "/api/protocol/handshake", "invalid_request");
      }
      try {
        const result = await this.request<Negotiated>(base, "/api/protocol/handshake", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(hello), signal,
        });
        if (!StepsembleProtocol.validate("negotiated", result).valid || !result
          || result.protocolVersion < hello.protocolMin || result.protocolVersion > hello.protocolMax
          || result.disabledCapabilities.some(capability => result.capabilities.includes(capability))) {
          throw new HttpError("Invalid protocol response", 502, base + "/api/protocol/handshake", "invalid_response");
        }
        return result;
      } catch (error) {
        // Only an absent endpoint means an older host. Auth/network/version failures stay visible.
        if (error instanceof HttpError && error.status === 404) return null;
        if (error instanceof SyntaxError) throw new HttpError("Invalid protocol response", 502, base + "/api/protocol/handshake", "invalid_response");
        throw error;
      }
    }
  }

  /** Negotiation is coalesced per host, never shared across devices. Only a
   * successful response (including explicit legacy 404) is briefly cached. */
  export class Connections {
    private hosts = new Map<string, { promise: Promise<Negotiated | null>; expires: number; controller: AbortController }>();
    constructor(private client: Client, private hello: () => Handshake, private ttlMs = 60000, private timeoutMs = 10000, private requiredCapabilities = ["legacy.http"]) {}
    reset(base?: string): void {
      for (const [key, entry] of this.hosts) {
        if (base !== undefined && key !== base) continue;
        entry.controller.abort(); this.hosts.delete(key);
      }
    }
    async ensure(base: string, signal?: AbortSignal | null): Promise<Negotiated | null> {
      if (signal?.aborted) throw signal.reason || new Error("Request cancelled");
      let entry = this.hosts.get(base);
      if (entry && entry.expires <= Date.now()) { this.reset(base); entry = undefined; }
      if (!entry) {
        // Bound forgotten device entries without growing a browser-lifetime cache.
        if (this.hosts.size >= 16) this.reset(this.hosts.keys().next().value);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new HttpError("Host protocol negotiation timed out", 408, base + "/api/protocol/handshake", "protocol_timeout")), this.timeoutMs);
        const promise = this.client.negotiate(base, this.hello(), controller.signal).then(result => {
          if (result && this.requiredCapabilities.some(capability => !result.capabilities.includes(capability))) {
            throw new HttpError("Host does not support this client transport", 426, base + "/api/protocol/handshake", "capability_missing");
          }
          return result;
        });
        entry = { promise, expires: Infinity, controller };
        const current = entry;
        this.hosts.set(base, current);
        promise.then(() => { current.expires = Date.now() + this.ttlMs; }, () => {
          if (this.hosts.get(base) === current) this.hosts.delete(base);
        }).finally(() => clearTimeout(timer));
      }
      if (!signal) return entry.promise;
      // Cancelling one fetch does not cancel a shared handshake for other callers.
      const promise = entry.promise;
      return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason || new Error("Request cancelled")); };
        const cleanup = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      });
    }
  }
}
