"use strict";

// Bot management: a Bot is a Hermes profile. Its look (title, colour, hidden)
// lives in profile.yaml's ui_meta["hermes-bots"], shared with Hermes desktop,
// so a save merges into what is there and uses Hermes's per-key revision check
// instead of overwriting fields another client wrote. Personality (SOUL.md),
// model, skills, toolsets and MCP servers go through profiles.configure.

const { HermesError } = require("./hermes-gateway-client");
const { isPreset } = require("../public/modules/assistant-avatars");

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ANY_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,128}$/;
const IMAGE = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const META = "hermes-bots";
const MAX_SOUL = 256 * 1024, MAX_IMAGE = 2_000_000;
const invalid = code => new HermesError(code, code, 400);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function profileIdFor(label) {
  return String(label || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);
}
function profileName(value, { strict = false } = {}) {
  const name = String(value || "");
  if (!(strict ? PROFILE : ANY_PROFILE).test(name)) throw invalid("invalid_profile");
  return name;
}
function title(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  if (!text) throw invalid("invalid_title");
  return text;
}
function names(list) {
  if (!Array.isArray(list) || list.length > 500) throw invalid("invalid_list");
  return [...new Set(list.map(String))].map(name => { if (!NAME.test(name)) throw invalid("invalid_list"); return name; });
}

function createHermesBots({ client }) {
  const rpc = (method, params, timeoutMs = 30_000) => client.request(method, params, { timeoutMs });

  async function row(profile) {
    const result = await rpc("profiles.list", { include_sessions: false });
    const found = (Array.isArray(result?.profiles) ? result.profiles : []).find(item => item?.name === profile);
    if (!found) throw new HermesError("hermes_not_found", `There is no Bot called ${profile}`, 404);
    const meta = found.ui_meta?.[META] && typeof found.ui_meta[META] === "object" ? found.ui_meta[META] : {};
    return { row: found, meta, revision: Number(found.ui_meta_revisions?.[META]) || 0 };
  }

  async function describe(value) {
    const profile = profileName(value);
    const [{ row: listed, meta }, detail] = await Promise.all([row(profile), rpc("profiles.describe", { name: profile })]);
    return {
      name: profile, isDefault: listed.is_default === true, title: clip(meta.title, 80) || clip(listed.display_name, 80) || profile,
      color: COLOR.test(String(meta.color || "")) ? meta.color : null, hidden: meta.hidden === true, hasAvatar: listed.has_avatar === true,
      avatarPreset: isPreset(meta.avatarPreset) ? meta.avatarPreset : null,
      description: clip(detail?.description, 500), soul: clip(detail?.soul, MAX_SOUL),
      model: { provider: clip(detail?.model?.provider, 100), model: clip(detail?.model?.default, 200) },
      skills: (Array.isArray(detail?.skills) ? detail.skills : []).map(skill => ({ name: clip(skill?.name, 128), enabled: skill?.enabled !== false })),
      toolsets: (Array.isArray(detail?.toolsets) ? detail.toolsets : []).map(item => ({ name: clip(item?.name, 128), label: clip(item?.label, 120) || clip(item?.name, 128),
        description: clip(item?.description, 300), toolCount: Number(item?.tool_count) || 0, enabled: item?.enabled === true })),
      mcpServers: (Array.isArray(detail?.mcp_servers) ? detail.mcp_servers : []).map(item => ({ name: clip(item?.name, 128), enabled: item?.enabled === true,
        transport: clip(item?.transport, 20) })),
    };
  }

  // Only the sections present in `changes` are sent. Hermes applies each one
  // on its own and reports it; an expensive model is never written until the
  // user confirms (the reply carries Hermes's warning instead).
  async function configure(value, changes = {}) {
    const profile = profileName(value);
    const params = { name: profile };
    const look = ["title", "color", "hidden", "avatarPreset"].filter(key => changes[key] !== undefined);
    if (look.length) {
      if (changes.color !== undefined && changes.color !== null && !COLOR.test(String(changes.color))) throw invalid("invalid_color");
      if (changes.avatarPreset !== undefined && changes.avatarPreset !== null && !isPreset(changes.avatarPreset)) throw invalid("invalid_avatar_preset");
      const { meta, revision } = await row(profile);
      const next = { ...meta };
      if (changes.title !== undefined) next.title = title(changes.title);
      if (changes.color !== undefined) { if (changes.color) next.color = changes.color; else delete next.color; }
      if (changes.hidden !== undefined) { if (changes.hidden === true) next.hidden = true; else delete next.hidden; }
      if (changes.avatarPreset !== undefined) { if (changes.avatarPreset) next.avatarPreset = changes.avatarPreset; else delete next.avatarPreset; }
      params.ui_meta = { [META]: next };
      params.ui_meta_expected_revisions = { [META]: revision };
    }
    if (changes.soul !== undefined) {
      if (typeof changes.soul !== "string" || changes.soul.length > MAX_SOUL) throw invalid("invalid_soul");
      params.soul = changes.soul;
    }
    if (changes.description !== undefined) params.description = String(changes.description || "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
    if (changes.model !== undefined) {
      const provider = String(changes.model?.provider || ""), model = String(changes.model?.model || "");
      if (!NAME.test(provider) || !NAME.test(model)) throw invalid("invalid_model");
      Object.assign(params, { provider, model }, changes.confirmExpensive === true ? { confirm_expensive_model: true } : {});
    }
    if (changes.disabledSkills !== undefined) params.disabled_skills = names(changes.disabledSkills);
    if (changes.enabledToolsets !== undefined) params.enabled_toolsets = names(changes.enabledToolsets);
    if (changes.enabledMcpServers !== undefined) params.enabled_mcp_servers = names(changes.enabledMcpServers);
    if (Object.keys(params).length === 1) return { ok: true, confirm: null };
    const result = await rpc("profiles.configure", params);
    const applied = result?.applied && typeof result.applied === "object" ? result.applied : {};
    if (applied.ui_meta_conflicts) throw new HermesError("bot_changed", "This Bot was changed somewhere else; reopen it and try again", 409);
    const failed = Object.entries(applied).filter(([, done]) => done === false).map(([key]) => key);
    if (failed.length) throw new HermesError("bot_save_failed", `Hermes could not save: ${failed.join(", ")}`, 502);
    if (result?.confirm_required === true) return { ok: false, confirm: clip(result.confirm_message, 1000) || "Confirm this model" };
    return { ok: true, confirm: null };
  }

  async function create({ name, title: label, description, soul, color, cloneFrom, model } = {}) {
    const profile = profileName(name, { strict: true });
    const shown = title(label || profile);
    if (color !== undefined && color !== null && color !== "" && !COLOR.test(String(color))) throw invalid("invalid_color");
    const params = { name: profile };
    if (description) params.description = String(description).replace(/[\r\n]+/g, " ").trim().slice(0, 500);
    if (soul) { if (typeof soul !== "string" || soul.length > MAX_SOUL) throw invalid("invalid_soul"); params.soul = soul; }
    if (cloneFrom) params.clone_from = profileName(cloneFrom);
    if (model?.provider && model?.model) {
      if (!NAME.test(String(model.provider)) || !NAME.test(String(model.model))) throw invalid("invalid_model");
      Object.assign(params, { provider: String(model.provider), model: String(model.model) });
    }
    const result = await rpc("profiles.create", params, 120_000);
    const created = typeof result?.name === "string" && ANY_PROFILE.test(result.name) ? result.name : profile;
    await rpc("profiles.configure", { name: created, ui_meta: { [META]: { title: shown, ...(color ? { color } : {}) } }, ui_meta_expected_revisions: { [META]: 0 } });
    return { name: created };
  }

  async function avatar(value) {
    const result = await rpc("profiles.get_asset", { name: profileName(value), asset: "avatar" });
    return { data: result?.found === true && typeof result.data === "string" && IMAGE.test(result.data) ? result.data : null };
  }
  async function setAvatar(value, data) {
    const profile = profileName(value);
    if (data === null) { await rpc("profiles.set_asset", { name: profile, asset: "avatar", clear: true }); return { ok: true }; }
    const match = IMAGE.exec(String(data || ""));
    if (!match || Buffer.byteLength(match[1], "base64") > MAX_IMAGE) throw invalid("invalid_image");
    await rpc("profiles.set_asset", { name: profile, asset: "avatar", data });
    await configure(profile, { avatarPreset: null });
    return { ok: true };
  }

  // Deleting removes the profile directory with its conversations and skills,
  // so the caller must send the exact profile id the user typed back.
  async function remove(value, confirmName) {
    const profile = profileName(value);
    if (confirmName !== profile) throw invalid("confirm_mismatch");
    const { row: listed } = await row(profile);
    if (listed.is_default === true || profile === "default") throw invalid("default_bot");
    await client.rest("DELETE", `/api/profiles/${encodeURIComponent(profile)}`);
    return { ok: true };
  }

  async function models(value) {
    const result = await rpc("model.options", { profile: profileName(value) }, 60_000);
    return {
      current: { provider: clip(result?.provider, 100), model: clip(result?.model, 200) },
      providers: (Array.isArray(result?.providers) ? result.providers : []).filter(item => typeof item?.slug === "string").slice(0, 100).map(item => ({
        slug: clip(item.slug, 100), name: clip(item.name, 120) || clip(item.slug, 100),
        models: (Array.isArray(item.models) ? item.models : []).filter(model => typeof model === "string").slice(0, 500).map(model => model.slice(0, 200)) })),
    };
  }

  return Object.freeze({ describe, configure, create, avatar, setAvatar, remove, models });
}

module.exports = { createHermesBots, profileIdFor };
