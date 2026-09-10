"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { openSessionJournal } = require("./session-journal");
const methods = new Set(["create", "setGrant", "execute", "read", "eventsAfter", "close"]);
let store;
try { store = openSessionJournal({ filename: workerData.filename }); parentPort.postMessage({ ready: true }); }
catch { parentPort.postMessage({ ready: false }); parentPort.close(); }
if (store) {
  let pending = Promise.resolve();
  parentPort.on("message", message => {
    pending = pending.then(async () => {
      if (!message || !Number.isSafeInteger(message.id) || !methods.has(message.method) || !Array.isArray(message.args)) return;
      try {
        const result = await store[message.method](...message.args);
        parentPort.postMessage({ id: message.id, result: result ?? { kind: "closed" } });
      } catch { parentPort.postMessage({ id: message.id, result: { kind: "reject", code: "journal_failed" } }); }
      if (message.method === "close") parentPort.close();
    });
  });
}
