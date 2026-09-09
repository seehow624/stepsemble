#!/usr/bin/env node
// Private local owner review. Produces a separate candidate, never activates it.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectHistoryConfigFile, prepareHistoryConfigRevision, commitHistoryConfigFile, discardHistoryConfigReview } from "./history-config.mjs";
import { createTerminalQuestions } from "./history-setup.mjs";
const copy = {
  en: {
    start: "Stepsemble · Manage native history source groups locally. Do not enter tokens or passwords. Configs and paths are private terminal output; do not share the review.",
    base: "Existing private configuration (canonical absolute path): ",
    action: "Action: list / add / replace / edit / remove (cancel to stop): ",
    id: "Exact source ID to manage (also the imported group ID for add/replace): ",
    from: "Reviewed group configuration to import from (canonical absolute path): ",
    adoptSdk: "Importing Claude into this Codex-only config requires the SDK shown below. Type ADOPT_SDK to explicitly include it; anything else cancels: ",
    output: "NEW inactive candidate configuration (absolute path; never overwrites): ",
    label: "New display label (does not rename a native session): ",
    description: "New description (may be blank): ",
    readers: "Complete replacement reader IDs, comma-separated (not tokens): ",
    review: "Review the exact change AND complete resulting configuration below. Other imported groups/catalog entries are NOT merged.",
    scope: "Claude main_sessions includes current and future main sessions. Codex stored_threads includes current and future stored rows, archived/subagent/internal/unknown origins. This is read-only history, not approval or resume.",
    sharing: "browser:master means every browser using this Host master token. peer:<grant-id> grants the incoming Host, not an individual downstream person. Reader IDs are not looked up or automatically widened.",
    activation: "This creates a NEW inactive file only. Remove/edit does NOT revoke access on the running Host. Keep the original for rollback; activation still needs owner approval, active-work checks and controlled deployment. No scans, account changes, model calls or restart.",
    confirm: "Type CREATE exactly to save this reviewed candidate; anything else cancels: ",
    done: "Candidate saved privately; NOT activated. Existing config and running Host are unchanged.",
    cancelled: "Cancelled. No candidate created; running Host unchanged.",
    invalid: "Invalid field. Correct it or type cancel (three attempts maximum).",
    failed: "Management failed. Existing configs and Hosts were not changed. If an incomplete candidate remains, inspect it locally; do not share its contents. See docs/history-owner-setup.md.",
    help: "Usage: node scripts/history-manage.mjs [--lang en|zh-Hant]\nLocal interactive TTY only. List/add/replace/edit/remove source groups via a reviewed NEW candidate; no overwrite, activation, hot reload, login or model call.",
  },
  "zh-Hant": {
    start: "Stepsemble · 在本機管理原生歷史來源群組。不要輸入 token 或密碼。設定與路徑只供本機終端核對，請勿分享核對畫面。",
    base: "既有私有設定檔（canonical 絕對路徑）：",
    action: "操作：list 檢視／add 新增／replace 替換／edit 編輯／remove 移除（cancel 取消）：",
    id: "要管理的完整來源 ID（新增／替換時亦為匯入群組 ID）：",
    from: "要匯入的已核對群組設定檔（canonical 絕對路徑）：",
    adoptSdk: "將 Claude 加入這份 Codex-only 設定需補入下方 SDK。完整輸入 ADOPT_SDK 才同意納入；其他回答取消：",
    output: "新的未啟用候選設定檔（絕對路徑；絕不覆寫）：",
    label: "新的顯示名稱（不會改動原生對話名稱）：",
    description: "新的說明（可留空）：",
    readers: "完整替換的讀者 ID，以逗號分隔（不是秘密 token）：",
    review: "請核對下方變更前後，以及完整結果。匯入檔的其他群組／手動來源不會合併。",
    scope: "Claude main_sessions 包含目前與未來主對話。Codex stored_threads 包含目前與未來儲存的 rows，含封存、subagent、internal 與未知來源。這是唯讀歷史，不是 approval 或 resume。",
    sharing: "browser:master 是使用這台 Host 主 token 的所有瀏覽器。peer:<grant-id> 授權 incoming Host，不是其下游的某個人。此流程不查讀者 ID 是否存在，也不自動擴大權限。",
    activation: "只會建立新的未啟用檔案。移除／編輯不會撤銷執行中 Host 的讀取權。請保留原檔供回滾；啟用仍須 owner 確認、active-work 檢查與受控部署。不掃描、不更動帳號、不呼叫模型或重啟。",
    confirm: "完整輸入 CREATE 才儲存這份已核對候選；其他回答一律取消：",
    done: "候選已私有儲存，尚未啟用。原設定與執行中的 Host 都沒有變更。",
    cancelled: "已取消，沒有建立候選，執行中的 Host 不變。",
    invalid: "欄位格式不正確，請修正或輸入 cancel（最多三次）。",
    failed: "管理未完成，原設定與 Host 都未修改。若殘留不完整候選，請只在本機檢查，不要分享內容。詳見 docs/history-owner-setup.md。",
    help: "用法：node scripts/history-manage.mjs [--lang en|zh-Hant]\n只供本機互動終端。檢視／新增／替換／編輯／移除來源群組，核對後建立新的候選檔；不覆寫、不啟用、不熱載入、不登入或呼叫模型。",
  },
};
const safeInput = value => typeof value === "string" && value.length <= 4096
  && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
const canonicalPath = value => path.isAbsolute(value) && path.resolve(value) === value
  && value !== path.parse(value).root && !/[*?\[\]{},]/.test(value);
// Existing files may contain directional/control characters not accepted by
// this prompt. Show them as literal escapes, never terminal instructions.
export const historyReviewJSON = value => JSON.stringify(value, null, 2)
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
export async function manageHistory({ language = "en", ask, write } = {}) {
  if (!Object.hasOwn(copy, language)) throw new Error("history_management_language_invalid");
  if (typeof ask !== "function" || typeof write !== "function") throw new Error("history_management_io_invalid");
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  const text = copy[language], cancelled = () => { write(text.cancelled); return { created: false, sourceReads: 0, hostRestarted: false }; };
  async function field(key, valid) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await ask(text[key]);
      if (answer === null || answer === "cancel") return null;
      if (!safeInput(answer)) throw new Error("history_management_input_invalid");
      if (valid(answer)) return answer;
      write(text.invalid);
    }
    throw new Error("history_management_input_invalid");
  }
  write(text.start);
  const base = await field("base", canonicalPath); if (base === null) return cancelled();
  const inspected = inspectHistoryConfigFile(base); write(historyReviewJSON(inspected));
  const action = await field("action", value => ["list", "add", "replace", "edit", "remove"].includes(value));
  if (action === null) return cancelled();
  if (action === "list") return { created: false, inspected: true, sourceGroups: inspected.config.sourceGroups?.length ?? 0, sourceReads: 0, hostRestarted: false };
  const id = await field("id", value => /^[A-Za-z0-9:_-]{1,128}$/.test(value)); if (id === null) return cancelled();
  const operation = { action, sourceId: id };
  if (["add", "replace"].includes(action)) {
    operation.from = await field("from", canonicalPath); if (operation.from === null) return cancelled();
    const imported = inspectHistoryConfigFile(operation.from);
    const group = imported.config.sourceGroups?.find(row => row.sourceId === id);
    if (inspected.config.reader?.sdkPath === null && group?.agentId === "claude-code" && imported.config.reader?.sdkPath) {
      write(historyReviewJSON({ previousReader: inspected.config.reader, proposedSdk: imported.config.reader.sdkPath }));
      if (await ask(text.adoptSdk) !== "ADOPT_SDK") return cancelled();
      operation.adoptSdk = true;
    }
  } else if (action === "edit") {
    for (const key of ["label", "description", "readers"]) {
      const value = await field(key, answer => key === "readers" ? answer.length > 0 : answer.length <= (key === "label" ? 120 : 300) && (key !== "label" || answer.length > 0));
      if (value === null) return cancelled();
      operation[key] = key === "readers" ? value.split(",").map(row => row.trim()) : value;
    }
  }
  const output = await field("output", canonicalPath); if (output === null) return cancelled();
  const prepared = prepareHistoryConfigRevision(base, output, operation);
  try {
    write(text.review); write(historyReviewJSON(prepared)); write(text.scope); write(text.sharing); write(text.activation);
    if (await ask(text.confirm) !== "CREATE") return cancelled();
    const result = commitHistoryConfigFile(prepared); write(text.done); return { created: true, ...result };
  } finally { discardHistoryConfigReview(prepared); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let language = "en", terminal, interrupt;
  try {
    const args = process.argv.slice(2), help = args.includes("--help"), flags = args.filter(value => value !== "--help");
    if (args.filter(value => value === "--help").length > 1 || !(flags.length === 0
      || flags.length === 2 && flags[0] === "--lang" && Object.hasOwn(copy, flags[1]))) throw new Error("history_management_options_invalid");
    if (flags.length) language = flags[1];
    if (help) process.stdout.write(copy[language].help + "\n");
    else {
      terminal = createTerminalQuestions(process.stdin, process.stderr);
      interrupt = () => { terminal.close(); process.exitCode = 130; }; process.once("SIGINT", interrupt);
      const result = await manageHistory({ language, ask: terminal.ask, write: line => process.stderr.write(line + "\n") });
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch (error) {
    process.stderr.write(copy[language].failed + "\n" + (String(error?.message).match(/^history_[a-z_:]+$/)?.[0] ?? "history_management_failed") + "\n");
    process.exitCode = 1;
  } finally { terminal?.close(); if (interrupt) process.off("SIGINT", interrupt); }
}
