// Loaded only into Stepsemble-owned Pi processes. A registered command runs
// before Pi's prompt pipeline and never creates a message or model request.
export default function stepsembleCatalog(pi) {
  pi.registerCommand("stepsemble-refresh-models", {
    description: "Reload the local provider model catalog for Stepsemble",
    handler: async (_args, ctx) => {
      await ctx.modelRegistry.refresh({ allowNetwork: false });
    },
  });
}
