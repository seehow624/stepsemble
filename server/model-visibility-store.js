"use strict";

// The models and providers hidden from the model menu, kept on the Host so
// every device that uses it shows the same menu. A key is "<provider>::<model
// id>" for one model, or "<provider>::*" for a whole provider, including
// models it offers later. Hiding changes no agent's configuration or sign-in.

const fs = require("node:fs");
const path = require("node:path");

const MAX_KEYS = 5000;
const MAX_KEY_LENGTH = 512;

function validKey(value) {
  if (typeof value !== "string" || !value || value.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const split = value.indexOf("::");
  return split > 0 && split + 2 < value.length;
}

function keyList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_KEYS || !value.every(validKey)) {
    throw Object.assign(new Error("Invalid " + name + " list"), { statusCode: 400 });
  }
  return value;
}

function createModelVisibilityStore({ file }) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new TypeError("model_visibility_file_required");
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value && value.version === 1 && Array.isArray(value.hidden)) {
        return { saved: true, hidden: [...new Set(value.hidden.filter(validKey))].slice(0, MAX_KEYS), updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null };
      }
    } catch {}
    return { saved: false, hidden: [], updatedAt: null };
  }
  function change({ hide, show } = {}) {
    const hiding = keyList(hide, "hide"), showing = keyList(show, "show");
    const hidden = new Set(read().hidden);
    for (const key of showing) hidden.delete(key);
    for (const key of hiding) hidden.add(key);
    if (hidden.size > MAX_KEYS) throw Object.assign(new Error("Too many hidden models"), { statusCode: 400 });
    const next = { version: 1, hidden: [...hidden].sort(), updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    return { saved: true, hidden: next.hidden, updatedAt: next.updatedAt };
  }
  return Object.freeze({ read, change });
}

module.exports = { createModelVisibilityStore, validModelVisibilityKey: validKey, MAX_MODEL_VISIBILITY_KEYS: MAX_KEYS };
