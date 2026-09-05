/** Dependency-free SDK. Compile with scripts/build-client.mjs; generated JS ships with the PWA. */
namespace StepsembleClient {
  export interface Handshake {
    clientVersion: string;
    protocolMin: number;
    protocolMax: number;
    platform: "web" | "macos" | "ios" | "windows" | "android" | "linux";
    deviceId: string;
    capabilities: string[];
  }
  export interface Negotiated {
    protocolVersion: 1;
    schemaVersion: string;
    hostVersion: string;
    mode: "legacy-compatible";
    capabilities: string[];
    disabledCapabilities: string[];
    limits: { handshakeBytes: number };
  }
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
      try {
        const result = await this.request<Negotiated>(base, "/api/protocol/handshake", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(hello), signal,
        });
        if (!result || result.protocolVersion !== 1 || !Array.isArray(result.capabilities)
          || result.capabilities.some(item => typeof item !== "string")
          || !Array.isArray(result.disabledCapabilities) || result.mode !== "legacy-compatible") {
          throw new HttpError("Invalid protocol response", 502, base + "/api/protocol/handshake", "invalid_response");
        }
        return result;
      } catch (error) {
        // Only an absent endpoint means an older host. Auth/network/version failures stay visible.
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
    }
  }
}
