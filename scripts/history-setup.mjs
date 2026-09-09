#!/usr/bin/env node
// Local operator wizard. No HTTP write route, HOME discovery, artifact execution,
// credential reads, dependency downloads or service restart.
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import http from "../server/history-http.js";
import { prepareHistoryConfigFile, commitHistoryConfigFile, discardHistoryConfigReview } from "./history-config.mjs";
const copy = {
  en: {
    codexStart: "Stepsemble · Set up read-only Codex 0.153.4 history\nRun this on the source Host. No automatic HOME selection, credential reading, native client launch or model use. Do not enter tokens or passwords.\n",
    codexRoot: "Codex rollout/index root you explicitly want to share (absolute canonical path): ",
    sqliteRoot: "Codex state SQLite root you explicitly want to share (absolute canonical path; may be the same reviewed root): ",
    codexScope: "Scope: stored_threads. Shares stored rows, including archived, subagent, internal and unknown sources, with the selected readers. Rollout paths must independently fit the approved Codex root. Source records are not the complete native conversation view; native paginated history and large compressed rollouts remain unsupported. Both current and future stored rows are in scope after explicit refresh. No Claude SDK is required.",
    start: "Stepsemble · Set up read-only Claude history\nRun this on the source Host. Paths and reader IDs stay in this terminal. Never enter tokens or passwords. No source is selected automatically.\n",
    filename: "New private config file (absolute path; existing files are never overwritten): ",
    origin: "Exact Stepsemble browser origin, including scheme and optional port: ",
    helper: "Trusted Rust reader executable (absolute path): ", sdk: "Pinned Claude SDK sdk.mjs (absolute path): ",
    root: "Claude projects root you explicitly want to share (absolute canonical path): ",
    id: "Source ID (letters/digits/:/_/-; up to 128): ", label: "Source label (up to 120 characters): ",
    readers: "Reader IDs, comma separated (browser:master, browser:<token-id> or peer:<grant-id>; not secret tokens): ",
    review: "Review before creating the file. These are the exact values that will be saved:",
    scope: "Scope: main_sessions. Selected readers may read current AND future main conversations under this root after an explicit refresh. This is not one project/session; subagents, attachments and other agents are excluded.",
    master: "browser:master means EVERY browser holding this Host's master token, not just this computer or tab.",
    peer: "A peer:<grant-id> shares with that incoming Host grant, not one named person on its downstream browser.",
    limits: "Only config/artifact/root metadata was checked. Reader IDs were not looked up. No transcript, credentials or model were read. Native source ACL/mount checks and real readback are still required. Trusted paths/ancestors remain your responsibility; this is not an OS sandbox.",
    confirm: "Type exactly CREATE to save this new config; anything else cancels: ",
    cancelled: "Cancelled. No configuration was created; accounts and running Hosts are unchanged.",
    done: "Config created with private permissions. NOT activated or read-verified. Before controlled activation, confirm source/readers, active work, backup and rollback. Do not restart a busy Host. See docs/history-host-integration.md.",
    failed: "Setup did not complete. Check the named field, absolute canonical paths, existing output, private parent permissions and trusted reader/SDK. A changed review must be started again. No source/account/service changes were requested. An incomplete output requires local inspection; never share its contents in chat or logs.",
    invalid: "That field is not ready. Use the exact format shown; paths must already exist and be canonical (no ~ or symlink). The output must be NEW in a private directory; artifacts must be trusted files. Please correct this field or type cancel.",
    help: "Usage: node scripts/history-setup.mjs [--lang en|zh-Hant] [--agent claude-code|codex]\nInteractive local terminal only. Creates one NEW private source-group config after explicit review (default: Claude main_sessions). Codex requires two explicit roots. Does not install, scan, activate, merge or overwrite. Non-interactive commands: scripts/history-config.mjs create, create-group, create-codex-group, check.",
  },
  "zh-Hant": {
    codexStart: "Stepsemble · 設定 Codex 0.153.4 唯讀歷史\n請在來源主機執行。不自動選取 HOME、不讀取憑證、不啟動原生客戶端或呼叫模型；不要輸入 token 或密碼。\n",
    codexRoot: "你明確要分享的 Codex rollout/index 根目錄（canonical 絕對路徑）：",
    sqliteRoot: "你明確要分享的 Codex state SQLite 根目錄（canonical 絕對路徑；可與前者相同，但須核對）：",
    codexScope: "範圍：stored_threads。向選定讀者分享已儲存的 rows，包括封存、subagent、internal 與未知來源。rollout 路徑仍須另外符合已核准的 Codex root。來源紀錄不是完整原生對話視圖；原生 paginated 歷史與大型壓縮 rollout 尚未支援。明確重新整理後，目前與未來新增的 rows 都在範圍內。不需要 Claude SDK。",
    start: "Stepsemble · 設定 Claude 唯讀歷史\n請在來源主機執行。路徑與讀者 ID 只顯示於此終端機；不要輸入 token 或密碼，不會自動選取來源。\n",
    filename: "新的私有設定檔（絕對路徑；絕不覆寫既有檔案）：",
    origin: "Stepsemble 瀏覽器的完整 origin（含 http/https 及必要的 port）：",
    helper: "受信任的 Rust reader 執行檔（絕對路徑）：", sdk: "固定版本 Claude SDK 的 sdk.mjs（絕對路徑）：",
    root: "你明確要分享的 Claude projects 根目錄（canonical 絕對路徑）：",
    id: "來源 ID（英文、數字、:、_、-，最多 128 字）：", label: "來源顯示名稱（最多 120 字）：",
    readers: "讀者 ID，以逗號分隔（browser:master、browser:<token-id> 或 peer:<grant-id>；不是秘密 token）：",
    review: "建立前請核對。以下正是將儲存的設定：",
    scope: "範圍：main_sessions。選定讀者在明確重新整理後，可讀取此根目錄下目前及未來的主對話；不是只分享某個專案／單一 session。不包含 subagent、附件或其他 Agent。",
    master: "browser:master 代表持有這台 Host 主 token 的所有瀏覽器，不是只限目前電腦或分頁。",
    peer: "peer:<grant-id> 是分享給該 incoming Host grant，不是限定下游瀏覽器的某一個人。",
    limits: "目前只檢查設定／artifact／root metadata，未查驗讀者 ID 是否存在。沒有讀取歷史、憑證或呼叫模型；來源 ACL／掛載規則及實際讀回仍須驗證。路徑與上層目錄須由你信任管理，這不是 OS sandbox。",
    confirm: "完整輸入 CREATE 才建立新設定；其他輸入一律取消：",
    cancelled: "已取消。沒有建立設定，帳號與執行中的主機都不變。",
    done: "已用私有權限建立設定，但尚未啟用、也未驗證實際讀取。受控啟用前仍須確認來源／讀者、執行中的工作、備份及回滾；不要重啟忙碌的 Host。請參考 docs/history-host-integration.md。",
    failed: "設定尚未完成。請檢查提示欄位、canonical 絕對路徑、既有輸出、父目錄私有權限與可信 reader／SDK。核對後若資料改變，需重新執行。未要求修改来源、帳號或服務；若有不完整輸出，請在本機檢查，不要把內容貼到聊天或日誌。",
    invalid: "此欄位尚未通過檢查。請用提示格式；路徑須已存在且為 canonical（不含 ~ 或 symlink）。輸出須是私有目錄中的新檔，artifact 須是可信檔案。請修正此欄位，或輸入 cancel 取消。",
    help: "用法：node scripts/history-setup.mjs [--lang en|zh-Hant] [--agent claude-code|codex]\n僅限本機互動終端機；明確核對後才建立一個新的私有來源群組設定（預設 Claude main_sessions）。Codex 須明確指定兩個根目錄。不安裝、掃描、啟用、合併或覆寫。非互動指令：scripts/history-config.mjs create、create-group、create-codex-group、check。",
  },
};
const safeInput = value => typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
function readyField(key, value) {
  try {
    if (key === "origin") return http.configuredOrigin(value);
    if (key === "id") return /^[A-Za-z0-9:_-]{1,128}$/.test(value);
    if (key === "label") return value.length > 0 && value.length <= 120;
    if (key === "readers") {
      const readers = value.split(",").map(row => row.trim());
      return readers.length <= 149 && new Set(readers).size === readers.length
        && readers.every(row => /^(browser:(master|[a-f0-9]{8,32})|peer:[a-f0-9]{32})$/.test(row));
    }
    if (!path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root || /[*?\[\]{},]/.test(value)) return false;
    const target = key === "filename" ? path.dirname(value) : value;
    if (fs.realpathSync(target) !== target) return false;
    const stat = fs.lstatSync(target);
    if (["root", "codexRoot", "sqliteRoot"].includes(key)) return stat.isDirectory(); // Source fd ACL/mount gate is deliberately separate.
    if (key === "filename") {
      if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o077)) return false;
      try { fs.lstatSync(value); return false; } catch (error) { return error.code === "ENOENT"; }
    }
    if (!stat.isFile() || stat.uid !== process.geteuid() || stat.nlink !== 1 || (stat.mode & 0o022)) return false;
    if (key === "sdk" && path.basename(value) !== "sdk.mjs") return false;
    fs.accessSync(value, fs.constants.R_OK | (key === "helper" ? fs.constants.X_OK : 0)); return true;
  } catch { return false; }
}
export async function setupHistory({ language = "en", agent = "claude-code", ask, write } = {}) {
  const text = Object.hasOwn(copy, language) ? copy[language] : null; if (!text) throw new Error("history_setup_language_invalid");
  if (typeof ask !== "function" || typeof write !== "function") throw new Error("history_setup_io_invalid");
  if (!["claude-code", "codex"].includes(agent)) throw new Error("history_setup_agent_invalid");
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  const codex = agent === "codex";
  write(codex ? text.codexStart : text.start); const values = {};
  for (const key of ["filename", "origin", "helper", ...(codex ? ["codexRoot", "sqliteRoot"] : ["sdk", "root"]), "id", "label", "readers"]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await ask(text[key]);
      if (answer === null || answer === "cancel") { write(text.cancelled); return { created: false, sourceReads: 0, hostRestarted: false }; }
      if (!safeInput(answer)) throw new Error(`history_setup_input_invalid:${key}`);
      if (readyField(key, answer)) { values[key] = answer; break; }
      write(text.invalid);
    }
    if (!values[key]) throw new Error(`history_setup_input_invalid:${key}`);
  }
  const prepared = prepareHistoryConfigFile(values.filename, { origin: values.origin, helper: values.helper,
    "source-id": values.id, label: values.label, reader: values.readers,
    ...(codex ? { "codex-root": values.codexRoot, "sqlite-root": values.sqliteRoot, scope: "stored_threads" }
      : { sdk: values.sdk, "projects-root": values.root, scope: "main_sessions" }) }, codex ? "codex-group" : "group");
  try {
    write(text.review); write(JSON.stringify(prepared, null, 2)); write(codex ? text.codexScope : text.scope);
    const readers = prepared.config.sourceGroups[0].readers;
    if (readers.includes("browser:master")) write(text.master);
    if (readers.some(reader => reader.startsWith("peer:"))) write(text.peer);
    write(text.limits);
    if (await ask(text.confirm) !== "CREATE") { write(text.cancelled); return { created: false, sourceReads: 0, hostRestarted: false }; }
    const result = commitHistoryConfigFile(prepared); write(text.done); return { created: true, ...result };
  } finally { discardHistoryConfigReview(prepared); }
}

// Cooked TTY input retains the terminal's native line editing. Bound every
// answer BEFORE decoding; do not retain an unbounded readline/pasted-line queue.
export function createTerminalQuestions(input, output) {
  if (!input.isTTY || !output.isTTY || input.isRaw) throw new Error("history_setup_terminal_required");
  let pending = null, chunks = [], bytes = 0, closed = false;
  const close = error => {
    if (closed) return; closed = true;
    input.pause(); input.off("data", data); input.off("end", end); input.off("close", end); input.off("error", failed);
    chunks = []; bytes = 0;
    const current = pending; pending = null; if (error) current?.reject(error); else current?.resolve(null);
  };
  const end = () => close(), failed = () => close(new Error("history_setup_input_closed"));
  const data = chunk => {
    if (!pending) return close(new Error("history_setup_input_unexpected"));
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += part.length;
    if (bytes > 8192) return close(new Error("history_setup_input_limit"));
    chunks.push(part); const buffer = Buffer.concat(chunks), line = buffer.indexOf(10);
    if (line < 0) return;
    if (line !== buffer.length - 1) return close(new Error("history_setup_input_multiple_lines"));
    let value; try { value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, buffer[line - 1] === 13 ? line - 1 : line)); }
    catch { return close(new Error("history_setup_input_invalid")); }
    chunks = []; bytes = 0; input.pause(); const current = pending; pending = null; current.resolve(value);
  };
  input.on("data", data); input.once("end", end); input.once("close", end); input.once("error", failed); input.pause();
  return { ask(prompt) {
    if (closed) return Promise.resolve(null);
    if (pending) return Promise.reject(new Error("history_setup_question_pending"));
    return new Promise((resolve, reject) => { pending = { resolve, reject }; output.write(prompt); input.resume(); });
  }, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let language = "en", agent = "claude-code", terminal, interrupt;
  try {
    const flags = args.filter(value => value !== "--help");
    if (args.filter(value => value === "--help").length > 1) throw new Error("history_setup_language_invalid");
    if (flags.length % 2 || flags.length > 4) throw new Error("history_setup_options_invalid");
    const used = new Set();
    for (let i = 0; i < flags.length; i += 2) {
      if (used.has(flags[i])) throw new Error("history_setup_options_invalid"); used.add(flags[i]);
      if (flags[i] === "--lang" && Object.hasOwn(copy, flags[i + 1])) language = flags[i + 1];
      else if (flags[i] === "--agent" && ["claude-code", "codex"].includes(flags[i + 1])) agent = flags[i + 1];
      else throw new Error("history_setup_options_invalid");
    }
    if (args.includes("--help")) process.stdout.write(copy[language].help + "\n");
    else {
      terminal = createTerminalQuestions(process.stdin, process.stderr);
      interrupt = () => { terminal.close(); process.exitCode = 130; }; process.once("SIGINT", interrupt);
      const result = await setupHistory({ language, agent, ask: terminal.ask, write: line => process.stderr.write(line + "\n") });
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch (error) {
    process.stderr.write(`${copy[language].failed}\n${String(error?.message).match(/^history_[a-z_:]+$/)?.[0] ?? "history_setup_failed"}\n`);
    process.exitCode = 1;
  } finally { terminal?.close(); if (interrupt) process.off("SIGINT", interrupt); }
}
