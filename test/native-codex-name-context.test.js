"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const allWire = require("../protocol/native/codex/sqlite-wire"), wire = allWire.context;
const allFixture = require("../protocol/native/codex/sqlite-fixture.cjs"), fixture = allFixture.context;

test("v5 context is mandatory, exact and cannot be spliced into a v4 packet", () => {
  const old = allFixture.packet(), current = fixture.packet();
  assert.equal(wire.decode(old.header, old.payload, fixture.request()), null);
  assert.equal(allWire.decode(current.header, current.payload, fixture.request()), null);
  for (const mutate of [v => { delete v.observation.nameContext; }, v => { v.observation.nameContext = null; },
    v => { v.observation.scope = "provided_connection_selected_name_fields_only"; },
    v => { v.observation.fields = null; }, v => { v.observation.nameContext.extra = true; },
    v => { delete v.observation.nameContext.preview; }, v => { v.observation.nameContext.preview = 0; }, v => { v.observation.nameContext.preview = null; },
    v => { v.observation.nameContext.rolloutPath = null; },
    v => { v.observation.nameContext.preview = "🐾".repeat(8193); },
    v => { v.observation.nameContext.rolloutPath = "x".repeat(8193); },
    v => { v.observation.nameContext.preview = "\ud800"; }, v => { v.observation.nameContext.rolloutPath = "\udfff"; }]) {
    const b = fixture.body(); mutate(b); assert.equal(fixture.capture(b), null);
  }
});
test("context preserves raw empty, Unicode and inert untrusted path text; null context means missing row only", () => {
  for (const preview of ["", "  <img src=x>🐾\0\ufeff  ", "x".repeat(32768)]) {
    const b = fixture.body(); b.observation.nameContext = { rolloutPath: "../auth.json\0do-not-follow", preview };
    assert.deepEqual(fixture.capture(b).metadata.observation.nameContext, b.observation.nameContext);
  }
  const b = fixture.body(); b.observation.fields = null; b.observation.nameContext = null;
  assert.equal(fixture.capture(b).metadata.observation.nameContext, null);
});
test("v5 version binds preview and rollout path even when the five v4 fields are identical", () => {
  const version = b => wire.sourceVersion(fixture.capture(b), fixture.request()), a = version(fixture.body());
  for (const mutate of [v => { v.observation.nameContext.preview = " "; }, v => { v.observation.nameContext.preview = "preview"; },
    v => { v.observation.nameContext.rolloutPath = "elsewhere"; }]) {
    const b = fixture.body(); mutate(b); assert(!wire.sameSourceVersion(a, version(b)));
    const original = allFixture.body(); assert.deepEqual(b.observation.fields, original.observation.fields);
  }
  const old = allWire.sourceVersion(allFixture.capture(), allFixture.request());
  assert(!wire.sameSourceVersion(a, old)); assert(!allWire.sameSourceVersion(old, a));
  const io = fixture.body(); io.readCalls++; io.requestedReadBytes++;
  assert(wire.sameSourceVersion(a, version(io)));
});
