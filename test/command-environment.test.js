"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { withCommandDirectory } = require("../server/command-environment");

test("a script CLI's own folder is searched last, so its runtime beside it is found", () => {
  const bin = path.join(path.sep, "home", "me", ".bun", "bin");
  const env = { PATH: ["/usr/bin", "/bin"].join(path.delimiter), HOME: "/home/me" };
  const out = withCommandDirectory(env, path.join(bin, "omp"));
  assert.equal(out.PATH, ["/usr/bin", "/bin", bin].join(path.delimiter));
  assert.equal(out.HOME, "/home/me");
  assert.equal(env.PATH, ["/usr/bin", "/bin"].join(path.delimiter), "the service's own environment is left as it was");
  // A folder already on PATH keeps its place.
  const first = [bin, "/usr/bin"].join(path.delimiter);
  assert.equal(withCommandDirectory({ PATH: first }, path.join(bin, "omp")).PATH, first);
  assert.equal(withCommandDirectory({}, path.join(bin, "omp")).PATH, bin);
  assert.deepEqual(withCommandDirectory({ PATH: "/usr/bin" }, "omp"), { PATH: "/usr/bin" }, "only an absolute executable adds a folder");
});
