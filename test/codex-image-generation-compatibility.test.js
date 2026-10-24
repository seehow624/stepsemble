"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeThreadListResponse,
  normalizeThreadReadResponse,
  normalizeThreadTurnsResponse,
  normalizeThreadItemsResponse,
} = require("../server/codex-app-server-transport");
const { codexItem } = require("../public/modules/agent-transcript-presentation");
const { loadContractBaseline } = require("../server/codex-contract-baseline");
const { probeCodexCompatibility, registry } = require("../server/codex-compatibility");

// Official 0.163.0/0.164.0 ThreadItem shapes. During migration Codex also
// writes fileId together with an empty result; neither identity may be lost.
const common = { type: "imageGeneration", status: "completed", savedPath: "/owned/generated.png", revisedPrompt: "a tree" };
const items = [
  { ...common, id: "legacy-inline", result: "aW5saW5l" },
  { ...common, id: "current-inline", result: "aW5saW5l", inputImages: [] },
  { ...common, id: "current-file", fileId: "file-generated", inputImages: [{ path: "/owned/input.png", sha256: "a".repeat(64) }] },
  { ...common, id: "migration-file", fileId: "file-migration", result: "", inputImages: [] },
];

function thread(turn) {
  return { id: "thread-image", sessionId: "session-image", cliVersion: "0.164.0", modelProvider: "openai",
    preview: "image", createdAt: 1, updatedAt: 2, cwd: "/owned", ephemeral: false,
    status: { type: "idle" }, turns: [turn], name: "Image generation", source: "cli", historyMode: "legacy" };
}

test("Codex history preserves legacy result and 0.164.0 fileId image generations on every read surface", () => {
  const turn = { id: "turn-image", status: "completed", items, itemsView: "full" };
  const nativeThread = thread(turn);
  const page = { data: [turn], nextCursor: null, backwardsCursor: null };
  const entries = items.map(item => ({ turnId: turn.id, item }));
  const outputs = [
    normalizeThreadListResponse({ data: [nativeThread], nextCursor: null }).data[0].turns[0].items,
    normalizeThreadReadResponse({ thread: nativeThread }).thread.turns[0].items,
    normalizeThreadTurnsResponse(page).data[0].items,
    normalizeThreadItemsResponse({ ...page, data: entries }).data.map(entry => entry.item),
  ];
  for (const output of outputs) {
    assert.deepEqual(output, items, "result, fileId, savedPath and inputImages remain inert native data");
    assert.notEqual(output[2], items[2], "history is detached from the source");
    assert.notEqual(output[2].inputImages, items[2].inputImages);
    assert.equal(Object.hasOwn(output[2], "result"), false, "no fabricated inline image for a fileId item");
  }
});

test("Codex image-generation presentation does not interpret result, fileId or savedPath as preview authority", () => {
  for (const item of items) {
    const value = codexItem(item);
    assert.equal(value.kind, "tool");
    assert.equal(value.tool.name, "image_generation");
    assert.equal(value.tool.id, item.id);
    assert.equal(value.tool.output, "completed");
    assert.equal(value.tool.running, false);
    assert.deepEqual(value.tool.args, { path: "" });
    assert.equal(value.tool.preview, null, "generated attachments were not automatically loaded in either version");
    const preview = { url: "/api/codex/image?token=abcdefghijklmnopqrstuvwxyz012345", mimeType: "image/png", name: "generated.png" };
    assert.deepEqual(codexItem({ ...item, preview }).tool.preview, preview);
    for (const url of ["file:///owned/generated.png", "https://example.invalid/image.png", item.fileId || item.result]) {
      assert.equal(codexItem({ ...item, preview: { ...preview, url } }).tool.preview, null);
    }
  }
});

test("the reviewed 0.164.0 image contract keeps inline results as an alternative to durable file identities", () => {
  const baseline = loadContractBaseline();
  let checked = 0;
  for (const document of Object.values(baseline.documents)) {
    const image = document.definitions?.ThreadItem?.oneOf?.find(member => member.properties?.type?.enum?.[0] === "imageGeneration");
    if (!image) continue;
    checked++;
    assert.equal(Object.hasOwn(image.properties, "result"), false);
    assert.deepEqual(image.anyOf.map(member => member.required), [["fileId"], ["result"]]);
    assert.equal(image.anyOf[0].properties.fileId.type, "string");
    assert.equal(image.anyOf[1].properties.result.type, "string");
    assert.ok(image.properties.savedPath);
    assert.ok(image.properties.inputImages);
  }
  assert.equal(checked, 9, "all nine contract documents embedding ThreadItem are covered");
});

test("moving the baseline to 0.164.0 retains installed 0.163.0 as a reviewed native profile", async () => {
  const profile = registry().profiles.find(row => row.nativeVersion === "0.163.0");
  assert.ok(profile, "0.163.0 must not depend on additive comparison with the newer baseline");
  const status = await probeCodexCompatibility(process.execPath, {
    versionOutput: "codex-cli 0.163.0", schemaProbe: async () => ({ fingerprint: profile.schemaFingerprint }), cache: new Map(),
  });
  assert.equal(status.verification, "reviewed");
  assert.equal(status.capabilities.historyRead, true);
  assert.equal(status.capabilities.mutations, true);
  assert.equal(status.capabilities.approvals, true);
});
