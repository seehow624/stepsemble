"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareCodexContracts, USED_CLIENT_METHODS } = require("../server/codex-schema-compat");
const { loadContractBaseline } = require("../server/codex-contract-baseline");
const { registry } = require("../server/codex-compatibility");

const baseline = loadContractBaseline();
const copy = () => JSON.parse(JSON.stringify(baseline.documents));
const check = mutate => { const documents = copy(); mutate(documents); return compareCodexContracts(baseline.documents, documents); };
const reasons = result => result.breaking.map(row => row.reason);

test("the baseline is the newest reviewed Codex contract and matches its hashes", () => {
  const newest = registry().profiles.filter(profile => profile.verification === "reviewed")
    .map(profile => profile.nativeVersion)
    .sort((a, b) => a.split(".").map(Number).reduce((order, part, index) => order || part - Number(b.split(".")[index]), 0))
    .at(-1);
  // Reviewing a newer release means refreshing the baseline:
  // node scripts/codex-contract-baseline.mjs <version>
  assert.equal(baseline.nativeVersion, newest);
  assert.equal(compareCodexContracts(baseline.documents, copy()).compatible, true);
});

test("additions are accepted", () => {
  const result = check(documents => {
    documents["v2/ThreadStartParams.json"].properties.optionalNew = { type: ["string", "null"] };
    documents["ServerNotification.json"].definitions.PlanType.enum.push("brandNewPlan");
    documents["v2/ThreadReadResponse.json"].definitions.Thread.properties.alsoNew = { type: "string" };
    documents["v2/ThreadReadResponse.json"].definitions.Thread.required.push("alsoNew");
    documents["CommandExecutionRequestApprovalResponse.json"].definitions.CommandExecutionApprovalDecision.oneOf.push({ enum: ["newChoice"], type: "string" });
    const notifications = documents["ServerNotification.json"];
    notifications.oneOf.push({ type: "object", properties: { method: { enum: ["brand/new"], type: "string" } }, required: ["method"] });
    const requests = documents["ClientRequest.json"];
    requests.oneOf.push({ type: "object", properties: { method: { enum: ["brand/newRequest"], type: "string" } }, required: ["method"] });
  });
  assert.deepEqual(result.breaking, []);
  assert.equal(result.compatible, true);
});

test("a method Stepsemble does not use may change or go away", () => {
  const used = new Set(USED_CLIENT_METHODS);
  const result = check(documents => {
    const requests = documents["ClientRequest.json"];
    requests.oneOf = requests.oneOf.filter(variant => used.has(variant.properties?.method?.enum?.[0]));
  });
  assert.equal(result.compatible, true);
});

test("changes to what Stepsemble sends are refused", () => {
  assert.deepEqual(reasons(check(documents => {
    const params = documents["v2/ThreadStartParams.json"];
    params.properties.mustSend = { type: "string" };
    params.required = [...(params.required || []), "mustSend"];
  })), ["new required field"]);
  assert.deepEqual(reasons(check(documents => {
    const requests = documents["ClientRequest.json"];
    requests.oneOf = requests.oneOf.filter(variant => variant.properties?.method?.enum?.[0] !== "turn/start");
  })), ["request method removed"]);
  assert.deepEqual(reasons(check(documents => {
    const turn = documents["ClientRequest.json"].definitions.TurnStartParams;
    delete turn.properties.approvalPolicy;
  })), ["field removed"]);
  assert.deepEqual(reasons(check(documents => {
    const decision = documents["CommandExecutionRequestApprovalResponse.json"].definitions.CommandExecutionApprovalDecision;
    decision.oneOf = decision.oneOf.filter(variant => variant.enum?.[0] !== "decline");
  })), ["union member removed"]);
});

test("changes to what Stepsemble reads are refused", () => {
  assert.deepEqual(reasons(check(documents => {
    delete documents["v2/ThreadReadResponse.json"].definitions.Thread.properties.agentNickname;
  })), ["field removed"]);
  assert.deepEqual(reasons(check(documents => {
    documents["v2/TurnStartResponse.json"].definitions.Turn.properties.id.type = "integer";
  })), ["type changed"]);
  assert.deepEqual(reasons(check(documents => {
    const turn = documents["v2/TurnStartResponse.json"].definitions.Turn;
    turn.required = turn.required.filter(name => name !== "id");
  })), ["field may now be missing"]);
  assert.deepEqual(reasons(check(documents => {
    const notifications = documents["ServerNotification.json"];
    notifications.oneOf = notifications.oneOf.filter(variant => variant.properties?.method?.enum?.[0] !== "turn/completed");
  })), ["union member removed"]);
  assert.match(reasons(check(documents => {
    documents["ServerNotification.json"].definitions.PlanType.enum = documents["ServerNotification.json"].definitions.PlanType.enum.filter(value => value !== "promax");
  }))[0], /value removed/);
  assert.equal(check(documents => { delete documents["v2/ModelListResponse.json"]; }).breaking[0].reason, "file missing");
});

test("a definition renamed with the same shape and a sent shape that became a union still fit", () => {
  const base = { "x.json": { type: "object", properties: { path: { $ref: "#/definitions/OldName" }, params: { type: "null" } }, definitions: { OldName: { type: "string" } } } };
  const next = { "x.json": { type: "object", properties: { path: { $ref: "#/definitions/NewName" }, params: { anyOf: [{ $ref: "#/definitions/Extra" }, { type: "null" }] } },
    definitions: { NewName: { type: "string", description: "renamed" }, Extra: { type: "object" } } } };
  assert.equal(compareCodexContracts(base, next, { files: ["x.json"] }).compatible, false, "reading a new union is a change");
  const sent = { "v2/XParams.json": base["x.json"] }, sentNext = { "v2/XParams.json": next["x.json"] };
  assert.equal(compareCodexContracts(sent, sentNext, { files: ["v2/XParams.json"] }).compatible, true);
  const renamedOnly = JSON.parse(JSON.stringify(next["x.json"])); renamedOnly.properties.params = { type: "null" };
  assert.equal(compareCodexContracts(base, { "x.json": renamedOnly }, { files: ["x.json"] }).compatible, true);
});

test("the same values written another way still fit, shape by shape", () => {
  // Codex 0.159.0: the thread/items/list cursor, a string or null, became a
  // union of a string or an item anchor, behind a reference, or null.
  const widenCursor = (documents, members) => {
    const params = documents["v2/ThreadItemsListParams.json"];
    params.definitions.ThreadItemsListAnchor = { oneOf: [{ type: "object", properties: { type: { enum: ["item"], type: "string" }, itemId: { type: "string" } }, required: ["itemId", "type"] }] };
    params.definitions.ThreadItemsListCursor = { anyOf: members, description: "Starting position for an item-history page." };
    params.properties.cursor = { anyOf: [{ $ref: "#/definitions/ThreadItemsListCursor" }, { type: "null" }], description: "cursor or anchor" };
  };
  const string = { type: "string" }, anchor = { $ref: "#/definitions/ThreadItemsListAnchor" };
  assert.deepEqual(check(documents => widenCursor(documents, [string, anchor])).breaking, []);
  // Without the string Stepsemble sends, or without null, it no longer fits.
  assert.equal(check(documents => widenCursor(documents, [anchor])).compatible, false);
  assert.equal(check(documents => {
    widenCursor(documents, [string, anchor]);
    documents["v2/ThreadItemsListParams.json"].properties.cursor.anyOf.pop();
  }).compatible, false);
  // What Stepsemble reads: a string or null, written as a union behind a
  // reference, still fits; one that may now be an object does not.
  const readName = members => documents => {
    const response = documents["v2/ThreadReadResponse.json"];
    response.definitions.ThreadTitle = { anyOf: members };
    response.definitions.Thread.properties.name = { anyOf: [{ $ref: "#/definitions/ThreadTitle" }, { type: "null" }] };
  };
  assert.deepEqual(check(readName([string])).breaking, []);
  assert.equal(check(readName([string, { type: "object" }])).compatible, false);
});

test("a union written with anyOf instead of oneOf is the same union", () => {
  // Codex 0.161.0: CodexErrorInfo became anyOf, with an open member for error
  // kinds still to come. The documents before it wrote it with oneOf.
  const isOpen = member => JSON.stringify(member) === JSON.stringify({ type: ["string", "object"] });
  const before = copy();
  for (const file of ["ServerNotification.json", "v2/ThreadReadResponse.json"]) {
    const info = before[file].definitions.CodexErrorInfo;
    assert.ok(info.anyOf.some(isOpen), file);
    info.oneOf = info.anyOf.filter(member => !isOpen(member));
    delete info.anyOf;
  }
  assert.deepEqual(compareCodexContracts(before, copy()).breaking, []);
  // A member that went missing on the way is still a change.
  const lost = copy();
  lost["ServerNotification.json"].definitions.CodexErrorInfo.anyOf.shift();
  assert.deepEqual(reasons(compareCodexContracts(before, lost)), ["union member removed"]);
  // What Stepsemble sends: anyOf accepts everything oneOf did, not the other way.
  assert.deepEqual(check(documents => {
    const decision = documents["CommandExecutionRequestApprovalResponse.json"].definitions.CommandExecutionApprovalDecision;
    decision.anyOf = decision.oneOf; delete decision.oneOf;
  }).breaking, []);
  assert.deepEqual(reasons(check(documents => {
    const cursor = documents["v2/ThreadItemsListParams.json"].properties.cursor;
    cursor.oneOf = cursor.anyOf; delete cursor.anyOf;
  })), ["values restricted"]);
});
