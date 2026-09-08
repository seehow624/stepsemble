"use strict";
// Exact reviewed public artifact. No package install, CLI, login or query API.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { constants } = require("node:fs"), { registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");
const { READER } = require("../../../public/modules/claude-history");
const { sdkVersion: SDK_VERSION, nativeVersion: NATIVE_VERSION, sdkSha256: SDK_SHA256 } = READER;
const SDK_INTEGRITY = "sha512-5VJSzHQTAPFl2BytZSgyL0Xtdi3I7CeajEhO4KTvm6bx4nt1OIp+IHx78MuurA4Pp/t9UEPa3cWz8Q55Pi9MYw==";
const SDK_BYTES = 4 * 1024 * 1024, CHUNK_BYTES = 64 * 1024;
let attempted = false; // One SDK attempt per owned worker/job, including failures.
function validSdkPath(value) {
  return typeof value === "string" && value.length <= 4096 && path.isAbsolute(value)
    && value === path.resolve(value) && path.basename(value) === "sdk.mjs" && !/[\0*?\[\]{},\r\n]/.test(value);
}
const sameFile = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);
async function verifiedBytes(sdkPath) {
  if (await fs.realpath(sdkPath) !== sdkPath) throw new Error("sdk_unavailable");
  const before = await fs.lstat(sdkPath, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > BigInt(SDK_BYTES)) throw new Error("sdk_unavailable");
  let handle;
  try {
    handle = await fs.open(sdkPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error("sdk_unavailable");
    const size = Number(opened.size), bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = Math.min(CHUNK_BYTES, size - offset), { bytesRead } = await handle.read(bytes, offset, count, offset);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > count) throw new Error("sdk_unavailable");
      offset += bytesRead;
    }
    // A grow race cannot turn a validated size into an unbounded readFile().
    if ((await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0
      || !sameFile(opened, await handle.stat({ bigint: true }))
      || !sameFile(opened, await fs.lstat(sdkPath, { bigint: true }))
      || crypto.createHash("sha256").update(bytes).digest("hex") !== SDK_SHA256) throw new Error("sdk_unavailable");
    return bytes;
  } finally { if (handle) await handle.close(); } // An uncertain close consumes the sole attempt too.
}
async function loadReader(sdkPath, method = "getSessionMessages") {
  if (attempted) throw new Error("sdk_unavailable");
  attempted = true;
  try {
    if (!validSdkPath(sdkPath) || !["getSessionMessages", "getSessionInfo"].includes(method) || typeof registerHooks !== "function") throw new Error("sdk_unavailable");
    const bytes = await verifiedBytes(sdkPath);
    // Node >=22.15 synchronous hooks need no worker permission. Preserve a file
    // URL for the pinned bundle's import.meta.url/createRequire, but make this
    // import distinct from any previously cached namespace for the plain path.
    const url = `${pathToFileURL(sdkPath).href}?stepsemble_verified=${crypto.randomBytes(32).toString("hex")}`;
    let loaded = false;
    const hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        // Short-circuit resolution too: default file resolution could realpath
        // a swapped symlink into an unexpected URL before the load hook runs.
        return specifier === url ? { url, format: "module", shortCircuit: true } : nextResolve(specifier, context);
      },
      load(specifier, context, nextLoad) {
        if (specifier !== url) return nextLoad(specifier, context);
        if (loaded) throw new Error("sdk_unavailable");
        loaded = true; return { format: "module", source: bytes, shortCircuit: true };
      },
    });
    let sdk;
    try { sdk = await import(url); } finally { hook.deregister(); }
    if (!loaded || typeof sdk[method] !== "function") throw new Error("sdk_unavailable");
    await verifiedBytes(sdkPath); // Retain observed artifact-drift rejection after evaluation.
    return sdk[method];
  } catch { throw new Error("sdk_unavailable"); }
}
module.exports = { SDK_VERSION, NATIVE_VERSION, SDK_SHA256, SDK_INTEGRITY, validSdkPath, loadReader };
