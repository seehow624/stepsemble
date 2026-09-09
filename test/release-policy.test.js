"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawnSync } = require("node:child_process"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const isolatedEnvironment = (root, prefix = "") => {
  const systemPath = process.platform === "win32"
    ? [path.dirname(process.execPath), "C:\\Windows\\System32", "C:\\Windows"]
    : [path.dirname(process.execPath), "/usr/bin", "/bin"];
  const environment = {
    HOME: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PATH: [prefix, ...systemPath].filter(Boolean).join(path.delimiter),
  };
  if (process.platform === "win32") {
    environment.USERPROFILE = root;
    environment.Path = environment.PATH;
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
  }
  return environment;
};

test("release policy accepts exact stable and prerelease pairs only", async () => {
  const { releasePlan } = await import("../scripts/release-policy.mjs");
  assert.deepEqual(releasePlan("v3.0.7", "3.0.7"), { tag: "v3.0.7", version: "3.0.7", prerelease: false });
  assert.deepEqual(releasePlan("v3.0.7-rc.7", "3.0.7-rc.7"), { tag: "v3.0.7-rc.7", version: "3.0.7-rc.7", prerelease: true });
  assert.throws(() => releasePlan("v3.0.7-rc.07", "3.0.7-rc.07"));
  assert.throws(() => releasePlan("v3.0.7\n", "3.0.7\n"));
  assert.throws(() => releasePlan("v3.0.7", "3.0.7\n"));
  for (const tag of ["3.0.7", "v03.0.7", "v3.0", "v3.0.7+build", "v3.0.7-rc.07", "v3.0.7-rc/7", "v3.0.7;touch /tmp/release-policy"]) {
    assert.throws(() => releasePlan(tag, "3.0.7"));
  }
  assert.throws(() => releasePlan("v3.0.7", "3.0.7-rc.7"), /tag\/package version mismatch/);
  assert.throws(() => releasePlan("v3.0.7-rc.7", "3.0.7"), /tag\/package version mismatch/);
  assert.throws(() => releasePlan("v3.0.7-rc.7-alpha.01", "3.0.7-rc.7-alpha.01"));
});

test("release policy CLI works from a path containing spaces and fails closed", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "release policy "));
  try {
    const helper = path.join(temporary, "release policy.mjs"); fs.copyFileSync(path.resolve("scripts/release-policy.mjs"), helper);
    const run = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", env: isolatedEnvironment(temporary) });
    const stable = run("v3.0.7", "3.0.7");
    const candidate = run("v3.0.7-rc.7", "3.0.7-rc.7");
    assert.deepEqual([stable.status, stable.stdout.trim()], [0, "prerelease=false"]);
    assert.deepEqual([candidate.status, candidate.stdout.trim()], [0, "prerelease=true"]);
    for (const args of [["v3.0.7", "3.0.7-rc.7"], ["v3.0.7-rc.7", "3.0.0"], ["v3.0.7\n", "3.0.7"], ["v3.0.7-rc.7-alpha.01", "3.0.7-rc.7-alpha.01"]]) {
      const invalid = run(...args);
      assert.notEqual(invalid.status, 0);
      assert.equal(invalid.stdout, "");
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("release workflow keeps candidate publishing prerelease-only and preserves attestation", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /scripts\/release-policy\.mjs/);
  assert.match(workflow, /RELEASE_PRERELEASE: \$\{\{ steps\.policy\.outputs\.prerelease \}\}/);
  assert.match(workflow, /case "\$RELEASE_PRERELEASE" in[\s\S]*true\) gh_args\+=\(--prerelease --latest=false\) ;;[\s\S]*false\) ;;[\s\S]*\*\) echo "invalid release policy output" >&2; exit 1/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /actions\/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.doesNotMatch(workflow, /gh release create \$GITHUB_REF_NAME/);
});

test("release publish shell flags are fail-closed", { skip: process.platform === "win32" }, () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8");
  const marker = "      - name: Publish GitHub Release";
  const publishStep = workflow.slice(workflow.indexOf(marker));
  const runMatch = publishStep.match(/        run: \|\n([\s\S]*)$/);
  assert.ok(runMatch, "publish step shell script is present");
  const publishScript = runMatch[1].replace(/^ {10}/gm, "");

  const runPublish = (tag, prerelease) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "release fake-gh "));
    const capture = path.join(temporary, "args.txt");
    const fakeGh = path.join(temporary, "gh");
    fs.writeFileSync(fakeGh, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GH_CAPTURE\"\n", { mode: 0o700 });
    try {
      const env = isolatedEnvironment(temporary, temporary);
      env.GH_CAPTURE = capture;
      env.GH_TOKEN = "test-token";
      env.GITHUB_REF_NAME = tag;
      env.RELEASE_PRERELEASE = prerelease;
      const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", publishScript], {
        encoding: "utf8",
        env,
      });
      const args = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8").trim().split(/\r?\n/) : [];
      return { ...result, args };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  };

  const candidate = runPublish("v3.0.7-rc.7", "true");
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.deepEqual(candidate.args.slice(0, 7), [
    "release", "create", "v3.0.7-rc.7",
    "stepsemble-v3.0.7-rc.7.tar.gz", "stepsemble-v3.0.7-rc.7.tar.gz.sha256",
    "pi-harbor-v3.0.7-rc.7.tar.gz", "pi-harbor-v3.0.7-rc.7.tar.gz.sha256",
  ]);
  assert.deepEqual(candidate.args.slice(7, 11), ["--verify-tag", "--generate-notes", "--title", "Stepsemble 3.0.7-rc.7"]);
  assert.deepEqual(candidate.args.slice(11), ["--prerelease", "--latest=false"]);

  const stable = runPublish("v3.0.7", "false");
  assert.equal(stable.status, 0, stable.stderr);
  assert.deepEqual(stable.args.slice(0, 7), [
    "release", "create", "v3.0.7",
    "stepsemble-v3.0.7.tar.gz", "stepsemble-v3.0.7.tar.gz.sha256",
    "pi-harbor-v3.0.7.tar.gz", "pi-harbor-v3.0.7.tar.gz.sha256",
  ]);
  assert.deepEqual(stable.args.slice(7, 11), ["--verify-tag", "--generate-notes", "--title", "Stepsemble 3.0.7"]);
  assert.deepEqual(stable.args.slice(11), []);

  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release shell probe "));
  const probe = path.join(probeRoot, "created-by-injection");
  try {
    const quoted = runPublish(`v3.0.7;touch ${probe}`, "false");
    assert.equal(quoted.status, 0, quoted.stderr);
    assert.equal(fs.existsSync(probe), false, "tag interpolation must not execute shell text");
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }

  for (const value of ["", "unexpected"]) {
    const invalid = runPublish("v3.0.7", value);
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(invalid.args, []);
  }
});
