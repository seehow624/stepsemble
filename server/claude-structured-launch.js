"use strict";

const { createClaudeStructuredSession } = require("./claude-code-structured-adapter");
const { failure } = require("./claude-desktop-state");

// Authentication and native execution must share the same macOS security
// session. Never silently fall back to the SSH host after broker failure.
async function launchClaudeStructuredSession({ desktopClient = null, platform = process.platform,
  sessionFactory = createClaudeStructuredSession, ...options } = {}) {
  const env = options.env || process.env;
  if (!desktopClient) {
    if (platform === "darwin" && (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)) throw failure("desktop_required");
    return sessionFactory(options);
  }
  if (typeof desktopClient.launchStructured !== "function") throw failure("desktop_upgrade_required");
  const child = await desktopClient.launchStructured({ cwd: options.cwd,
    sessionId: options.sessionId || null, permissionPromptTool: options.permissionPromptTool || null });
  try {
    return sessionFactory({ ...options, spawnImpl: () => child });
  } catch (error) {
    // The broker already owns a child. Constructor errors are not permission
    // to retry the launch; stop that exact child and retain the original error.
    try { child.kill("SIGTERM"); } catch {}
    throw error;
  }
}

module.exports = { launchClaudeStructuredSession };
