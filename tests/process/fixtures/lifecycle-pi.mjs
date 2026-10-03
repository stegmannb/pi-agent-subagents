import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const mode = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const trace = (type) => {
  if (process.env.PASA_LIFE_TRACE) appendFileSync(process.env.PASA_LIFE_TRACE, type + "\n");
};
process.on("SIGTERM", () => {
  trace("term_observed");
  send({ type: "term_observed" });
  if (mode !== "ignore-term") process.exit(0);
});
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "extension_ui_response") {
    send({ type: "dialog_answer", response: command });
    continue;
  }
  send({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    ...(command.type === "get_state"
      ? { data: { sessionId: "fake-session", isStreaming: false, pendingMessageCount: 0 } }
      : {}),
  });
  if (command.type === "abort") {
    trace("abort_observed");
    send({ type: "abort_observed" });
  }
  if (command.type === "prompt") {
    send({ type: "agent_start" });
    send({ type: "tool_execution_start", toolName: "held-tool" });
    if (mode.startsWith("dialog-"))
      send({
        type: "extension_ui_request",
        id: "question",
        method: mode === "dialog-expire" ? "confirm" : mode.slice(7),
        ...(mode === "dialog-expire" ? { timeout: 100 } : {}),
        title: "Approval",
        message: "Allow?",
        options: ["one", "two"],
      });
  }
}
