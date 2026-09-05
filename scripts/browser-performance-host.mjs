#!/usr/bin/env node
// Isolated synthetic host for Chrome DevTools; never launch a real agent.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createFixture, freePort, waitForServer, stopServer, WORKLOAD } from "./host-performance-baseline.mjs";
const require = createRequire(import.meta.url);
const { isolatedEnvironment } = require("../test-support/env.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeContract = process.argv.includes("--native-pi-contract");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-browser-perf-"));
let child;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await stopServer(child);
  await fs.rm(temp, { recursive: true, force: true });
}
process.once("SIGINT", () => close().then(() => process.exit()));
process.once("SIGTERM", () => close().then(() => process.exit()));
try {
  const fixture = await createFixture(temp);
  const port = await freePort();
  const fakePi = path.join(fixture.binDir, "pi");
  await fs.copyFile(path.join(root, nativeContract ? "test-support/pi-contract-peer.cjs" : "test-support/synthetic-pi.cjs"), fakePi);
  await fs.chmod(fakePi, 0o700);
  // Discard inherited credentials and configuration. Only runtime essentials survive.
  const env = isolatedEnvironment();
  for (const key of Object.keys(env)) if (!["PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].includes(key)) delete env[key];
  Object.assign(env, {
    HOME: fixture.home, PI_HOME: fixture.home, PI_BIN: fakePi,
    STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_BROWSE_ROOTS: fixture.projectRoot, STEPSEMBLE_ORPHAN_EXIT: "0",
    ...(nativeContract ? { STEPSEMBLE_TEST_PI_FIXTURE: path.join(root, "protocol/native/pi/0.84.2.json") } : {}),
    PATH: `${fixture.binDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${env.PATH || "/usr/bin:/bin"}`,
  });
  child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForServer(child);
  child.stdout.resume(); child.stderr.resume();
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, fixtureHome: fixture.home, mode: nativeContract ? "native-contract-replay" : "performance", workload: WORKLOAD, longSession: fixture.longRelative }));
  console.log("Use loopback onboarding to sign in; enable Show temporary sessions. Ctrl-C removes only this synthetic fixture.");
  await new Promise(resolve => child.once("exit", resolve));
} finally { await close(); }
