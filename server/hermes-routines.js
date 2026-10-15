"use strict";

// Each Bot's routines are Hermes cron jobs in that Bot's profile. This module
// only reads and changes them through Hermes' own cron API; Hermes keeps and
// runs them. A routine made here is named the way Bot Mode names its own.

const { HermesError } = require("./hermes-gateway-client");

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^(?:local|origin|all|bot-chat(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?|[a-z][a-z0-9_]{1,31}(?::[A-Za-z0-9@#._:+-]{1,200})?)$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PREFIX = /^\[bot:[^\]]{1,64}\]\s*/;
const invalid = code => new HermesError(code, code, 400);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function profileName(value) {
  const name = String(value || "");
  if (!PROFILE.test(name)) throw invalid("invalid_profile");
  return name;
}
function jobId(value) {
  const id = String(value || "");
  if (!JOB.test(id)) throw invalid("invalid_routine");
  return id;
}
function deliverValue(value) {
  const tokens = [...new Set(String(value || "").split(",").map(token => token.trim()).filter(Boolean))];
  if (tokens.length > 10 || tokens.some(token => !TOKEN.test(token))) throw invalid("invalid_deliver");
  return tokens.length ? tokens.join(",") : "local";
}
function scheduleValue(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) throw invalid("invalid_schedule");
  return text;
}
function routine(job, profile) {
  if (!job || typeof job !== "object" || typeof job.id !== "string") return null;
  const value = job.schedule && typeof job.schedule === "object" ? job.schedule : {};
  return {
    id: job.id, profile: profile || clip(job.profile, 64) || "default", name: clip(job.name, 300), prompt: clip(job.prompt, 20000),
    schedule: { kind: clip(value.kind, 16), expr: clip(value.expr, 200), minutes: Number.isFinite(Number(value.minutes)) ? Number(value.minutes) : null,
      runAt: clip(value.run_at, 64), display: clip(job.schedule_display || value.display, 200) },
    enabled: job.enabled !== false, state: clip(job.state, 32), nextRunAt: clip(job.next_run_at, 64), lastRunAt: clip(job.last_run_at, 64),
    lastStatus: clip(job.last_status, 32), lastError: clip(job.last_error, 500), lastDeliveryError: clip(job.last_delivery_error, 500),
    deliver: clip(job.deliver, 500) || "local", model: clip(job.model, 200), provider: clip(job.provider, 100),
    skills: Array.isArray(job.skills) ? job.skills.filter(item => typeof item === "string").slice(0, 20) : [],
    noAgent: job.no_agent === true, hasScript: !!job.script,
  };
}
function fieldsFor(input, { profile, original }) {
  const out = {};
  if (input.name !== undefined) {
    const name = String(input.name || "").replace(/[\r\n]+/g, " ").trim().replace(PREFIX, "").slice(0, 200);
    out.name = name && (original === undefined || PREFIX.test(original)) ? `[bot:${profile}] ${name}` : name;
  }
  if (input.schedule !== undefined) out.schedule = scheduleValue(input.schedule);
  if (input.prompt !== undefined) {
    const prompt = String(input.prompt || "");
    if (prompt.length > 20000) throw invalid("invalid_prompt");
    out.prompt = prompt;
  }
  if (input.deliver !== undefined) out.deliver = deliverValue(input.deliver);
  if (input.model !== undefined) out.model = String(input.model || "").trim().slice(0, 200) || null;
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.length > 20) throw invalid("invalid_skills");
    out.skills = input.skills.map(item => String(item).trim()).filter(item => SKILL.test(item));
  }
  return out;
}

function createHermesRoutines({ client }) {
  const jobPath = id => `/api/cron/jobs/${encodeURIComponent(jobId(id))}`;

  async function list(profile) {
    const scope = profile ? profileName(profile) : "all";
    const result = await client.rest("GET", "/api/cron/jobs", { query: { profile: scope } });
    const rows = Array.isArray(result) ? result : Array.isArray(result?.jobs) ? result.jobs : [];
    return { routines: rows.map(job => routine(job, profile ? scope : null)).filter(Boolean) };
  }
  async function targets(profile) {
    const result = await client.rest("GET", "/api/cron/delivery-targets", { query: { profile: profileName(profile) } });
    return { targets: (Array.isArray(result?.targets) ? result.targets : []).filter(target => target && typeof target.id === "string" && TOKEN.test(target.id))
      .map(target => ({ id: target.id, name: clip(target.name, 100) || target.id, ready: target.home_target_set !== false })) };
  }
  async function runs(id, profile) {
    const result = await client.rest("GET", `${jobPath(id)}/runs`, { query: { profile: profileName(profile), limit: 20 } });
    return { runs: (Array.isArray(result?.runs) ? result.runs : []).filter(run => run && typeof run.id === "string").map(run => ({
      id: clip(run.id, 200), title: clip(run.title, 300), preview: clip(run.preview, 300), startedAt: Number(run.started_at) || 0,
      openable: !run.id.startsWith("cron_output:") && run.source !== "cron_output" })) };
  }
  async function create(profile, input = {}) {
    const name = profileName(profile);
    const fields = fieldsFor({ deliver: "bot-chat", ...input }, { profile: name, original: undefined });
    if (!fields.schedule) throw invalid("invalid_schedule");
    const job = await client.rest("POST", "/api/cron/jobs", { query: { profile: name }, body: { ...fields, paused: false } });
    return { routine: routine(job, name) };
  }
  async function update(id, profile, input = {}) {
    const name = profileName(profile);
    const current = await client.rest("GET", jobPath(id), { query: { profile: name } });
    const fields = fieldsFor(input, { profile: name, original: typeof current?.name === "string" ? current.name : "" });
    if (!Object.keys(fields).length) throw invalid("nothing_to_update");
    const job = await client.rest("PUT", jobPath(id), { query: { profile: name }, body: { updates: fields } });
    return { routine: routine(job, name) };
  }
  const action = verb => async (id, profile) => {
    const name = profileName(profile);
    return { routine: routine(await client.rest("POST", `${jobPath(id)}/${verb}`, { query: { profile: name } }), name) };
  };
  async function remove(id, profile) {
    await client.rest("DELETE", jobPath(id), { query: { profile: profileName(profile) } });
    return { ok: true };
  }

  return Object.freeze({ list, targets, runs, create, update, pause: action("pause"), resume: action("resume"), run: action("trigger"), remove });
}

module.exports = { createHermesRoutines };
