"use strict";
/** Dependency-free SDK. Compile with scripts/build-client.mjs; generated JS ships with the PWA. */
var StepsembleClient;
(function (StepsembleClient) {
    class HttpError extends Error {
        status;
        path;
        code;
        constructor(message, status, path, code) {
            super(message);
            this.status = status;
            this.path = path;
            this.code = code;
        }
    }
    StepsembleClient.HttpError = HttpError;
    class Client {
        options;
        transport;
        constructor(options = {}) {
            this.options = options;
            this.transport = options.fetch || globalThis.fetch.bind(globalThis);
        }
        async request(base, path, options = {}) {
            // Capture base before awaiting. A host switch cannot retarget an in-flight request.
            const url = base + path;
            const response = await this.transport(url, { credentials: "same-origin", ...options });
            if (response.status === 401 && this.options.onUnauthorized)
                throw this.options.onUnauthorized(base, url);
            if (!response.ok) {
                let message = response.statusText;
                let code;
                try {
                    const body = await response.json();
                    if (typeof body.error === "string")
                        message = body.error;
                    else if (body.error && typeof body.error.message === "string") {
                        message = body.error.message;
                        code = body.error.code;
                    }
                }
                catch { /* Keep HTTP failure even when the body is malformed. */ }
                throw new HttpError(message, response.status, url, code);
            }
            return response.status === 204 ? null : response.json();
        }
        async negotiate(base, hello, signal) {
            try {
                const result = await this.request(base, "/api/protocol/handshake", {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(hello), signal,
                });
                if (!result || result.protocolVersion !== 1 || !Array.isArray(result.capabilities)
                    || result.capabilities.some(item => typeof item !== "string")
                    || !Array.isArray(result.disabledCapabilities) || result.mode !== "legacy-compatible") {
                    throw new HttpError("Invalid protocol response", 502, base + "/api/protocol/handshake", "invalid_response");
                }
                return result;
            }
            catch (error) {
                // Only an absent endpoint means an older host. Auth/network/version failures stay visible.
                if (error instanceof HttpError && error.status === 404)
                    return null;
                throw error;
            }
        }
    }
    StepsembleClient.Client = Client;
})(StepsembleClient || (StepsembleClient = {}));
