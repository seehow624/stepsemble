/** Legacy Pi presentation only; not a durable run journal. Shared by Host/Web. */
namespace StepsemblePiSession {
  export interface Summary { name?: unknown; firstMessage?: unknown; preview?: unknown }
  const clean = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  export function title(value: Summary = {}, fallback = "(Untitled)"): string {
    // An explicitly empty firstMessage means no user text, not a reason to use
    // an assistant reply. preview is only a rolling fallback for older Hosts.
    return clean(value.name) || clean(value.firstMessage)
      || (value.firstMessage === undefined ? clean(value.preview) : "") || fallback;
  }
  export type Outcome = "completed" | "failed" | "stopped";
  export interface Exit {
    code?: number | null; signal?: string | null; expectedClose?: boolean;
    wasStreaming?: boolean; error?: unknown; protocolFailed?: boolean;
    windowsTermination?: boolean;
    runOutcome?: Outcome | null;
  }
  export function exitStatus(event: Exit): Outcome {
    if (event.error || event.protocolFailed || event.wasStreaming) return "failed";
    // expectedClose is set by the Host BEFORE its own idle shutdown signal.
    // Never treat an unsolicited 143/SIGTERM (or SIGKILL escalation) as normal.
    const ordinary = event.code === 0 && !event.signal;
    const intentional = event.expectedClose === true &&
      ((event.code === 143 && !event.signal) || event.signal === "SIGTERM" ||
        (event.windowsTermination === true && event.code === 1 && !event.signal)); // Windows owned taskkill /T /F
    if (!ordinary && !intentional) return "failed";
    return event.runOutcome || "stopped";
  }
  export function unexpectedExit(event: Exit): boolean {
    // Old Hosts do not carry expectedClose; keep their failure visible.
    return exitStatus({ ...event, runOutcome: null }) === "failed";
  }
}
if (typeof module !== "undefined") module.exports = StepsemblePiSession;
