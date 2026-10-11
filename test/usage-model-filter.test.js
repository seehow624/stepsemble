"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const Data = require("../public/modules/usage-data");
const model = "claude-opus-5-5", selected = JSON.stringify(["anthropic", model]);
const stats = (tokens, knownCost = 0) => ({ ...Data.empty(), input: tokens, tokens, calls: 1, knownCost, pricedCalls: knownCost ? 1 : 0, unpricedCalls: knownCost ? 0 : 1 });
const rawRows = [["openai", "anthropic/" + model, 11, .1], ["opencodex", "anthropic/" + model, 23, .2], ["anthropic", model, 37, .3], ["openai", "gpt-test", 43, 0]]
  .map(([provider, name, tokens, price]) => ({ ...stats(tokens, price), id: JSON.stringify([provider, name]), name, provider }));
function legacyReport(rows = rawRows) {
  const total = rows.reduce((sum, row) => Data.add(sum, row), Data.empty());
  return { version: 1, scope: "machine", currency: "USD", costKind: "estimate", total, models: rows,
    days: rows.length ? [{ ...total, id: "2026-10-11", date: "2026-10-11" }] : [], agents: rows.length ? [{ ...total, id: "pi", name: "pi" }] : [],
    projects: rows.length ? [{ ...total, id: "/owned/project", name: "Project", cwd: "/owned/project" }] : [],
    sessions: rows.length ? [{ ...total, id: "same-session", name: "Session", agent: "pi", registered: true }] : [],
    coverage: { covered: 7, missing: 1, partial: 0, unsupported: 0, indexing: 0, issuesOmitted: 0, scope: "history" },
    issues: [{ entry: "missing", name: "Missing", status: "missing", reason: "missing_file" }], priceUpdatedAt: 1000,
    facets: { models: rawRows.map(({ id, name, provider }) => ({ id, name, provider })), agents: [{ id: "pi", name: "pi" }], projects: [{ id: "/owned/project", name: "Project" }] } };
}
function modernReport(filtered = false) {
  const row = { ...Data.empty(), input: 71, tokens: 71, calls: 3, knownCost: .6, pricedCalls: 3, id: selected, name: model, provider: "anthropic" };
  const report = legacyReport(filtered ? [row] : [row, rawRows[3]]);
  return { ...report, modelGrouping: "vendor", facets: { ...report.facets, models: [row, rawRows[3]].map(({ id, name, provider }) => ({ id, name, provider })) } };
}
const query = () => new URLSearchParams({ from: "1791648000000", to: "1791734400000", timeZone: "Asia/Kuala_Lumpur", model: selected, agent: "pi", project: "/owned/project", fresh: "1" });
function legacyReader(calls, rows = rawRows) {
  return async params => { calls.push(Object.fromEntries(params)); return legacyReport(params.has("model") ? rows.filter(row => row.id === params.get("model")) : rows); };
}
function assertSelected(report) {
  assert.equal(report.total.tokens, 71); assert.equal(report.total.calls, 3); assert.ok(Math.abs(report.total.knownCost - .6) < 1e-12);
  assert.equal(report.models.length, 1); assert.equal(report.models[0].id, selected); assert.equal(report.models[0].provider, "anthropic");
  for (const key of ["days", "models", "agents", "projects", "sessions"]) assert.equal(report[key].reduce((sum, row) => sum + row.tokens, 0), 71);
  assert.equal(report.coverage.covered, 7); assert.equal(report.coverage.missing, 1); assert.equal(report.issues.length, 1);
  assert.equal(report.sessions[0].id, "same-session"); assert.equal(report.projects[0].id, "/owned/project");
}
test("old and new Hosts merge recognized model rows without doubling history coverage", () => {
  const combined = Data.combine([{ report: legacyReport(), host: "old", name: "Old" }, { report: modernReport(), host: "new", name: "New" }]);
  assert.equal(combined.models.length, 2); assert.equal(combined.models.find(row => row.id === selected).tokens, 142);
  assert.equal(combined.total.tokens, 228); assert.equal(combined.total.calls, 8); assert.equal(combined.coverage.covered, 14); assert.equal(combined.coverage.missing, 2);
  assert.equal(combined.sessions.length, 2); assert.equal(combined.projects.length, 2);
  assert.equal(new Set(legacyReport().facets.models.slice(0, 3).map(row => Data.modelGroup(row).id)).size, 1);
});
test("model filters on an old Host include every connection but count coverage and issues once", async () => {
  const calls = [], params = query(), before = params.toString();
  const report = await Data.readReport(legacyReader(calls), params);
  assertSelected(report); assert.equal(report.modelGrouping, undefined); assert.equal(params.toString(), before);
  assert.equal(calls.length, 4); assert.equal(calls[0].model, undefined);
  assert.deepEqual(calls.slice(1).map(call => call.model), rawRows.slice(0, 3).map(row => row.id));
  for (const call of calls) for (const key of ["from", "to", "timeZone", "agent", "project", "fresh"]) assert.equal(call[key], params.get(key));
});
test("a current Host with confirmed vendor grouping needs just one filtered request", async () => {
  const calls = [];
  const report = await Data.readReport(async params => { calls.push(params.toString()); return modernReport(params.has("model")); }, query(), { modelGrouping: "vendor" });
  assertSelected(report); assert.equal(calls.length, 1); assert.equal(new URLSearchParams(calls[0]).get("model"), selected);
});
test("cold reads discover grouping; an unfiltered read never needs a compatibility preflight", async () => {
  const calls = [], read = async params => { calls.push(params.has("model")); return modernReport(params.has("model")); };
  assertSelected(await Data.readReport(read, query())); assert.deepEqual(calls, [false, true]);
  calls.length = 0; const params = query(); params.delete("model");
  assert.equal((await Data.readReport(read, params)).total.tokens, 114); assert.deepEqual(calls, [false]);
});
test("cross-version filtered totals and every dimension agree across two Hosts", async () => {
  const old = await Data.readReport(legacyReader([]), query()), current = await Data.readReport(async () => modernReport(true), query(), { modelGrouping: "vendor" });
  const combined = Data.combine([{ report: old, host: "mini", name: "Mini" }, { report: current, host: "mbp", name: "MBP" }]);
  assert.equal(combined.models.length, 1); assert.equal(combined.total.tokens, 142); assert.equal(combined.total.calls, 6); assert.equal(combined.coverage.covered, 14);
  for (const key of ["days", "models", "agents", "projects", "sessions"]) assert.equal(combined[key].reduce((sum, row) => sum + row.tokens, 0), 142);
});
test("a Host updating during legacy filters cannot count a vendor aggregate alongside its component", async () => {
  let count = 0;
  const report = await Data.readReport(async params => {
    if (++count <= 2) return legacyReport(params.has("model") ? rawRows.filter(row => row.id === params.get("model")) : rawRows);
    return modernReport(true);
  }, query());
  assertSelected(report); assert.equal(report.modelGrouping, "vendor"); assert.equal(count, 4);
});
test("a rolled-back Host is rediscovered instead of treating its one native Claude row as the whole model", async () => {
  const calls = [], report = await Data.readReport(legacyReader(calls), query(), { modelGrouping: "vendor" });
  assertSelected(report); assert.equal(calls.length, 5); assert.equal(calls[0].model, selected); assert.equal(calls[1].model, undefined);
});
test("a cold read that rolls back after its capability preflight rediscovers all legacy connections", async () => {
  let calls = 0;
  const report = await Data.readReport(async params => ++calls === 1 ? modernReport() : legacyReport(params.has("model") ? rawRows.filter(row => row.id === params.get("model")) : rawRows), query());
  assertSelected(report); assert.equal(calls, 6);
});
test("inconsistent capabilities during an update fail rather than looping or returning a component as the whole model", async () => {
  let calls = 0;
  await assert.rejects(Data.readReport(async params => {
    if (++calls === 1) return legacyReport();
    if (calls === 2) return modernReport(true);
    return legacyReport(rawRows.filter(row => row.id === params.get("model")));
  }, query()), /usage_grouping_changed/);
  assert.equal(calls, 3);
});
test("changing periods rereads legacy facets so new connections are not left out", async () => {
  const calls = [], rows = [...rawRows, { ...stats(17, .4), id: JSON.stringify(["openai-codex", model]), name: model, provider: "openai-codex" }];
  const read = async params => {
    calls.push(Object.fromEntries(params)); const report = legacyReport(params.has("model") ? rows.filter(row => row.id === params.get("model")) : rows);
    report.facets.models = rows; return report;
  };
  const params = query(); params.set("from", "1791043200000");
  const report = await Data.readReport(read, params, { modelGrouping: undefined });
  assert.equal(report.total.tokens, 88); assert.equal(report.total.calls, 4); assert.equal(calls.length, 5); assert.equal(calls[0].from, params.get("from"));
});
test("one failed legacy component fails the Host reading instead of reporting a silent partial total", async () => {
  let calls = 0;
  await assert.rejects(Data.readReport(async params => { if (++calls === 3) throw new Error("owned_failure"); return legacyReport(params.has("model") ? rawRows.filter(row => row.id === params.get("model")) : rawRows); }, query()), /owned_failure/);
  assert.equal(calls, 3);
});
test("a model absent from a legacy Host returns an empty filtered report with real coverage", async () => {
  const params = query(); params.set("model", JSON.stringify(["minimax", "MiniMax-M3.1-Flash-Preview"]));
  const calls = [], report = await Data.readReport(legacyReader(calls), params);
  assert.equal(calls.length, 1); assert.deepEqual(report.total, Data.empty()); assert.equal(report.models.length, 0);
  assert.equal(report.coverage.covered, 7); assert.equal(report.coverage.missing, 1); assert.equal(report.issues.length, 1);
});
test("partial legacy readings preserve their worst coverage and bound distinct issue details", async () => {
  let calls = 0;
  const report = await Data.readReport(async params => {
    const result = legacyReport(params.has("model") ? rawRows.filter(row => row.id === params.get("model")) : rawRows);
    if (++calls === 3) { result.coverage.covered = 6; result.coverage.partial = 2; result.coverage.indexing = 4; result.priceUpdatedAt = 500; }
    result.issues = Array.from({ length: 30 }, (_, i) => ({ entry: "problem-" + (calls * 30 + i), status: "partial", reason: "read_failed" }));
    return result;
  }, query());
  assert.equal(report.total.tokens, 71); assert.equal(report.total.calls, 3); assert.equal(report.coverage.covered, 6); assert.equal(report.coverage.missing, 1);
  assert.equal(report.coverage.partial, 2); assert.equal(report.coverage.indexing, 4); assert.equal(report.issues.length, 100); assert.equal(report.coverage.issuesOmitted, 20);
  assert.equal(report.priceUpdatedAt, 500);
});
