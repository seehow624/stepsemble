import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRequestBarrier } from "../scripts/browser-request-barrier.mjs";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("rendered loading does not settle a request barrier until actual observation", async () => {
  const barrier = createBrowserRequestBarrier();
  let settled = false;
  const pending = barrier.wait().then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  barrier.observe(); await pending; assert.equal(settled, true);
});
test("request observed before waiting is retained without assuming route event ordering", async () => {
  const barrier = createBrowserRequestBarrier();
  barrier.observe(); barrier.observe(); await barrier.wait(); await barrier.wait();
});
test("missing actual request is a bounded failure, never a successful zero-request case", async () => {
  await assert.rejects(createBrowserRequestBarrier(20).wait(), /browser_request_not_observed/);
});
test("request wait remains bounded and rejects invalid timeout configuration", () => {
  for (const value of [0, -1, 15001, Infinity, NaN, 0.1, "20"]) {
    assert.throws(() => createBrowserRequestBarrier(value), /invalid_request_barrier_timeout/);
  }
});
