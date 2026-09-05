"use strict";

// Protocol negotiation is additive: existing /api/* and native RPC remain v0.
const PROTOCOL_VERSION = 1;
const SCHEMA_VERSION = "1.0.0";
const SUPPORTED_CAPABILITIES = Object.freeze(["legacy.http", "pi.native-rpc", "agent.terminal-v1"]);
const PLATFORMS = Object.freeze(["web", "macos", "ios", "windows", "android", "linux"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const contracts = require("../protocol/validator").createValidator(require("../protocol/v1/schema.json"));

function protocolError(code, message, retryable = false) {
  return { protocolVersion: PROTOCOL_VERSION, error: { code, message, retryable } };
}

function negotiate(client, hostVersion) {
  if (!contracts.validate("handshake", client).valid || client.protocolMin > client.protocolMax) {
    return { status: 400, body: protocolError("invalid_request", "Invalid protocol handshake") };
  }
  if (client.protocolMin > PROTOCOL_VERSION || client.protocolMax < PROTOCOL_VERSION) {
    return { status: 426, body: { ...protocolError("protocol_incompatible", "No common protocol version"), supported: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION } } };
  }
  return {
    status: 200,
    body: {
      protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION, hostVersion,
      mode: "legacy-compatible",
      capabilities: [...SUPPORTED_CAPABILITIES],
      disabledCapabilities: client.capabilities.filter(item => !SUPPORTED_CAPABILITIES.includes(item)),
      limits: { handshakeBytes: 16384 },
    },
  };
}

module.exports = { PROTOCOL_VERSION, SCHEMA_VERSION, SUPPORTED_CAPABILITIES, PLATFORMS, ID_PATTERN, protocolError, negotiate };
