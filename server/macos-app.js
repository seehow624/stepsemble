"use strict";
// Stepsemble.app starts this Host on macOS (macos/Stepsemble,
// deploy/stepsemble-macos-app.sh). macOS asks about, and remembers, folder
// access for that app, so a refused folder sends people to its window.
const fs = require("node:fs");
const path = require("node:path");

// The app tells the Host it starts where the app is. The value is read once
// and removed, so agents and other programs the Host starts do not inherit
// it (a Host such a program starts was not started by the app).
function takeMacosApp(env = process.env, { platform = process.platform, statSync = fs.statSync } = {}) {
  const bundle = env.STEPSEMBLE_APP_BUNDLE, version = env.STEPSEMBLE_APP_VERSION;
  delete env.STEPSEMBLE_APP_BUNDLE;
  delete env.STEPSEMBLE_APP_VERSION;
  if (platform !== "darwin" || typeof bundle !== "string" || !path.isAbsolute(bundle) || !bundle.endsWith(".app")) return null;
  try { if (!statSync(bundle).isDirectory()) return null; } catch { return null; }
  return { bundle, version: typeof version === "string" ? version.slice(0, 40) : "" };
}

// The arguments for /usr/bin/open: this app's Folder Access window, asking
// macOS about each place right away, whether or not the app is already open
// (arguments after --args would not reach an app that is running).
function macosAppOpenArguments(app) {
  return ["-a", app.bundle, "stepsemble://folder-access"];
}

module.exports = { takeMacosApp, macosAppOpenArguments };
