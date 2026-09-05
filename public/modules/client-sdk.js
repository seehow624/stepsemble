"use strict";
var StepsembleClient;
(function (StepsembleClient) {
    function parse(domain, value) {
        if (!StepsembleProtocol.validate(domain, value).valid)
            throw new HttpError("Invalid protocol payload", 502, "", "invalid_payload");
        return value;
    }
    StepsembleClient.parse = parse;
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
            if (!StepsembleProtocol.validate("handshake", hello).valid || hello.protocolMin > hello.protocolMax) {
                throw new HttpError("Invalid protocol handshake", 400, base + "/api/protocol/handshake", "invalid_request");
            }
            try {
                const result = await this.request(base, "/api/protocol/handshake", {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(hello), signal,
                });
                if (!StepsembleProtocol.validate("negotiated", result).valid || !result
                    || result.protocolVersion < hello.protocolMin || result.protocolVersion > hello.protocolMax
                    || result.disabledCapabilities.some(capability => result.capabilities.includes(capability))) {
                    throw new HttpError("Invalid protocol response", 502, base + "/api/protocol/handshake", "invalid_response");
                }
                return result;
            }
            catch (error) {
                // Only an absent endpoint means an older host. Auth/network/version failures stay visible.
                if (error instanceof HttpError && error.status === 404)
                    return null;
                if (error instanceof SyntaxError)
                    throw new HttpError("Invalid protocol response", 502, base + "/api/protocol/handshake", "invalid_response");
                throw error;
            }
        }
    }
    StepsembleClient.Client = Client;
    /** Negotiation is coalesced per host, never shared across devices. Only a
     * successful response (including explicit legacy 404) is briefly cached. */
    class Connections {
        client;
        hello;
        ttlMs;
        timeoutMs;
        requiredCapabilities;
        hosts = new Map();
        constructor(client, hello, ttlMs = 60000, timeoutMs = 10000, requiredCapabilities = ["legacy.http"]) {
            this.client = client;
            this.hello = hello;
            this.ttlMs = ttlMs;
            this.timeoutMs = timeoutMs;
            this.requiredCapabilities = requiredCapabilities;
        }
        reset(base) {
            for (const [key, entry] of this.hosts) {
                if (base !== undefined && key !== base)
                    continue;
                entry.controller.abort();
                this.hosts.delete(key);
            }
        }
        async ensure(base, signal) {
            if (signal?.aborted)
                throw signal.reason || new Error("Request cancelled");
            let entry = this.hosts.get(base);
            if (entry && entry.expires <= Date.now()) {
                this.reset(base);
                entry = undefined;
            }
            if (!entry) {
                // Bound forgotten device entries without growing a browser-lifetime cache.
                if (this.hosts.size >= 16)
                    this.reset(this.hosts.keys().next().value);
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
                    if (this.hosts.get(base) === current)
                        this.hosts.delete(base);
                }).finally(() => clearTimeout(timer));
            }
            if (!signal)
                return entry.promise;
            // Cancelling one fetch does not cancel a shared handshake for other callers.
            const promise = entry.promise;
            return new Promise((resolve, reject) => {
                const abort = () => { cleanup(); reject(signal.reason || new Error("Request cancelled")); };
                const cleanup = () => signal.removeEventListener("abort", abort);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) {
                    abort();
                    return;
                }
                promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
            });
        }
    }
    StepsembleClient.Connections = Connections;
})(StepsembleClient || (StepsembleClient = {}));
