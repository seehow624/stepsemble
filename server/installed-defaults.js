"use strict";

// Preloaded by installed services, not by isolated development/test hosts.
const os = require("node:os");
const path = require("node:path");
const { applyNativeLaunchConfig } = require("./native-launch-config");
const configuredHome = process.env.PI_HOME || os.homedir();
const home = configuredHome === "~" ? os.homedir()
  : configuredHome.startsWith("~/") ? path.join(os.homedir(), configuredHome.slice(2)) : path.resolve(configuredHome);
applyNativeLaunchConfig(process.env, { home });
