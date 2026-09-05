"use strict";
/** Ephemeral native Pi dialogs. No storage, credentials or automatic replies. */
var StepsembleDialogs;
(function (StepsembleDialogs) {
    const key = (host, sid, id) => JSON.stringify([host, sid, id]);
    const validId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value);
    class Queue {
        maxCount;
        maxBytes;
        entries = new Map();
        bytes = 0;
        constructor(maxCount = 32, maxBytes = 256 * 1024) {
            this.maxCount = maxCount;
            this.maxBytes = maxBytes;
        }
        enqueue(hostBase, sid, value) {
            if (typeof hostBase !== "string" || hostBase.length > 512 || !validId(sid) || !value || typeof value !== "object" || Array.isArray(value))
                throw new Error("Invalid native dialog");
            const event = value;
            if (event.type !== "extension_ui_request" || !validId(event.id) || !["confirm", "select", "input", "editor"].includes(event.method))
                throw new Error("Invalid native dialog");
            for (const field of ["title", "message", "placeholder", "prefill"])
                if (event[field] !== undefined && typeof event[field] !== "string")
                    throw new Error("Invalid native dialog");
            if (event.timeout !== undefined && (!Number.isSafeInteger(event.timeout) || event.timeout < 0 || event.timeout > 2147483647))
                throw new Error("Invalid native dialog");
            if (event.method === "select" && (!Array.isArray(event.options) || event.options.length > 256 || event.options.some(option => typeof option !== "string")))
                throw new Error("Invalid native dialog");
            const json = JSON.stringify(event), id = key(hostBase, sid, event.id);
            const old = this.entries.get(id);
            if (old) {
                if (old.json !== json)
                    throw new Error("Conflicting native dialog");
                return old.request;
            }
            const bytes = new TextEncoder().encode(json).byteLength;
            if (bytes > 64 * 1024 || this.entries.size >= this.maxCount || this.bytes + bytes > this.maxBytes)
                throw new Error("Native dialog queue is full");
            const request = { hostBase, sid, id: event.id, method: event.method, event: JSON.parse(json), sending: false, failed: false };
            this.entries.set(id, { request, json, bytes });
            this.bytes += bytes;
            return request;
        }
        next(hostBase, sid) {
            return [...this.entries.values()].find(item => item.request.hostBase === hostBase && item.request.sid === sid)?.request;
        }
        count(hostBase, sid) {
            return [...this.entries.values()].filter(item => item.request.hostBase === hostBase && item.request.sid === sid).length;
        }
        contains(request) { return this.entries.get(key(request.hostBase, request.sid, request.id))?.request === request; }
        begin(request) {
            if (!this.contains(request) || request.sending)
                return false;
            request.sending = true;
            request.failed = false;
            return true;
        }
        failed(request) {
            if (!this.contains(request))
                return false;
            request.sending = false;
            request.failed = true;
            return true;
        }
        complete(request) {
            return this.contains(request) && this.remove(request.hostBase, request.sid, request.id);
        }
        remove(hostBase, sid, requestId) {
            const id = key(hostBase, sid, requestId), item = this.entries.get(id);
            if (!item)
                return false;
            this.entries.delete(id);
            this.bytes -= item.bytes;
            item.request.draft = undefined;
            return true;
        }
        clear() {
            for (const item of this.entries.values())
                item.request.draft = undefined;
            this.entries.clear();
            this.bytes = 0;
        }
    }
    StepsembleDialogs.Queue = Queue;
})(StepsembleDialogs || (StepsembleDialogs = {}));
