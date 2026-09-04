const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { isolatedEnvironment } = require("../test-support/env");
const { createPiResourcesService } = require("../server/pi-resources");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`server did not start: ${output}`));
    }, 8_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(" listening on ")) {
        cleanup();
        resolve();
      }
    };
    const onError = (chunk) => { output += chunk.toString(); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`server exited before start (${code ?? signal}): ${output}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onError);
    child.on("exit", onExit);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

function writeSkill(home, relative, { name, description }) {
  const dir = path.join(home, relative);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter, "utf8");
  return dir;
}

function seedHome(home) {
  fs.mkdirSync(path.join(home, ".pi", "agent", "extensions", "dir-ext"), { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "agent", "skills", "web-search", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agents", "skills", "pdf-tools"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "extensions", "single.ts"), "const x = 1;\n");
  fs.writeFileSync(path.join(home, ".pi", "agent", "extensions", "dir-ext", "index.ts"), "export default () => {};\n");
  fs.writeFileSync(path.join(home, ".pi", "agent", "skills", "web-search", "SKILL.md"),
    "---\nname: web-search\ndescription: Web search and extraction\n---\n# Web Search\n");
  fs.writeFileSync(path.join(home, ".pi", "agent", "skills", "web-search", "scripts", "run.sh"), "run\n");
  fs.writeFileSync(path.join(home, ".pi", "agent", "skills", "notes.md"),
    "---\nname: notes\ndescription: Root md skill\n---\n");
  fs.writeFileSync(path.join(home, ".agents", "skills", "pdf-tools", "SKILL.md"),
    "---\nname: pdf-tools\ndescription: PDF utilities\n---\n");
  fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
    packages: ["npm:pi-skills@1.2.3", "git:github.com/user/repo@v1", { source: "npm:filtered@2.0.0", extensions: [] }],
    extensions: ["~/safe-external-ext.ts"],
    skills: [],
    // A secret-looking settings value must never reach the inventory payload.
    httpProxy: "http://secret-proxy:7890",
  }, null, 2));
  fs.writeFileSync(path.join(home, "safe-external-ext.ts"), "export const safe = 1;\n");
}

test("pi-resources endpoint is auth-only and inventories extensions, skills, and packages read-only", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-resources-"));
  const home = path.join(temp, "home");
  seedHome(home);
  // A symlink pointing outside the Pi home must never be followed.
  fs.symlinkSync("/etc", path.join(home, ".pi", "agent", "extensions", "evil-link"), "dir");
  const port = await freePort();
  const env = isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_PORT: String(port),
    PI_BIN: "/path/that/does/not/exist",
  });
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopServer(child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  await waitForServer(child);
  const base = `http://127.0.0.1:${port}`;
  const token = (await fs.promises.readFile(path.join(home, ".config", "stepsemble", "token"), "utf8")).trim();

  const unauthorized = await fetch(`${base}/api/pi-resources`);
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 204);
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];

  const response = await fetch(`${base}/api/pi-resources`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.machine, "string");
  assert.ok(body.machine.length > 0);
  assert.equal(typeof body.generatedAt, "number");
  assert.equal(body.agentDir, "~/.pi/agent");

  const extensionNames = body.groups.extensions.map((entry) => entry.name).sort();
  assert.deepEqual(extensionNames, ["dir-ext", "safe-external-ext.ts", "single"]);
  const skillNames = body.groups.skills.map((entry) => entry.name).sort();
  assert.deepEqual(skillNames, ["notes", "pdf-tools", "web-search"]);
  const webSearch = body.groups.skills.find((entry) => entry.name === "web-search");
  assert.equal(webSearch.description, "Web search and extraction");
  assert.equal(webSearch.files, 2);
  assert.match(webSearch.hash, /^[0-9a-f]{64}$/);
  const packageSources = body.groups.packages.map((entry) => entry.source);
  assert.deepEqual(packageSources, ["npm:pi-skills@1.2.3", "git:github.com/user/repo@v1", "npm:filtered@2.0.0"]);
  assert.equal(body.groups.packages[0].type, "npm");
  assert.equal(body.groups.packages[0].ref, "1.2.3");
  assert.equal(body.groups.packages[1].type, "git");

  const payload = JSON.stringify(body);
  assert.equal(payload.includes(home), false, "absolute home path must never be exposed");
  assert.equal(payload.includes("secret-proxy"), false, "settings secrets must never be exposed");
  assert.equal(payload.includes("httpProxy"), false);
  assert.equal(payload.includes("evil-link"), false, "symlinks must be skipped");
});

test("pi-resources hashing is deterministic and detects content drift", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-resources-unit-"));
  try {
    const homeA = path.join(temp, "a");
    const homeB = path.join(temp, "b");
    for (const home of [homeA, homeB]) {
      fs.mkdirSync(home, { recursive: true });
      writeSkill(home, path.join(".pi", "agent", "skills", "web-search"), { name: "web-search", description: "Same skill" });
      fs.mkdirSync(path.join(home, ".pi", "agent", "skills", "web-search", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(home, ".pi", "agent", "skills", "web-search", "scripts", "run.sh"), "run\n");
    }
    const serviceA = createPiResourcesService({ home: homeA });
    const serviceB = createPiResourcesService({ home: homeB });
    const inventoryA = serviceA.inventory();
    const inventoryB = serviceB.inventory();
    const skillOf = (inventory) => inventory.groups.skills.find((entry) => entry.name === "web-search");
    assert.equal(skillOf(inventoryA).hash, skillOf(inventoryB).hash);

    fs.writeFileSync(path.join(homeB, ".pi", "agent", "skills", "web-search", "scripts", "run.sh"), "changed\n");
    assert.notEqual(skillOf(inventoryA).hash, skillOf(serviceB.inventory()).hash);

    // Oversized files stay listed but switch the tree to a partial hash.
    fs.writeFileSync(path.join(homeB, ".pi", "agent", "skills", "web-search", "big.bin"), Buffer.alloc(600 * 1024, 1));
    const partial = skillOf(serviceB.inventory());
    assert.equal(partial.partial, true);
    assert.match(partial.hash, /^[0-9a-f]{64}$/);

    // Credentials never appear in the inventory even when settings exist.
    fs.writeFileSync(path.join(homeB, ".pi", "agent", "settings.json"), JSON.stringify({
      packages: ["npm:pi-skills"],
      httpProxy: "http://secret-proxy:7890",
    }));
    const payload = JSON.stringify(serviceB.inventory());
    assert.equal(payload.includes("secret-proxy"), false);
    assert.equal(payload.includes("httpProxy"), false);
    assert.equal(payload.includes("npm:pi-skills"), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});