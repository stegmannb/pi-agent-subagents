import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import qualificationProvider from "./fixtures/qualification-provider.ts";

test("qualification opens correlated help only after reviewer readiness and the task's ended turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pasa-qualification-order-"));
  const previous = process.env.PASA_QUALIFICATION_DIR;
  process.env.PASA_QUALIFICATION_DIR = directory;
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const handlers = new Map<string, (event: any, context: any) => any>();
  let provider: any;
  qualificationProvider({
    on: (name: string, handler: any) => handlers.set(name, handler),
    events: { on() {} },
    registerProvider: (_name: string, options: any) => {
      provider = options;
    },
  } as unknown as ExtensionAPI);
  const context = { sessionManager: { getSessionId: () => "task-session" } };
  const call = (name: string, event: any) => handlers.get(name)?.(event, context);
  const model = {
    id: "qualification-test",
    api: "qualification-test",
    provider: "qualification-test",
  };
  await provider
    .streamSimple(model, { messages: [{ role: "user", content: "Task:\nQUALIFY_TASK" }] })
    .result();
  const ended = await provider
    .streamSimple(model, { messages: [{ role: "toolResult", toolName: "Agent", content: [] }] })
    .result();
  assert.equal(ended.stopReason, "stop");
  let helpStarted = false;
  const permission = Promise.resolve(
    call("tool_call", {
      toolName: "request_help",
      input: { message: "qualification-correlated-question" },
    }),
  ).then(() => {
    helpStarted = true;
  });
  let reviewer: Promise<unknown> | undefined;
  try {
    await setImmediate();
    assert.equal(
      helpStarted,
      false,
      "the finite help request must not open during descendant startup",
    );
    // Advance the unit clock past the unchanged transport default without a
    // sleep, real request, timeout change or production clock modification.
    now = 42_000;
    await setImmediate();
    assert.equal(helpStarted, false);
    reviewer = Promise.resolve(
      call("tool_call", { toolName: "read", input: { path: "review.txt" } }),
    );
    await setImmediate();
    assert.equal(
      helpStarted,
      false,
      "reviewer readiness alone does not prove the task ended its turn",
    );
    await call("agent_end", { messages: [] });
    await permission;
    assert.equal(helpStarted, true);
    const marker = JSON.parse(await readFile(join(directory, "task-turn-ended.json"), "utf8"));
    assert.equal(marker.sessionId, "task-session");
    assert.equal(marker.pid, process.pid);
    await call("tool_result", {
      toolName: "reply_agent_message",
      content: [{ type: "text", text: "Correlated reply received." }],
    });
    await call("before_agent_start", {
      prompt: "<task-notification>Error: CONCURRENCY_LIMIT</task-notification>",
    });
    await reviewer;
  } finally {
    // Close test-owned filesystem watchers even if a regression assertion fails.
    await writeFile(join(directory, "review-ready"), "test cleanup");
    await writeFile(
      join(directory, "task-turn-ended.json"),
      JSON.stringify({ pid: process.pid, sessionId: "task-session" }),
    );
    await writeFile(join(directory, "review-release"), "test cleanup");
    await permission;
    await reviewer;
    if (previous === undefined) delete process.env.PASA_QUALIFICATION_DIR;
    else process.env.PASA_QUALIFICATION_DIR = previous;
    await rm(directory, { recursive: true });
  }
});
