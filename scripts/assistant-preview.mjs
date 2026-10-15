// A disposable Host wired to a fake Hermes: no model, account or real Hermes
// is touched. Used by the assistant browser cases.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";

const require = createRequire(import.meta.url);
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));

export async function createAssistantPreview() {
  const fake = createFakeHermesGateway();
  await fake.start();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-assistant-preview-"));
  const config = path.join(home, ".config/stepsemble"), bin = path.join(home, "bin");
  await fs.mkdir(config, { recursive: true });
  await fs.mkdir(bin);
  const token = "assistant-preview-local-only";
  await fs.writeFile(path.join(config, "token"), token, { mode: 0o600 });
  await fs.writeFile(path.join(bin, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, stdio: ["ignore", "pipe", "pipe"],
    env: { ...cleanEnvironment(home), PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, PI_HOME: home, PI_BIN: path.join(home, "missing-pi"),
      STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0", STEPSEMBLE_HERMES_URL: fake.url, STEPSEMBLE_HERMES_ACP: "0" } });
  try { await waitForServer(child, 20_000); } catch (error) {
    await stopServer(child);
    await fake.close();
    await fs.rm(home, { recursive: true, force: true });
    throw error;
  }
  // Keep reading the Host's output so a full pipe never stalls it.
  child.stdout.resume();
  child.stderr.resume();
  return {
    origin: `http://127.0.0.1:${port}`, token, fake,
    async close() { await stopServer(child); await fake.close(); await fs.rm(home, { recursive: true, force: true }); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await createAssistantPreview();
  console.log(JSON.stringify({ origin: preview.origin, token: preview.token }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await preview.close(); process.exit(0); });
}
