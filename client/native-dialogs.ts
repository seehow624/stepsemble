/** Ephemeral native Pi dialogs. No storage, credentials or automatic replies. */
namespace StepsembleDialogs {
  export interface Event {
    type: "extension_ui_request";
    id: string;
    method: "confirm" | "select" | "input" | "editor";
    title?: string;
    message?: string;
    placeholder?: string;
    prefill?: string;
    options?: string[];
    timeout?: number;
  }
  export interface Request {
    readonly hostBase: string;
    readonly sid: string;
    readonly id: string;
    readonly method: Event["method"];
    readonly event: Event;
    sending: boolean;
    draft?: string;
    failed: boolean;
  }
  const key = (host: string, sid: string, id: string) => JSON.stringify([host, sid, id]);
  const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value);
  export class Queue {
    private entries = new Map<string, { request: Request; json: string; bytes: number }>();
    private bytes = 0;
    constructor(private maxCount = 32, private maxBytes = 256 * 1024) {}
    enqueue(hostBase: string, sid: string, value: unknown): Request {
      if (typeof hostBase !== "string" || hostBase.length > 512 || !validId(sid) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native dialog");
      const event = value as Event;
      if (event.type !== "extension_ui_request" || !validId(event.id) || !["confirm", "select", "input", "editor"].includes(event.method)) throw new Error("Invalid native dialog");
      for (const field of ["title", "message", "placeholder", "prefill"] as const) if (event[field] !== undefined && typeof event[field] !== "string") throw new Error("Invalid native dialog");
      if (event.timeout !== undefined && (!Number.isSafeInteger(event.timeout) || event.timeout < 0 || event.timeout > 2147483647)) throw new Error("Invalid native dialog");
      if (event.method === "select" && (!Array.isArray(event.options) || event.options.length > 256 || event.options.some(option => typeof option !== "string"))) throw new Error("Invalid native dialog");
      const json = JSON.stringify(event), id = key(hostBase, sid, event.id);
      const old = this.entries.get(id);
      if (old) { if (old.json !== json) throw new Error("Conflicting native dialog"); return old.request; }
      const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > 64 * 1024 || this.entries.size >= this.maxCount || this.bytes + bytes > this.maxBytes) throw new Error("Native dialog queue is full");
      const request: Request = { hostBase, sid, id: event.id, method: event.method, event: JSON.parse(json) as Event, sending: false, failed: false };
      this.entries.set(id, { request, json, bytes }); this.bytes += bytes;
      return request;
    }
    next(hostBase: string, sid: string): Request | undefined {
      return [...this.entries.values()].find(item => item.request.hostBase === hostBase && item.request.sid === sid)?.request;
    }
    count(hostBase: string, sid: string): number {
      return [...this.entries.values()].filter(item => item.request.hostBase === hostBase && item.request.sid === sid).length;
    }
    contains(request: Request): boolean { return this.entries.get(key(request.hostBase, request.sid, request.id))?.request === request; }
    begin(request: Request): boolean {
      if (!this.contains(request) || request.sending) return false;
      request.sending = true; request.failed = false; return true;
    }
    failed(request: Request): boolean {
      if (!this.contains(request)) return false;
      request.sending = false; request.failed = true; return true;
    }
    complete(request: Request): boolean {
      return this.contains(request) && this.remove(request.hostBase, request.sid, request.id);
    }
    remove(hostBase: string, sid: string, requestId: string): boolean {
      const id = key(hostBase, sid, requestId), item = this.entries.get(id);
      if (!item) return false;
      this.entries.delete(id); this.bytes -= item.bytes;
      item.request.draft = undefined;
      return true;
    }
    clear(): void {
      for (const item of this.entries.values()) item.request.draft = undefined;
      this.entries.clear(); this.bytes = 0;
    }
  }
}
