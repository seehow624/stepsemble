#!/usr/bin/env node
// A local stand-in for the Gemini API, so a real agy can be driven through a
// whole turn (a tool call included) with no account, no network and no cost.
// agy reaches it through a custom model in its settings
// (modelProvider "gemini", apiProvider API_PROVIDER_GOOGLE_GEMINI) and
// GOOGLE_GEMINI_BASE_URL. Used by scripts/check-native-antigravity-release.mjs.
//   node fake-gemini-api.mjs <log.jsonl>   -> prints "listening <port>" once ready
// A user message containing [[run:<command>]] gets a run_command call back;
// [[write:<path>]] a write_file call; a picture the message names (as
// Stepsemble attaches one) a read_file call. After a tool result, or
// otherwise, it answers in text. Each model request is logged: the model
// named in the URL, its thinking settings, whether it carried a tool result
// or a picture, the user text.
import http from "node:http";
import fs from "node:fs";

const [logFile] = process.argv.slice(2);
const log = value => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(value) + "\n"); };
const reply = (res, parts) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end("data: " + JSON.stringify({ candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts } }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 8, totalTokenCount: 1208 } }) + "\r\n\r\n");
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", chunk => { if (raw.length < 32 * 1024 * 1024) raw += chunk; });
  req.on("end", () => {
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ models: [] })); return; }
    if (!/generatecontent/i.test(req.url || "")) { res.writeHead(404); res.end("{}"); return; }
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    const contents = Array.isArray(body?.contents) ? body.contents : [];
    const last = contents[contents.length - 1] || {};
    const answeredTool = (last.parts || []).some(part => part.functionResponse);
    // The person's latest message (agy wraps it in <USER_REQUEST>); agy may
    // add a system message of its own after it, as when a mode changes.
    const textOf = item => (item?.parts || []).filter(part => typeof part.text === "string").map(part => part.text).join("\n");
    let userText = textOf(last);
    for (let index = contents.length - 1; index >= 0 && !answeredTool; index -= 1) {
      if ((contents[index]?.parts || []).some(part => part.functionCall || part.functionResponse)) break;
      if (contents[index]?.role === "user" && textOf(contents[index]).includes("<USER_REQUEST>")) { userText = textOf(contents[index]); break; }
    }
    const tools = (body?.tools || []).flatMap(tool => (tool.functionDeclarations || []).map(fn => fn.name));
    log({ model: (/models\/(.+?):/.exec(req.url || "") || [])[1] || null, thinking: body?.generationConfig?.thinkingConfig || null,
      answeredTool, tools: tools.length, toolNames: tools.slice(0, 40), userText: userText.slice(0, 4000), history: JSON.stringify(contents).length,
      recentText: contents.slice(-4).flatMap(item => item?.parts || []).filter(part => typeof part.text === "string").map(part => part.text).join("\n").slice(-8000),
      picture: (last.parts || []).some(part => part.inlineData || part.inline_data) || JSON.stringify(last).includes("inlineData") });
    const run = /\[\[run:([^\]]+)\]\]/.exec(userText), write = /\[\[write:([^\]]+)\]\]/.exec(userText);
    const picture = /attached a picture: (\/\S+?\.(?:png|jpe?g|gif|webp))\b/.exec(userText);
    if (!answeredTool && tools.includes("read_file") && picture) {
      reply(res, [{ functionCall: { name: "read_file", args: { Path: picture[1] } } }]); return;
    }
    if (!answeredTool && tools.includes("run_command") && run) {
      reply(res, [{ functionCall: { name: "run_command", args: { CommandLine: run[1], WaitMsBeforeAsync: 3000, toolSummary: "probe" } } }]); return;
    }
    if (!answeredTool && tools.includes("write_file") && write) {
      reply(res, [{ functionCall: { name: "write_file", args: { Path: write[1], Content: "written by the probe\n" } } }]); return;
    }
    reply(res, [{ text: answeredTool ? "probe finished" : "probe answer" }]);
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(`listening ${server.address().port}\n`); });
