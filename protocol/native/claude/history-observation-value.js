"use strict";
// Compatibility entry point. The reviewed shape validator is shared with the
// browser; callers still must supply bounded, detached JSON (not raw objects).
module.exports = { validObservation: require("../../../public/modules/claude-history-value").validObservation };
