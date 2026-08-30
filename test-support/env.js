"use strict";

function isolatedEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PI_HARBOR|PI_WEB)_/.test(key)) delete env[key];
  }
  for (const key of ["PI_HOME", "PI_BIN", "PI_OAUTH_CALLBACK_HOST"]) delete env[key];
  return { ...env, ...overrides };
}

module.exports = { isolatedEnvironment };
