import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PROVIDER = "tui-test";
const MODEL = "tui-test";
const API = "tui-test-script";
const MAX_WAIT_MS = 15_000;
let nextToolId = 1;

function controlDir(): string | undefined {
  return process.env.PI_TUI_TEST_CONTROL_DIR;
}

function record(file: string, event: Record<string, unknown>): void {
  const dir = controlDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, file), `${JSON.stringify(event)}\n`);
}

function lastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  }
  return "";
}

function tool(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: "toolCall",
    id: `script-${nextToolId++}`,
    name,
    arguments: args,
  };
}

async function waitForGate(gate: string, signal?: AbortSignal): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(gate)) throw new Error(`Invalid gate: ${gate}`);
  const dir = controlDir();
  if (!dir) throw new Error("PI_TUI_TEST_CONTROL_DIR is required for CHILD:wait");
  record("events.ndjson", { event: "waiting", gate });
  const deadline = Date.now() + MAX_WAIT_MS;
  while (!existsSync(join(dir, `release-${gate}`))) {
    if (signal?.aborted) throw new Error(`Aborted while waiting for ${gate}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${gate}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  record("events.ndjson", { event: "released", gate });
}

function streamScript(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const last = context.messages.at(-1);
      const prompt = lastUserText(context).trim();
      record("events.ndjson", { event: "request", prompt, lastRole: last?.role });

      let response: string | ToolCall;
      if (last?.role === "toolResult") {
        response = `Tool ${last.toolName} returned: ${last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(" ")}`;
      } else if (prompt.startsWith("TUI:worktree:")) {
        response = tool("Agent", {
          description: "Retained worktree agent",
          subagent_type: "general-purpose",
          isolation: "worktree",
          ...JSON.parse(prompt.slice("TUI:worktree:".length)),
        });
      } else if (prompt.startsWith("TUI:cleanup:")) {
        response = tool("cleanup_subagent_worktree", { path: prompt.slice("TUI:cleanup:".length) });
      } else if (prompt.startsWith("TUI:integrate:")) {
        response = tool("integrate_subagent_worktree", {
          agent_id: prompt.slice("TUI:integrate:".length),
        });
      } else if (prompt.startsWith("TUI:agent:")) {
        response = tool("Agent", {
          prompt: prompt.slice("TUI:agent:".length),
          description: "Scripted foreground agent",
          subagent_type: "general-purpose",
        });
      } else if (prompt.startsWith("TUI:background:")) {
        response = tool("Agent", {
          prompt: prompt.slice("TUI:background:".length),
          description: "Scripted background agent",
          subagent_type: "general-purpose",
          run_in_background: true,
        });
      } else if (prompt.startsWith("TUI:timeout:")) {
        const match = /^TUI:timeout:(\d+):(.*)$/s.exec(prompt);
        if (!match) throw new Error(`Invalid timeout script: ${prompt}`);
        response = tool("Agent", {
          prompt: match[2],
          description: "Scripted timeout agent",
          subagent_type: "general-purpose",
          timeout_seconds: Number(match[1]),
        });
      } else if (prompt.startsWith("TUI:timeout-background:")) {
        const match = /^TUI:timeout-background:(\d+):(.*)$/s.exec(prompt);
        if (!match) throw new Error(`Invalid background timeout script: ${prompt}`);
        response = tool("Agent", {
          prompt: match[2],
          description: "Scripted background timeout",
          subagent_type: "general-purpose",
          run_in_background: true,
          timeout_seconds: Number(match[1]),
        });
      } else if (prompt.startsWith("TUI:get:")) {
        response = tool("get_subagent_result", {
          agent_id: prompt.slice("TUI:get:".length),
          wait: false,
        });
      } else if (prompt.startsWith("TUI:steer:")) {
        const [, , id, ...parts] = prompt.split(":");
        response = tool("steer_subagent", { agent_id: id, message: parts.join(":") });
      } else if (prompt === "CHILD:error") {
        throw new Error("Scripted child failure");
      } else if (prompt.startsWith("CHILD:wait-error:")) {
        await waitForGate(prompt.slice("CHILD:wait-error:".length), options?.signal);
        throw new Error("Scripted child failure after gate");
      } else if (prompt.startsWith("CHILD:wait:")) {
        const gate = prompt.slice("CHILD:wait:".length);
        await waitForGate(gate, options?.signal);
        response = `Child released from ${gate}`;
      } else if (prompt === "CHILD:complete") {
        response = "Scripted child completed";
      } else if (prompt.startsWith("CHILD:long:")) {
        const count = Number(prompt.slice("CHILD:long:".length));
        if (!Number.isInteger(count) || count < 1 || count > 10_000)
          throw new Error(`Invalid output length: ${count}`);
        response = `Long child output ${"x".repeat(count)} end marker`;
      } else {
        response = `Scripted response: ${prompt}`;
      }

      if (options?.signal?.aborted) throw new Error("Scripted request aborted");
      if (typeof response === "string") {
        output.content = [{ type: "text", text: response }];
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: response, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: response, partial: output });
        output.stopReason = "stop";
      } else {
        output.content = [response];
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(response.arguments),
          partial: output,
        });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: response, partial: output });
        output.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end(output);
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      record("events.ndjson", {
        event: "error",
        error: output.errorMessage,
        reason: output.stopReason,
      });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
    }
  })();
  return stream;
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    name: "TUI scripted test provider",
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only",
    api: API,
    streamSimple: streamScript,
    models: [
      {
        id: MODEL,
        name: "TUI scripted model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxTokens: 512,
      },
    ],
  });

  for (const name of [
    "started",
    "completed",
    "failed",
    "compacted",
    "ready",
    "created",
    "steered",
  ]) {
    pi.events.on(`subagents:${name}`, (data) => record("subagents.ndjson", { event: name, data }));
  }
}
