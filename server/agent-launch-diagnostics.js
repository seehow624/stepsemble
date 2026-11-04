"use strict";
const { performance } = require("node:perf_hooks");

// Request-local boundary evidence only, not a diagnosis or an operational retry.
const STAGES = new Set(["workspace_registry", "opencode_probe", "codex_probe", "claude_guard",
  "command_resolution", "cwd_validation", "task_initialization", "canonical_create",
  "supervisor_spawn", "supervisor_wait", "canonical_start", "public_result"]);
const BUCKETS = new Set(["lt_10ms", "lt_100ms", "lt_1s", "lt_5s", "gte_5s"]);
const CATEGORIES = new Set(["workspace_registry_unavailable", "canonical_error", "spawn_error", "supervisor_error", "unexpected"]);
const FAMILIES = new Set(["os", "parse", "unknown"]);
const CODES = new Set(["unknown", "EACCES", "EAGAIN", "EBUSY", "EINVAL", "ENOENT", "EPERM", "ENOSPC", "EMFILE", "ENFILE",
  "EISDIR", "EIO", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);
const ownValue = (object, key) => object && (typeof object === "object" || typeof object === "function")
  ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;

// Revalidate at the report boundary; never spread an upstream object or read getters.
function normalizeLaunchDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const schemaVersion = ownValue(value, "schemaVersion"), stage = ownValue(value, "stage"), elapsedBucket = ownValue(value, "elapsedBucket"),
    category = ownValue(value, "category"), errorFamily = ownValue(value, "errorFamily"), code = ownValue(value, "code");
  if (schemaVersion !== 1 || !STAGES.has(stage) || !BUCKETS.has(elapsedBucket) || !CATEGORIES.has(category)
    || !FAMILIES.has(errorFamily) || !CODES.has(code)) return null;
  return { schemaVersion: 1, stage, elapsedBucket, category, errorFamily, code };
}

function createLaunchDiagnostics(env = process.env, now = () => performance.now()) {
  if (env.STEPSEMBLE_AGENT_LAUNCH_DIAGNOSTICS !== "1") return null;
  const began = now();
  let stage = "workspace_registry";
  return {
    markStage(value) { if (STAGES.has(value)) stage = value; },
    failure(error) {
      const registry = stage === "workspace_registry" && ownValue(error, "message") === "workspace_registry_unavailable";
      const source = registry ? ownValue(error, "cause") : error;
      const candidate = ownValue(source, "code");
      const code = CODES.has(candidate) ? candidate : "unknown";
      const errorFamily = code !== "unknown" ? "os" : source instanceof SyntaxError ? "parse" : "unknown";
      const category = registry ? "workspace_registry_unavailable" : stage === "canonical_create" || stage === "canonical_start" ? "canonical_error"
        : stage === "supervisor_spawn" ? "spawn_error" : stage === "supervisor_wait" ? "supervisor_error" : "unexpected";
      const elapsed = Math.max(0, now() - began);
      const elapsedBucket = elapsed < 10 ? "lt_10ms" : elapsed < 100 ? "lt_100ms" : elapsed < 1000 ? "lt_1s" : elapsed < 5000 ? "lt_5s" : "gte_5s";
      return { schemaVersion: 1, stage, elapsedBucket, category, errorFamily, code };
    },
  };
}
module.exports = { createLaunchDiagnostics, normalizeLaunchDiagnostic };
