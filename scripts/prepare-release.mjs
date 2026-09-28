#!/usr/bin/env node
// Prepares a release in the working tree: the version in every file that
// carries it, the rolling-compatibility pins moved to the two latest shipped
// tags, and the CHANGELOG section. Committing, tagging and pushing stay
// separate steps.
//   node scripts/prepare-release.mjs <version> --notes <file>
// The notes file holds the section's bullet points; it may be left out when
// the CHANGELOG already has a section for the version.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const version = args[0];
const notesIndex = args.indexOf("--notes");
const notesFile = notesIndex > 0 ? args[notesIndex + 1] : null;
const usage = () => { console.error("Usage: node scripts/prepare-release.mjs <x.y.z> [--notes <file>]"); process.exit(1); };
if (!/^\d+\.\d+\.\d+$/.test(String(version)) || notesIndex > 0 && !notesFile || args.length !== (notesIndex > 0 ? 3 : 1)) usage();
const parts = value => value.split(".").map(Number);
const newer = (a, b) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();

const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (pkg.version !== version && !newer(version, pkg.version)) throw new Error(version + " is not newer than " + pkg.version);

// The CHANGELOG section first: nothing is changed without one.
const changelogFile = path.join(root, "CHANGELOG.md");
let changelog = await fs.readFile(changelogFile, "utf8");
const heading = "\n## " + version + "\n";
if (!changelog.includes(heading)) {
  if (!notesFile) throw new Error("CHANGELOG has no section for " + version + "; pass --notes <file>");
  const notes = (await fs.readFile(notesFile, "utf8")).trim();
  if (!/^- /m.test(notes)) throw new Error("the notes must be bullet points");
  const head = "# Changelog\n\n";
  if (!changelog.startsWith(head)) throw new Error("unexpected CHANGELOG start");
  changelog = head + "## " + version + "\n\n" + notes + "\n\n" + changelog.slice(head.length);
}

// The two latest shipped releases before this one.
const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n")
  .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag) && newer(version, tag.slice(1))).slice(0, 2);
if (tags.length !== 2) throw new Error("two earlier release tags are required");
const pins = tags.map(tag => ({ tag, commit: git("rev-list", "-n", "1", tag), version: tag.slice(1) }));
const releasesFile = path.join(root, "protocol", "rolling-releases.json");
const releases = JSON.parse(await fs.readFile(releasesFile, "utf8"));
const releasesText = "{\n  \"purpose\": " + JSON.stringify(releases.purpose) + ",\n  \"releases\": [\n"
  + pins.map(pin => "    " + JSON.stringify(pin).replace(/^\{/, "{ ").replace(/\}$/, " }").replace(/","/g, "\", \"").replace(/":"/g, "\": \"")).join(",\n")
  + "\n  ]\n}\n";
const compatibilityFile = path.join(root, "protocol", "rolling-compatibility.md");
const compatibility = await fs.readFile(compatibilityFile, "utf8");
const pattern = /these are v\d+\.\d+\.\d+\nand v\d+\.\d+\.\d+, the latest two \*\*shipped\*\* versions before \d+\.\d+\.\d+\./;
if (!pattern.test(compatibility)) throw new Error("rolling-compatibility.md: pin sentence not found");

execFileSync(process.execPath, [path.join(root, "scripts", "version.mjs"), "set", version], { cwd: root, stdio: "inherit" });
await fs.writeFile(changelogFile, changelog);
await fs.writeFile(releasesFile, releasesText);
await fs.writeFile(compatibilityFile, compatibility.replace(pattern,
  "these are " + pins[0].tag + "\nand " + pins[1].tag + ", the latest two **shipped** versions before " + version + "."));
console.log(JSON.stringify({ version, pins: pins.map(pin => pin.tag + " " + pin.commit.slice(0, 7)) }));
