"use strict";
// Exact reviewed public artifact. No package install, CLI, login or query API.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { READER } = require("../../../public/modules/claude-history");
const { sdkVersion: SDK_VERSION, nativeVersion: NATIVE_VERSION, sdkSha256: SDK_SHA256 } = READER;
const SDK_INTEGRITY = "sha512-5VJSzHQTAPFl2BytZSgyL0Xtdi3I7CeajEhO4KTvm6bx4nt1OIp+IHx78MuurA4Pp/t9UEPa3cWz8Q55Pi9MYw==";
function validSdkPath(value) {
  return typeof value === "string" && value.length <= 4096 && path.isAbsolute(value)
    && value === path.resolve(value) && path.basename(value) === "sdk.mjs" && !/[\0*?\[\]{},\r\n]/.test(value);
}
async function loadReader(sdkPath) {
  if (!validSdkPath(sdkPath) || await fs.realpath(sdkPath) !== sdkPath) throw new Error("sdk_unavailable");
  const verify = async () => {
    const stat = await fs.lstat(sdkPath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("sdk_unavailable");
    const bytes = await fs.readFile(sdkPath);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== SDK_SHA256) throw new Error("sdk_unavailable");
  };
  await verify();
  // Trusted, administrator-managed artifact location. Before/after hashes detect
  // observed drift, not an atomic loader/hostile-same-UID filesystem guarantee.
  const sdk = await import(pathToFileURL(sdkPath).href);
  await verify();
  if (typeof sdk.getSessionMessages !== "function") throw new Error("sdk_unavailable");
  return sdk.getSessionMessages;
}
module.exports = { SDK_VERSION, NATIVE_VERSION, SDK_SHA256, SDK_INTEGRITY, validSdkPath, loadReader };
