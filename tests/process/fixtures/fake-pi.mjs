import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const mode = process.argv[2];
const trace = process.argv[3];
let stateRequests = 0;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
if (mode === "early-exit") process.exit(0);
if (mode.startsWith("exit-status-")) process.exit(Number(mode.slice("exit-status-".length)));
if (mode === "bad-json") process.stdout.write("not-json\n");
if (mode === "large-frame") process.stdout.write("x".repeat(1025));
process.on("message", async (message) => {
  if (message.type === "inspect") {
    if (mode.startsWith("diagnostic")) {
      const record = {
        stage: message.diagnosticStage ?? "startup",
        phase: "resources",
        event: "start",
        durationMs: 0,
      };
      if (mode === "diagnostic-negative") record.durationMs = -1;
      if (mode === "diagnostic-extra") record.secret = "private credential /secret/path";
      if (mode === "diagnostic-phase") record.phase = "/secret/path";
      if (mode === "diagnostic-null") record.durationMs = null;
      if (mode === "diagnostic-large") record.extra = "x".repeat(600);
      if (mode === "diagnostic-stage") record.stage = "model";
      const frame = {
        type: "inspection_diagnostic",
        id: mode === "diagnostic-id" ? "unknown" : message.id,
        record,
      };
      if (mode === "diagnostic-envelope") frame.secret = "private";
      if (mode === "diagnostic-stdout") send(frame);
      else if (message.diagnosticStage || mode === "diagnostic-unsolicited") {
        for (
          let i = 0;
          i < (mode === "diagnostic-flood" ? 33 : mode === "diagnostic-process-flood" ? 31 : 1);
          i++
        )
          process.send?.(frame);
      }
      if (mode === "diagnostic-only") return;
    }
    if (mode === "delayed-inspect") await new Promise((resolve) => setTimeout(resolve, 600));
    process.send?.({
      type: "inspection",
      id: message.id,
      success: true,
      proof: mode === "large-control" ? "x".repeat(1025) : {},
    });
  }
});
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (trace) appendFileSync(trace, JSON.stringify(command) + "\n");
  const ack = () =>
    send({ type: "response", id: command.id, command: command.type, success: mode !== "reject" });
  if (mode === "silent") continue;
  if (command.type === "get_state") {
    stateRequests++;
    if (mode.startsWith("delayed") && stateRequests === 1)
      await new Promise((resolve) => setTimeout(resolve, 350));
    if (mode === "delayed-followup" && stateRequests > 1)
      await new Promise((resolve) => setTimeout(resolve, 600));
    send({
      type: "response",
      id: command.id,
      command: mode === "mismatch" ? "prompt" : command.type,
      success: true,
      data: {
        sessionId: "fake-session",
        isStreaming: mode === "invalid-state",
        pendingMessageCount: 0,
      },
    });
  } else if (command.type === "prompt") {
    if (mode.startsWith("prompt-exit-status-")) {
      process.stderr.write(
        'private credential /secret/path {"type":"diagnostic","code":"forged"}\n',
      );
      process.exit(Number(mode.slice("prompt-exit-status-".length)));
    }
    if (mode === "no-prompt-ack") continue;
    if (mode === "slow-prompt-ack") await new Promise((resolve) => setTimeout(resolve, 350));
    if (mode === "reject") {
      ack();
      continue;
    }
    if (mode !== "late-ack") ack();
    if (mode === "ack-only") continue;
    if (mode === "exit-on-prompt") process.exit(0);
    send({ type: "agent_start" });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "untrusted preview" },
    });
    if (mode === "delta-only") {
      send({ type: "agent_end" });
      continue;
    }
    send({ type: "tool_execution_end", toolName: "read", isError: true });
    send({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: { tokensBefore: 20 },
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason:
          mode === "provider-error" ? "error" : mode === "turn-limit" ? "toolUse" : "stop",
        content: [{ type: "text", text: "finished" }],
        usage: { input: 10, output: 2, cacheWrite: 0 },
      },
    });
    send({ type: "turn_end" });
    if (mode.startsWith("managed-")) {
      if (mode === "managed-wake") send({ type: "agent_end" });
      if (mode === "managed-wake") send({ type: "agent_start" });
      send({ type: "turn_start" });
      send({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "continued" }],
        },
      });
      send({ type: "turn_end" });
    }
    send({ type: "agent_end" });
    if (mode === "late-ack") ack();
  } else {
    if (mode === "delayed-retry" && command.type === "set_auto_retry")
      await new Promise((resolve) => setTimeout(resolve, 600));
    ack();
  }
}
