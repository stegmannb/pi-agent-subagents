import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Local deterministic provider: no network or credential lookup. */
export default function (pi: ExtensionAPI): void {
  pi.registerProvider("process-test", {
    name: "Process test",
    api: "process-test",
    apiKey: "test-only",
    baseUrl: "http://127.0.0.1.invalid",
    models: [
      {
        id: "process-test",
        name: "Process test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 512,
      },
    ],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const text = JSON.stringify({
        pid: process.pid,
        ...(process.env.PASA_TEST_TRACE
          ? { processAgeMs: Math.round(process.uptime() * 1000) }
          : {}),
        cwd: process.cwd(),
        users: context.messages.filter((m) => m.role === "user").map((m) => m.content),
        inheritedSecret: process.env.PASA_RPC_SECRET ?? null,
      });
      const last = context.messages.at(-1);
      const userText =
        last?.role === "user"
          ? typeof last.content === "string"
            ? last.content
            : last.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
          : "";
      const command = userText.startsWith("HOST:") ? JSON.parse(userText.slice(5)) : undefined;
      const childTool = userText.startsWith("Task:\nCHILD:tool:")
        ? JSON.parse(userText.slice("Task:\nCHILD:tool:".length))
        : undefined;
      if (process.env.PASA_TEST_TRACE)
        appendFileSync(
          process.env.PASA_TEST_TRACE,
          JSON.stringify({
            pid: process.pid,
            cwd: process.cwd(),
            prompt: userText,
            processAgeMs: Math.round(process.uptime() * 1000),
          }) + "\n",
        );
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: childTool
          ? [
              {
                type: "toolCall",
                id: "child-tool",
                name: childTool.name,
                arguments: childTool.arguments,
              },
            ]
          : command
            ? [
                {
                  type: "toolCall",
                  id: "host-test-tool",
                  name: "Agent",
                  arguments: {
                    description: "RPC child",
                    subagent_type: "general-purpose",
                    runner: "rpc",
                    ...command,
                  },
                },
              ]
            : [{ type: "text", text }],
        stopReason: command || childTool ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (!command && !childTool)
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end(message);
      });
      return stream;
    },
  });
}
