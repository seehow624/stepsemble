"use strict";

// A Bot's skills through Hermes's dashboard REST routes: list, switch on and
// off, read and edit SKILL.md, and the Skill Hub (search, preview, security
// scan, install, uninstall). Installs run as Hermes background actions; the
// page follows them with action(). Every install is scanned again here right
// before it starts, so a skill Hermes would block never installs and one it
// would ask about needs the user's explicit acknowledgement.

const { HermesError } = require("./hermes-gateway-client");

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const ACTION = /^skills-(?:install|uninstall)-[a-z0-9-]{1,48}-[0-9a-f]{8}$/;
const MAX_SKILL = 512 * 1024;
const invalid = code => new HermesError(code, code, 400);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function check(pattern, value, code) {
  const text = String(value || "");
  if (!pattern.test(text) || text.split("/").includes("..")) throw invalid(code);
  return text;
}

function scanView(result) {
  const findings = (Array.isArray(result?.findings) ? result.findings : []).slice(0, 200).map(item => ({ severity: clip(item?.severity, 20),
    category: clip(item?.category, 60), file: clip(item?.file, 300), line: Number(item?.line) || null, description: clip(item?.description, 1000) }));
  const policy = ["allow", "ask", "block"].includes(result?.policy) ? result.policy : "ask";
  return { name: clip(result?.name, 128), trust: clip(result?.trust_level, 30), verdict: clip(result?.verdict, 30), summary: clip(result?.summary, 1000),
    policy, reason: clip(result?.policy_reason, 1000), findings };
}

function createHermesSkills({ client }) {
  const profileOf = value => check(PROFILE, value, "invalid_profile");

  async function list(value) {
    const profile = profileOf(value);
    const result = await client.rest("GET", "/api/skills", { query: { profile } });
    const rows = (Array.isArray(result) ? result : Array.isArray(result?.skills) ? result.skills : []).filter(row => typeof row?.name === "string");
    return { skills: rows.slice(0, 2000).map(row => ({ name: clip(row.name, 128), description: clip(row.description, 500), category: clip(row.category, 80),
      enabled: row.enabled !== false, source: clip(row.provenance, 20) || "agent", usage: Number(row.usage) || 0 }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)) };
  }
  async function toggle(value, name, enabled) {
    const profile = profileOf(value);
    await client.rest("PUT", "/api/skills/toggle", { body: { name: check(SKILL, name, "invalid_skill"), enabled: enabled === true, profile } });
    return { ok: true };
  }
  async function content(value, name) {
    const result = await client.rest("GET", "/api/skills/content", { query: { profile: profileOf(value), name: check(SKILL, name, "invalid_skill") } });
    return { name: clip(result?.name, 128), content: clip(result?.content, MAX_SKILL) };
  }
  async function save(value, name, text) {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_SKILL) throw invalid("invalid_content");
    await client.rest("PUT", "/api/skills/content", { body: { name: check(SKILL, name, "invalid_skill"), content: text, profile: profileOf(value) } });
    return { ok: true };
  }

  async function search(value, query) {
    const q = String(query || "").trim().slice(0, 200);
    if (!q) return { results: [], installed: [] };
    const result = await client.rest("GET", "/api/skills/hub/search", { query: { profile: profileOf(value), q, limit: 20 } });
    return {
      results: (Array.isArray(result?.results) ? result.results : []).filter(row => typeof row?.identifier === "string").map(row => ({
        name: clip(row.name, 128), description: clip(row.description, 500), source: clip(row.source, 60), identifier: clip(row.identifier, 256),
        trust: clip(row.trust_level, 30), repo: clip(row.repo, 200) })),
      installed: Object.keys(result?.installed && typeof result.installed === "object" ? result.installed : {}).slice(0, 2000),
      timedOut: Array.isArray(result?.timed_out) ? result.timed_out.map(String).slice(0, 20) : [],
    };
  }
  async function preview(value, identifier) {
    const result = await client.rest("GET", "/api/skills/hub/preview", { query: { profile: profileOf(value), identifier: check(IDENTIFIER, identifier, "invalid_identifier") } });
    return { name: clip(result?.name, 128), description: clip(result?.description, 1000), source: clip(result?.source, 60), trust: clip(result?.trust_level, 30),
      repo: clip(result?.repo, 200), skillMd: clip(result?.skill_md, MAX_SKILL), files: (Array.isArray(result?.files) ? result.files : []).map(String).slice(0, 500) };
  }
  async function scan(value, identifier) {
    return scanView(await client.rest("GET", "/api/skills/hub/scan", { query: { profile: profileOf(value), identifier: check(IDENTIFIER, identifier, "invalid_identifier") } }));
  }
  async function install(value, identifier, { acknowledged = false } = {}) {
    const profile = profileOf(value), id = check(IDENTIFIER, identifier, "invalid_identifier");
    const result = await scan(profile, id);
    if (result.policy === "block") throw new HermesError("skill_blocked", result.reason || "Hermes blocks this skill", 409);
    if (acknowledged !== true) throw new HermesError("confirm_required", "Review the scan and confirm the install", 409);
    const started = await client.rest("POST", "/api/skills/hub/install", { body: { identifier: id, profile } });
    return { action: ACTION.test(String(started?.name || "")) ? started.name : null };
  }
  async function uninstall(value, name) {
    const started = await client.rest("POST", "/api/skills/hub/uninstall", { body: { name: check(SKILL, name, "invalid_skill"), profile: profileOf(value) } });
    return { action: ACTION.test(String(started?.name || "")) ? started.name : null };
  }
  async function action(name) {
    const id = String(name || "");
    if (!ACTION.test(id)) throw invalid("invalid_action");
    const result = await client.rest("GET", `/api/actions/${encodeURIComponent(id)}/status`, { query: { lines: 20 } });
    return { running: result?.running === true, exitCode: Number.isInteger(result?.exit_code) ? result.exit_code : null,
      lines: (Array.isArray(result?.lines) ? result.lines : []).map(line => clip(String(line), 500)).slice(-20) };
  }

  return Object.freeze({ list, toggle, content, save, search, preview, scan, install, uninstall, action });
}

module.exports = { createHermesSkills };
