import { appendFileSync, existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { findCommunication } from "../../../src/process-communication.ts";

/** A real Pi provider with fixed tool calls. No inference, timer or model polling. */
export default function (pi: ExtensionAPI): void {
  const directory = process.env.PASA_QUALIFICATION_DIR!;
  const trace = (event: Record<string, unknown>) =>
    appendFileSync(
      join(directory, "trace.jsonl"),
      JSON.stringify({ pid: process.pid, ...event }) + "\n",
    );
  const waitForRelease = () =>
    new Promise<void>((resolve) => {
      const release = join(directory, "review-release");
      const watcher = watch(directory, () => {
        if (existsSync(release)) {
          watcher.close();
          resolve();
        }
      });
      if (existsSync(release)) {
        watcher.close();
        resolve();
      }
    });
  pi.on("session_start", async (_, ctx) => {
    writeFileSync(
      join(directory, `${process.pid}-session.json`),
      JSON.stringify({
        pid: process.pid,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      }),
    );
  });
  pi.events.on("pasa:protection:snapshot:v1", (value: any) => {
    const respond = value.respond;
    value.respond = (response: any) => {
      trace({
        kind: "protection-snapshot",
        protectionId: response.protectionId,
        status: response.status,
        reason: response.reason,
      });
      respond(response);
    };
  });
  pi.on("tool_result", async (event) => {
    if (
      event.toolName === "reply_agent_message" &&
      JSON.stringify(event.content).includes("Correlated reply received")
    ) {
      writeFileSync(join(directory, "help-replied"), "actual correlated reply received\n");
    }
    if (event.toolName === "request_help") await waitForRelease();
  });
  pi.on("before_agent_start", async (event) => {
    if (event.prompt.includes("Error: CONCURRENCY_LIMIT")) {
      if (!existsSync(join(directory, "help-replied")))
        throw new Error("qualification budget notification preceded the correlated reply");
      // Fixture barriers only, after the actual refused reservation notification.
      writeFileSync(join(directory, "review-release"), "release after actual budget refusal\n");
    }
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName === "reply_agent_message") {
      const channel = findCommunication(pi.events)!;
      writeFileSync(
        join(directory, "group-before-reply.json"),
        JSON.stringify({
          self: channel.binding.agentId,
          members: await channel.members(),
          help: channel.pendingHelp(),
          requestId: event.input.request_id,
        }),
      );
    }
    if (event.toolName !== "read" || event.input.path !== "review.txt") return;
    writeFileSync(join(directory, "review-ready"), String(process.pid));
    await waitForRelease();
  });
  let kind = "root";
  let helpId: string | undefined;
  let helpStage = "idle";
  const collected = new Set<string>();
  let corrected = false;
  pi.registerProvider("qualification-test", {
    name: "Qualification test",
    api: "qualification-test",
    apiKey: "test-only",
    baseUrl: "http://127.0.0.1.invalid",
    models: [
      {
        id: "qualification-test",
        name: "Qualification test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 1024,
      },
    ],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const content = (value: any): string =>
        typeof value?.content === "string"
          ? value.content
          : (value?.content ?? [])
              .filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join("");
      const prompt = last?.role === "user" ? content(last) : "";
      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      if (prompt === "QUALIFY_ROOT")
        calls.push({
          name: "Agent",
          arguments: {
            description: "Task with reviewer and sibling",
            subagent_type: "general-purpose",
            runner: "rpc",
            isolation: "worktree",
            prompt: "QUALIFY_TASK",
          },
        });
      if (prompt === "Task:\nQUALIFY_TASK") {
        kind = "task";
        calls.push(
          { name: "write", arguments: { path: "work.txt", content: "task work before review\n" } },
          {
            name: "Agent",
            arguments: {
              description: "Sibling awaiting correlated help",
              subagent_type: "general-purpose",
              isolation: "worktree",
              run_in_background: true,
              prompt: "QUALIFY_SIBLING",
            },
          },
          {
            name: "Agent",
            arguments: {
              description: "Independent reviewer",
              subagent_type: "code-review",
              isolation: "worktree",
              run_in_background: true,
              prompt: "QUALIFY_REVIEWER",
            },
          },
        );
      }
      if (prompt === "Task:\nQUALIFY_SIBLING") {
        kind = "sibling";
        calls.push({
          name: "request_help",
          arguments: { message: "qualification-correlated-question" },
        });
      }
      if (prompt === "Task:\nQUALIFY_REVIEWER") {
        kind = "reviewer";
        calls.push(
          { name: "read", arguments: { path: "review.txt" } },
          { name: "write", arguments: { path: "forbidden.txt", content: "forbidden" } },
        );
      }
      if (kind === "task" && prompt.startsWith("Agent message: ")) {
        const help = JSON.parse(prompt.slice("Agent message: ".length));
        if (help.message === "qualification-correlated-question") {
          helpId = help.requestId;
          helpStage = "answer";
          calls.push({
            name: "reply_agent_message",
            arguments: { request_id: helpId, message: "qualification-direct-answer" },
          });
        }
      }
      if (kind === "task" && last?.role === "toolResult") {
        if (helpStage === "answer" && last.toolName === "reply_agent_message") {
          helpStage = "inventory";
          calls.push({ name: "list_agent_group", arguments: {} });
        } else if (helpStage === "inventory" && last.toolName === "list_agent_group") {
          helpStage = "budget";
          calls.push({
            name: "Agent",
            arguments: {
              description: "Refused excess child",
              subagent_type: "general-purpose",
              run_in_background: true,
              prompt: "MUST_NOT_RUN",
            },
          });
        } else if (helpStage === "budget" && last.toolName === "Agent") {
          helpStage = "released";
        }
      }
      if (kind === "task" && prompt.includes("<task-notification>"))
        for (const block of prompt.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
          if (block[0].includes("Error: CONCURRENCY_LIMIT")) continue;
          for (const match of block[0].matchAll(/<task-id>([^<]+)<\/task-id>/g))
            calls.push({ name: "get_subagent_result", arguments: { agent_id: match[1] } });
        }
      if (
        kind === "task" &&
        last?.role === "toolResult" &&
        last.toolName === "get_subagent_result"
      ) {
        // Count only complete, persisted results actually returned by the tool.
        for (const message of context.messages) {
          if (message.role !== "toolResult" || message.toolName !== "get_subagent_result") continue;
          const text = content(message);
          const match = text.match(/Agent: ([^\n]+)\nType: [^\n]*Status: completed/);
          if (match && text.includes('"ingested":true')) collected.add(match[1]);
        }
        if (collected.size === 2 && !corrected) {
          corrected = true;
          calls.push({
            name: "write",
            arguments: {
              path: "corrected.txt",
              content: "correction after both persisted findings\n",
            },
          });
        }
      }
      trace({
        kind: "invocation",
        actor: kind,
        prompt,
        calls,
        tools: context.tools?.map((tool) => tool.name) ?? [],
        collected: [...collected],
      });
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: calls.length
          ? calls.map((call, i) => ({ type: "toolCall", id: `qualification-${i}`, ...call }))
          : [
              {
                type: "text",
                text:
                  kind === "reviewer"
                    ? "QUALIFICATION_REVIEW_FINDING: correct the task work"
                    : kind === "root"
                      ? "QUALIFICATION_ROOT_FINISHED"
                      : "QUALIFICATION_TURN_ENDED",
              },
            ],
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
