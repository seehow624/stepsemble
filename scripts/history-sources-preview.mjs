#!/usr/bin/env node
// Explicit owned-fixture browser check. No real histories/accounts or model calls.
import readline from "node:readline";
import { withDownloadedSdk } from "./check-native-claude-history.mjs";
import { startSyntheticHistoryHost } from "./history-host-synthetic.mjs";
await withDownloadedSdk(async sdkPath => {
  const host = await startSyntheticHistoryHost({ helperPath: process.argv[2], sdkPath, sourceGroups: true, extraSessions: 60 });
  console.log(JSON.stringify({ origin: host.origin, syntheticSignInToken: host.token, modelCalls: 0, privateHistoryReads: 0 }));
  const input = readline.createInterface({ input: process.stdin });
  await new Promise((resolve, reject) => {
    let ended = false;
    const close = async () => {
      if (ended) return; ended = true; input.close();
      try { console.log(JSON.stringify(await host.close())); resolve(); } catch (error) { reject(error); }
    };
    input.on("line", line => { void (async () => {
      if (line === "close") await close();
      else if (line.startsWith("change ")) { await host.changeFixture(line.slice(7), "重新命名的合成對話 🐾"); console.log("owned_title_changed"); }
      else if (line.startsWith("remove ")) { await host.setFixturePresent(line.slice(7), false); console.log("owned_source_removed"); }
    })().catch(() => { process.exitCode = 1; void close(); }); });
    input.on("close", () => { void close(); }); process.once("SIGTERM", () => { void close(); }); process.once("SIGINT", () => { void close(); });
  });
});
