import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function trace(event: Record<string, unknown>): void {
  appendFileSync(
    process.env.PASA_ROLE_TRACE!,
    JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      processAgeMs: Math.round(process.uptime() * 1000),
      ...event,
    }) + "\n",
  );
}

/** Real registered mutation tool and deterministic provider for the role boundary test. */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "role_mutation",
    label: "Role mutation probe",
    description: "Write a marker for the role boundary integration test",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      trace({ kind: "mutation", path: params.path });
      writeFileSync(resolve(params.path), "custom mutation executed");
      return { content: [{ type: "text", text: "marker written" }], details: {} };
    },
  });
  trace({ kind: "registered", tool: "role_mutation" });
  pi.registerProvider("role-test", {
    name: "Role test",
    api: "role-test",
    apiKey: "test-only",
    baseUrl: "http://127.0.0.1.invalid",
    models: [
      {
        id: "role-test",
        name: "Role test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 512,
      },
    ],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const prompt =
        last?.role === "user"
          ? typeof last.content === "string"
            ? last.content
            : last.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
          : "";
      trace({ kind: "invocation", prompt, tools: context.tools?.map((tool) => tool.name) ?? [] });
      const prefix = prompt.startsWith("HOST:")
        ? "HOST:"
        : prompt.startsWith("Task:\nCHILD:")
          ? "Task:\nCHILD:"
          : undefined;
      // Intentionally emit even unoffered tools, exercising actual SDK dispatch and the boundary.
      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = prefix
        ? JSON.parse(prompt.slice(prefix.length))
        : [];
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: calls.length
          ? calls.map((call, i) => ({ type: "toolCall", id: `role-${i}`, ...call }))
          : [{ type: "text", text: "Role probe finished" }],
        stopReason: calls.length ? "toolUse" : "stop",
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
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end(message);
      });
      return stream;
    },
  });
}
