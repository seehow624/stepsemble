"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOpenCodeConfigService } = require("../server/opencode-config-service");

test("OpenCode provider config service writes, lists, and removes opencode.json providers", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-opencode-config-"));
  try {
    const service = createOpenCodeConfigService({ home: temp });
    const initial = service.list();
    assert.equal(initial.providers.length, 0);

    service.upsert({
      id: "custom-llama",
      name: "My Llama Server",
      baseURL: "https://api.example.com/v1/",
      apiKey: "sk-test",
      models: [
        { id: "glm-5.3", name: "GLM 5.3", reasoning: true, contextWindow: 200000, outputLimit: 32000 },
        { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
      ],
    });
    const afterSave = service.list();
    assert.equal(afterSave.providers.length, 1);
    const provider = afterSave.providers[0];
    assert.equal(provider.id, "custom-llama");
    assert.equal(provider.name, "My Llama Server");
    assert.equal(provider.baseURL, "https://api.example.com/v1");
    assert.equal(provider.hasApiKey, true);
    assert.deepEqual(provider.models.map(model => model.id), ["glm-5.3", "glm-5.3-flash"]);

    const onDisk = JSON.parse(fs.readFileSync(path.join(temp, ".config/opencode/opencode.json"), "utf8"));
    const saved = onDisk.provider["custom-llama"];
    assert.equal(saved.npm, "@ai-sdk/openai-compatible");
    assert.equal(saved.options.baseURL, "https://api.example.com/v1");
    assert.equal(saved.models["glm-5.3"].reasoning, true);
    assert.equal(saved.models["glm-5.3"].limit.context, 200000);
    assert.equal(saved.models["glm-5.3"].limit.output, 32000);

    service.remove("custom-llama");
    assert.equal(service.list().providers.length, 0);
    assert.equal(fs.readFileSync(path.join(temp, ".config/opencode/opencode.json"), "utf8").trim().length > 0, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("OpenCode provider edits validate ids, urls, and model counts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-opencode-config-"));
  try {
    const service = createOpenCodeConfigService({ home: temp });
    assert.throws(() => service.upsert({ id: "bad id!", baseURL: "https://x.test/v1", models: [{ id: "a" }] }));
    assert.throws(() => service.upsert({ id: "ok", baseURL: "ftp://x.test", models: [{ id: "a" }] }));
    assert.throws(() => service.upsert({ id: "ok", baseURL: "https://x.test/v1", models: [] }));
    assert.throws(() => service.remove("missing"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});
