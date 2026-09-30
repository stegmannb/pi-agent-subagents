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
        : [...prompt.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((match) => ({
            name: "get_subagent_result",
            arguments: { agent_id: match[1] },
          }));
      if (last?.role === "toolResult" && last.toolName === "list_agent_group") {
        const group = JSON.parse(
          last.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(""),
        );
        const self = group.members.find((m: any) => m.agentId === group.self);
        const sibling = group.members.find(
          (m: any) => m.active && m.parentId === self.parentId && m.agentId !== self.agentId,
        );
        if (sibling)
          calls.push({
            name: "send_agent_message",
            arguments: { agent_id: sibling.agentId, message: "sibling-steer-marker" },
          });
        if (sibling && process.env.PASA_SIBLING_RELEASE)
          calls.push({
            name: "bash",
            arguments: {
              command: `printf 'released\\n' > '${process.env.PASA_SIBLING_RELEASE.replaceAll("'", "'\\''")}'`,
            },
          });
      }
      if (
        prompt.startsWith("Agent message: ") &&
        JSON.parse(prompt.slice("Agent message: ".length)).message === "sibling-steer-marker"
      )
        calls.push({
          name: "write",
          arguments: { path: "steering.txt", content: "sibling steering at safe model transition" },
        });
      if (prompt.startsWith("Agent message: ")) {
        const message = JSON.parse(prompt.slice("Agent message: ".length));
        if (message.message === "nested-background-help" && message.requestId)
          calls.push({
            name: "reply_agent_message",
            arguments: { request_id: message.requestId, message: "model direct answer" },
          });
      }
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
