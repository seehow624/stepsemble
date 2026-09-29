// A localhost fake of the Anthropic Messages API for release checks of agents
// that can be pointed at it (Claude Code, Grok Build, Pi). It records every
// request and answers by marker in the person's last message:
//   "Reply with exactly: X"  answers X
//   USAGE-TEST               reports input 2, cache read 5000, cache write 100, output 777
//   SLOW-n                   streams n words 15 ms apart (for Stop)
//   TOOL-SLEEP               calls Bash with a 36-second command (Claude Code)
//   TOOL-ECHO                calls the agent's own shell tool with "echo tool-ok"
//   TOOL-WRITE               calls it with a command that writes a file, which
//                            an agent asks permission for
// After a tool's result it answers "command-finished". System messages an
// agent inserts in the conversation are skipped.
import http from "node:http";
import crypto from "node:crypto";

const text = content => typeof content === "string" ? [content] : (Array.isArray(content) ? content : []).filter(part => part?.type === "text").map(part => part.text || "");
export const userTexts = body => (Array.isArray(body.messages) ? body.messages : []).filter(message => message.role === "user").flatMap(message => text(message.content));
const conversation = body => (Array.isArray(body.messages) ? body.messages : []).filter(message => message.role !== "system");
const lastUserText = body => {
  const messages = conversation(body);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    const value = text(messages[index].content).join("\n");
    if (value.trim()) return value;
  }
  return "";
};
const toolResultOf = message => Array.isArray(message?.content) ? message.content.find(part => part?.type === "tool_result") || null : null;
const hasImage = body => conversation(body).some(message => Array.isArray(message.content) && message.content.some(part => part?.type === "image"));
export const marker = value => (/Reply with exactly:\s*([A-Za-z0-9-]+)/.exec(value) || [])[1] || null;

// The agent's own shell tool, found from the tools it offers.
function shellTool(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const props = tool => tool?.input_schema?.properties || tool?.parameters?.properties || {};
  return tools.find(tool => /^(bash|shell|run_terminal_cmd|terminal|run_command|execute_command)$/i.test(tool?.name) && props(tool).command)
    || tools.find(tool => /bash|shell|terminal|command/i.test(tool?.name) && props(tool).command) || null;
}
// The call's input, with any other field the tool requires filled in.
function shellInput(tool, command) {
  const schema = tool?.input_schema || tool?.parameters || {};
  const input = { command };
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (Object.hasOwn(input, name)) continue;
    const field = schema.properties?.[name] || {};
    const type = Array.isArray(field.type) ? field.type[0] : field.type;
    input[name] = field.default !== undefined ? field.default : type === "boolean" ? false : type === "number" || type === "integer" ? 120000 : "Fixture command";
  }
  return input;
}

export async function startFakeAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; if (raw.length > 64 * 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      if (/\/messages\/count_tokens/.test(req.url)) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 12 })); return; }
      if (req.method !== "POST" || !/\/messages(\?|$)/.test(req.url) || !body) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fixture" } }));
        return;
      }
      const last = lastUserText(body);
      const finished = toolResultOf(conversation(body).slice(-1)[0]);
      const tool = shellTool(body);
      requests.push({ model: body.model, effort: body.output_config?.effort ?? null, thinking: body.thinking ?? null, stream: !!body.stream,
        marker: marker(last), last: last.slice(0, 160), texts: userTexts(body), image: hasImage(body), toolResult: !!finished,
        toolOutput: finished ? JSON.stringify(finished.content ?? "").slice(0, 400) : null,
        toolNames: (Array.isArray(body.tools) ? body.tools : []).map(item => item?.name).filter(Boolean).slice(0, 60) });
      const id = "msg_fixture_" + crypto.randomUUID().replaceAll("-", "");
      const usageTest = /USAGE-TEST/.test(last) && !finished;
      const usage = usageTest ? { input_tokens: 2, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, output_tokens: 1 }
        : { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
      const reply = finished ? "command-finished" : marker(last) || "OK";
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (name, data) => res.write("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n");
      send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      const callTool = (name, input) => {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture_" + Date.now(), name, input: {} } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
        send("message_stop", { type: "message_stop" });
        res.end();
      };
      if (/TOOL-SLEEP/.test(last) && !finished) { callTool("Bash", { command: "sleep 36; echo waited", description: "Wait 36 seconds", timeout: 120000 }); return; }
      if (/TOOL-ECHO/.test(last) && !finished && tool) { callTool(tool.name, shellInput(tool, "echo tool-ok")); return; }
      if (/TOOL-WRITE/.test(last) && !finished && tool) { callTool(tool.name, shellInput(tool, "echo tool-ok > tool-ok.txt")); return; }
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      const end = output => {
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } });
        send("message_stop", { type: "message_stop" });
        res.end();
      };
      const slow = /SLOW-(\d+)/.exec(last);
      if (slow && !finished) {
        let index = 0;
        const total = Math.min(4000, Number(slow[1]));
        const tick = () => {
          if (res.destroyed || res.writableEnded) return;
          if (index >= total) { end(total); return; }
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "w" + (index += 1) + " " } });
          setTimeout(tick, 15);
        };
        tick();
        return;
      }
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
      end(usageTest ? 777 : 1);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: server.address().port,
    url: "http://127.0.0.1:" + server.address().port,
    requests,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// A 32×32 red square: Grok drops a picture of under 512 pixels, or narrower
// than 8, before the model sees it.
export const PNG_32PX = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IydHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJI2YD1ZaHIvAAAAAElFTkSuQmCC";
