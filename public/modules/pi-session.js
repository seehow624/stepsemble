"use strict";
/** Legacy Pi presentation only; not a durable run journal. Shared by Host/Web. */
var StepsemblePiSession;
(function (StepsemblePiSession) {
    const clean = (value) => typeof value === "string" ? value.trim() : "";
    function title(value = {}, fallback = "(Untitled)") {
        // An explicitly empty firstMessage means no user text, not a reason to use
        // an assistant reply. preview is only a rolling fallback for older Hosts.
        return clean(value.name) || clean(value.firstMessage)
            || (value.firstMessage === undefined ? clean(value.preview) : "") || fallback;
    }
    StepsemblePiSession.title = title;
    function exitStatus(event) {
        if (event.error || event.protocolFailed || event.wasStreaming)
            return "failed";
        // expectedClose is set by the Host BEFORE its own idle shutdown signal.
        // Never treat an unsolicited 143/SIGTERM (or SIGKILL escalation) as normal.
        const ordinary = event.code === 0 && !event.signal;
        const intentional = event.expectedClose === true &&
            ((event.code === 143 && !event.signal) || event.signal === "SIGTERM" ||
                (event.windowsTermination === true && event.code === 1 && !event.signal)); // Windows owned taskkill /T /F
        if (!ordinary && !intentional)
            return "failed";
        return event.runOutcome || "stopped";
    }
    StepsemblePiSession.exitStatus = exitStatus;
    function unexpectedExit(event) {
        // Old Hosts do not carry expectedClose; keep their failure visible.
        return exitStatus({ ...event, runOutcome: null }) === "failed";
    }
    StepsemblePiSession.unexpectedExit = unexpectedExit;
})(StepsemblePiSession || (StepsemblePiSession = {}));
if (typeof module !== "undefined")
    module.exports = StepsemblePiSession;
