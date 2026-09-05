#!/usr/bin/env node
// Explicit development-only capture. Tests replay the frozen JSON; they never
// update it to hide a changed result. Review the complete diff after --write.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const value = await require("../test-support/transaction-scenario.cjs").capture();
const output = JSON.stringify(value, null, 2) + "\n";
const target = path.join(root, "protocol/v1/fixtures/transactions.json");
const flags = process.argv.slice(2);
if (flags.length !== 1 || !["--write", "--check"].includes(flags[0])) throw new Error("Choose --write (review changes) or --check");
if (flags[0] === "--write") await fs.writeFile(target, output);
else if ((await fs.readFile(target, "utf8")).replace(/\r\n/g, "\n") !== output) throw new Error("Transaction fixture differs; inspect before recapturing");
console.log(`Synthetic transaction reference: ${value.steps.length} frozen steps (${flags[0]}).`);
