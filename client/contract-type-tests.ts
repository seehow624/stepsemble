/// <reference path="./client.ts" />
// Compile-only regression tests. No output ships to browsers.
function assertWireNarrowing(event: StepsembleClient.WireEvent, command: StepsembleClient.Command): void {
  if (event.type === "message.delta") {
    const text: string = event.payload.delta;
    // @ts-expect-error The schema declares a string delta, not a numeric value.
    const wrong: number = event.payload.delta;
    void text; void wrong;
  }
  if (event.type === "approval.requested") {
    const nonce: string = event.payload.approval.nonce;
    const runId: string = event.runId;
    void nonce; void runId;
  }
  if (event.type === "session.created") {
    const noRun: null = event.runId;
    void noRun;
  }
  if (command.type === "approval.resolve") {
    const decision: "approved" | "denied" = command.payload.decision;
    // @ts-expect-error A start prompt is not part of an approval decision.
    const prompt: string = command.payload.prompt;
    void decision; void prompt;
  }
  new StepsembleClient.Client({ onUnauthorized: () => new Error("Unauthorized") });
}
function assertReceiptTypes(value: unknown): void {
  const receipt = StepsembleClient.parse("commandReceipt", value);
  const version: "sha256-tuple-v1" = receipt.fingerprintVersion;
  // @ts-expect-error A delivery receipt is not a queued automatic retry.
  const state: "auto_retry" = receipt.state;
  // @ts-expect-error The receipt contains only an opaque result reference, never a prompt.
  const prompt: string = receipt.prompt;
  void version; void state; void prompt;
}
