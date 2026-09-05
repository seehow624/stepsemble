// Only loaded explicitly in a disposable offline Pi profile. No model calls,
// tools, shell commands, network or user workspace access.
export default function probe(pi) {
  pi.registerCommand("stepsemble-probe", {
    description: "Offline Stepsemble contract fixture",
    handler: async (argument, ctx) => {
      if (argument === "record") {
        pi.sendMessage({ customType: "stepsemble-probe", content: "貓掌🐾\u2028line\u2029end", display: true });
        return;
      }
      let result;
      if (["confirm", "timeout"].includes(argument)) result = await ctx.ui.confirm("Synthetic confirmation", "No action will be executed", { timeout: argument === "timeout" ? 100 : 10000 });
      else if (argument === "select") result = await ctx.ui.select("Synthetic selection", ["貓掌🐾", "other"]);
      else if (argument === "input") result = await ctx.ui.input("Synthetic input", "type here");
      else if (argument === "editor") result = await ctx.ui.editor("Synthetic editor", "prefill");
      else throw new Error("Unknown fixture operation");
      ctx.ui.notify(JSON.stringify({ method: argument, result: result === undefined ? null : result }), "info");
    },
  });
}
