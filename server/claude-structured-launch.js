"use strict";

const { createClaudeStructuredSession } = require("./claude-code-structured-adapter");
const { failure } = require("./claude-desktop-state");

// Authentication and native execution must share the same macOS security
// session. Never silently fall back to the SSH host after broker failure.
async function launchClaudeStructuredSession({ desktopClient = null, platform = process.platform,
  sessionFactory = createClaudeStructuredSession, onCapacity = null, ...options } = {}) {
  const env = options.env || process.env;
  if (!desktopClient) {
    if (platform === "darwin" && (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)) throw failure("desktop_required");
    return sessionFactory(options);
  }
  if (typeof desktopClient.launchStructured !== "function") throw failure("desktop_upgrade_required");
  const request = { cwd: options.cwd,
    sessionId: options.sessionId || null, permissionPromptTool: options.permissionPromptTool || null, ...(options.fork ? { fork: options.fork } : {}) };
  let child;
  try { child = await desktopClient.launchStructured(request); }
  catch (error) {
    if (error?.code !== "desktop_capacity" || error.uncertain || !onCapacity || !await onCapacity()) throw error;
    child = await desktopClient.launchStructured(request);
  }
  try {
    return sessionFactory({ ...options, spawnImpl: () => child });
  } catch (error) {
    // The broker already owns a child. Constructor errors are not permission
    // to retry the launch; stop that exact child and retain the original error.
    try { child.kill("SIGTERM"); } catch {}
    throw error;
  }
}

async function parkIdleClaudeStructuredSession({ sessions, excludeSessionId = null, canResume, beforeSuspend = () => {} }) {
  const candidates = [...sessions].map(([id, session]) => ({ id, session, status: session.status() }))
    .filter(row => row.id !== excludeSessionId && row.status.nativeSessionId !== excludeSessionId
      && row.session.isIdle?.() === true && canResume(row.status.nativeSessionId, row.status))
    .sort((a, b) => a.status.lastActivityAt - b.status.lastActivityAt);
  for (const { id, session, status } of candidates) {
    beforeSuspend(status);
    const result = await session.suspend();
    if (result.kind === "reject") continue;
    if (result.cleanupConfirmed !== true) return false;
    if (sessions.get(id) === session) sessions.delete(id);
    return true;
  }
  return false;
}

module.exports = { launchClaudeStructuredSession, parkIdleClaudeStructuredSession };
