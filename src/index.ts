/**
 * pi-agent-subagents — A pi extension providing autonomous sub-agents.
 *
 * Tools:
 *   Agent                — spawn a sub-agent (foreground or background)
 *   get_subagent_result  — check background agent status/result
 *   steer_subagent       — send a steering message to a running agent
 *
 * Commands:
 *   /agents              — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  parseFrontmatter,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentManager } from "./agent-manager.ts";
import {
  getAgentConversation,
  getDefaultMaxTurns,
  getGraceTurns,
  normalizeMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
  steerAgent,
} from "./agent-runner.ts";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAllTypes,
  getAvailableTypes,
  getDefaultAgentNames,
  getUserAgentNames,
  registerAgents,
  resolveType,
} from "./agent-types.ts";
import { loadCustomAgents } from "./custom-agents.ts";
import { GroupJoinManager } from "./group-join.ts";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.ts";
import { type ModelRegistry, resolveModel } from "./model-resolver.ts";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.ts";
import { applyAndEmitLoaded, saveAndEmitChanged, type SubagentsSettings } from "./settings.ts";
import type {
  AgentConfig,
  AgentInvocation,
  AgentRecord,
  JoinMode,
  NotificationDetails,
  SubagentType,
} from "./types.ts";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
} from "./ui/agent-widget.ts";
import { addUsage, getLifetimeTotal, getSessionContextPercent } from "./usage.ts";

// ---- Helpers ----

function textResult(msg: string, details?: AgentDetails) {
  return {
    content: [{ type: "text" as const, text: msg }],
    details: details as any,
  };
}

function formatLifetimeTokens(o: { lifetimeUsage: { input: number; output: number; cacheWrite: number } }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

function getStatusNote(status: string): string {
  switch (status) {
    case "aborted": return " (aborted — max turns exceeded, output may be incomplete)";
    case "steered": return " (wrapped up — reached turn limit)";
    case "stopped": return " (stopped by user)";
    default: return "";
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join("\n");
}

function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any; lifetimeUsage: { input: number; output: number; cacheWrite: number } },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

function getModelLabelFromConfig(model: string): string {
  const name = model.includes("/") ? model.split("/").pop()! : model;
  return name.replace(/-\d{8}$/, "");
}

// ---- Extension ----

export default function (pi: ExtensionAPI) {
  // ---- Custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status : d.status === "steered" ? "completed (steered)" : "completed";

        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    },
  );

  // ---- Agent state ----

  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };
  reloadCustomAgents();

  const agentActivity = new Map<string, AgentActivity>();

  // ---- Nudge management ----
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      try { send(); } catch { /* ignore */ }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;
    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    widget.update();
  }

  // ---- Group join ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { widget.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join("\n\n");
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first!, 300, agentActivity.get(first!.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      widget.update();
    },
    30_000,
  );

  // ---- Batch tracking ----
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === "smart" || a.joinMode === "group");
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  // ---- Manager + widget ----

  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
    };
  }

  const manager = new AgentManager((record) => {
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();
      return;
    }

    if (currentBatchAgents.some(a => a.id === record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === "pass") {
      sendIndividualNudge(record);
    }
    widget.update();
  }, undefined, (record) => {
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  });

  let currentCtx: ExtensionContext | undefined;
  const widget = new AgentWidget(manager, agentActivity);

  // ---- Join mode ----
  let defaultJoinMode: JoinMode = "smart";
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // ---- Session lifecycle ----

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted();
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted();
  });

  // Cross-extension RPC
  const unsubSpawn = pi.events.on("subagents:rpc:spawn", (payload: any) => {
    if (!currentCtx) return;
    try {
      manager.spawn(pi, currentCtx, payload.type, payload.prompt, {
        description: payload.description ?? payload.type,
        isBackground: true,
      });
    } catch { /* ignore */ }
  });

  const unsubStop = pi.events.on("subagents:rpc:stop", (payload: any) => {
    if (payload?.id) manager.abort(payload.id);
  });

  pi.events.emit("subagents:ready", {});

  pi.on("session_shutdown", async () => {
    unsubSpawn();
    unsubStop();
    currentCtx = undefined;
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    groupJoin.dispose();
    widget.dispose();
    manager.dispose();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as any);
    widget.onTurnStart();
  });

  // ---- Settings ----

  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Type list ----

  const buildTypeListText = () => {
    const defaultNames = getDefaultAgentNames();
    const userNames = getUserAgentNames();

    const defaultDescs = defaultNames.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}`;
    });

    const customDescs = userNames.map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${cfg?.description ?? name}`;
    });

    return [
      "Default agents:",
      ...defaultDescs,
      ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
      "",
      `Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).`,
    ].join("\n");
  };

  const typeListText = buildTypeListText();

  // ---- Agent tool ----

  pi.registerTool(defineTool({
    name: "Agent",
    label: "Agent",
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types:
${typeListText}

Guidelines:
- For parallel work, use run_in_background: true on each agent.
- Use Explore for codebase searches and code understanding.
- Use Plan for architecture and implementation planning.
- Use general-purpose for complex tasks that need file editing.
- Provide clear, detailed prompts so the agent can work autonomously.
- Use run_in_background for work you don't need immediately.
- Use resume with an agent ID to continue a previous agent's work.
- Use steer_subagent to send mid-run messages to a running background agent.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").`,
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the agent to perform." }),
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
      subagent_type: Type.String({ description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}.` }),
      model: Type.Optional(Type.String({ description: 'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet").' })),
      thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh." })),
      max_turns: Type.Optional(Type.Number({ description: "Maximum agentic turns before stopping.", minimum: 1 })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Set to true to run in background." })),
      resume: Type.Optional(Type.String({ description: "Optional agent ID to resume from." })),
      isolated: Type.Optional(Type.Boolean({ description: "If true, agent gets no extension/MCP tools." })),
      inherit_context: Type.Optional(Type.Boolean({ description: "If true, fork parent conversation into the agent." })),
      isolation: Type.Optional(Type.Literal("worktree", { description: 'Set to "worktree" to run in a temporary git worktree.' })),
    }),

    renderCall(args, theme) {
      const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
      const desc = args.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        let line = theme.fg("accent", frame) + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
        return new Text(line, 0, 0);
      }

      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const icon = details.status === "steered" ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
          }
        } else {
          const doneText = details.status === "steered" ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");
      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }
      return new Text(line, 0, 0);
    },

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      widget.setUICtx(ctx.ui as any);
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      const resolved = resolveType(rawType);
      const subagentType = resolved ?? "general-purpose";
      const fellBack = resolved === undefined;
      const displayName = getDisplayName(subagentType);
      const customConfig = getAgentConfig(subagentType);
      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolvedModel = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolvedModel);
        } else {
          model = resolvedModel;
        }
      }

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;

      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const modelName = effectiveModelId && effectiveModelId !== parentModelId
        ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName, thinking, maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated, inheritContext, runInBackground, isolation,
      };
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const modeLabel = getPromptModeLabel(subagentType);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = { displayName, description: params.description, subagentType, modelName, tags: agentTags.length > 0 ? agentTags : undefined };

      // Resume
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) return textResult(`Agent not found: "${params.resume}".`);
        if (!existing.session) return textResult(`Agent "${params.resume}" has no active session to resume.`);
        const record = await manager.resume(params.resume, params.prompt, signal);
        if (!record) return textResult(`Failed to resume agent "${params.resume}".`);
        return textResult(record.result?.trim() || record.error?.trim() || "No output.", buildDetails(detailBase, record));
      }

      // Background
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        try {
          id = manager.spawn(pi, ctx, subagentType, params.prompt, {
            description: params.description, model, maxTurns: effectiveMaxTurns,
            isolated, inheritContext, thinkingLevel: thinking,
            isBackground: true, isolation, invocation: agentInvocation, ...bgCallbacks,
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }

        const joinMode = resolveJoinMode(defaultJoinMode, true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
          writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);
        }

        if (joinMode != null && joinMode !== "async") {
          currentBatchAgents.push({ id, joinMode });
          if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
          batchFinalizeTimer = setTimeout(finalizeBatch, 100);
        }

        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();

        pi.events.emit("subagents:created", { id, type: subagentType, description: params.description, isBackground: true });

        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\nAgent ID: ${id}\nType: ${displayName}\nDescription: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\nUse get_subagent_result to retrieve full results, or steer_subagent to send it messages.\nDo not duplicate this agent's work.`,
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...detailBase,
          toolUses: fgState.toolUses,
          tokens: formatLifetimeTokens(fgState),
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({ content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }], details: details as any });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            break;
          }
        }
      };

      const spinnerInterval = setInterval(() => { spinnerFrame++; streamUpdate(); }, 80);
      streamUpdate();

      let record: AgentRecord;
      try {
        record = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
          description: params.description, model, maxTurns: effectiveMaxTurns,
          isolated, inheritContext, thinkingLevel: thinking, isolation, invocation: agentInvocation, signal, ...fgCallbacks,
        });
      } catch (err) {
        clearInterval(spinnerInterval);
        return textResult(err instanceof Error ? err.message : String(err));
      }

      clearInterval(spinnerInterval);
      if (fgId) { agentActivity.delete(fgId); widget.markFinished(fgId); }

      const tokenText = formatLifetimeTokens(fgState);
      const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });
      const fallbackNote = fellBack ? `Note: Unknown agent type "${rawType}" — using general-purpose.\n\n` : "";

      if (record.status === "error") {
        return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n${record.result?.trim() || "No output."}`,
        details,
      );
    },
  }));

  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description: "Check status and retrieve results from a background agent.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to check." }),
      wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete. Default: false." })),
      verbose: Type.Optional(Type.Boolean({ description: "If true, include full conversation. Default: false." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Agent not found: "${params.agent_id}".`);

      if (params.wait && record.status === "running" && record.promise) {
        record.resultConsumed = true;
        cancelNudge(params.agent_id);
        await record.promise;
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session as any);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output = `Agent: ${record.id}\nType: ${displayName} | Status: ${record.status} | ${statsParts.join(" | ")}\nDescription: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        cancelNudge(params.agent_id);
      }

      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  pi.registerTool(defineTool({
    name: "steer_subagent",
    label: "Steer Agent",
    description: "Send a steering message to a running agent.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to steer (must be running)." }),
      message: Type.String({ description: "The steering message to send." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Agent not found: "${params.agent_id}".`);
      if (record.status !== "running") return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}).`);
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session as any);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(`Steering message sent to agent ${record.id}.\nCurrent state: ${stateParts.join(" · ")}`);
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- /agents command ----

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  function findAgentFile(name: string): { path: string; location: "project" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    return getModelLabelFromConfig(cfg.model);
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();
    const options: string[] = [];
    const agents = manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }
    if (allNames.length > 0) options.push(`Agent types (${allNames.length})`);
    options.push("Create new agent");
    options.push("Settings");

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) { await showRunningAgents(ctx); await showAgentsMenu(ctx); }
    else if (choice.startsWith("Agent types (")) { await showAllAgentsList(ctx); await showAgentsMenu(ctx); }
    else if (choice === "Create new agent") { await showCreateWizard(ctx); }
    else if (choice === "Settings") { await showSettings(ctx); await showAgentsMenu(ctx); }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) { ctx.ui.notify("No agents.", "info"); return; }

    const entries = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name);
      const indicator = cfg?.source === "project" ? (disabled ? "✕• " : "•  ") : cfg?.source === "global" ? (disabled ? "✕◦ " : "◦  ") : disabled ? "✕  " : "   ";
      const prefix = `${indicator}${name} · ${model}`;
      const desc = disabled ? "(disabled)" : (cfg?.description ?? name);
      return { name, prefix, desc };
    });
    const maxPrefix = Math.max(...entries.map(e => e.prefix.length));
    const options = entries.map(({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`);
    const choice = await ctx.ui.select("Agent types", options);
    if (!choice) return;
    const agentName = choice.split(" · ")[0].replace(/^[•◦✕\s]+/, "").trim();
    if (getAgentConfig(agentName)) { await showAgentDetail(ctx, agentName); await showAllAgentsList(ctx); }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents();
    if (agents.length === 0) { ctx.ui.notify("No agents.", "info"); return; }
    const options = agents.map(a => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });
    await ctx.ui.select("Running agents", options);
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) { ctx.ui.notify(`Agent not found: "${name}".`, "warning"); return; }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) menuOptions = isDefault ? ["Enable", "Edit", "Reset to default", "Delete", "Back"] : ["Enable", "Edit", "Delete", "Back"];
    else if (isDefault && !file) menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    else if (isDefault && file) menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    else menuOptions = ["Edit", "Disable", "Delete", "Back"];

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete" && file) {
      const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
      if (confirmed) { unlinkSync(file.path); reloadCustomAgents(); ctx.ui.notify(`Deleted ${file.path}`, "info"); }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path}?`);
      if (confirmed) { unlinkSync(file.path); reloadCustomAgents(); ctx.ui.notify(`Restored default ${name}`, "info"); }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", ["Project (.pi/agents/)", `Personal (${personalAgentsDir()})`]);
    if (!location) return;
    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      if (!await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`)) return;
    }
    const yamlStr = (s: string) =>
      `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
    const fmFields: string[] = [];
    fmFields.push(`description: ${yamlStr(cfg.description)}`);
    if (cfg.displayName) fmFields.push(`display_name: ${yamlStr(cfg.displayName)}`);
    fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
    if (cfg.model) fmFields.push(`model: ${yamlStr(cfg.model)}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false) fmFields.push("extensions: false");
    else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
    if (cfg.skills === false) fmFields.push("skills: false");
    else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
    if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      const raw = readFileSync(file.path, "utf-8");
      const content = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
      if (frontmatter.enabled === false) { ctx.ui.notify(`${name} is already disabled.`, "info"); return; }
      const updated = content.replace(/^---[ \t]*\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }
    const location = await ctx.ui.select("Choose location", ["Project (.pi/agents/)", `Personal (${personalAgentsDir()})`]);
    if (!location) return;
    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;
    const raw = readFileSync(file.path, "utf-8");
    const content = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const updated = content.replace(/^(---[ \t]*\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", ["Project (.pi/agents/)", `Personal (${personalAgentsDir()})`]);
    if (!location) return;
    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;
    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;
    let tools: string;
    if (toolChoice === "all") tools = BUILTIN_TOOL_NAMES.join(", ");
    else if (toolChoice === "none") tools = "none";
    else if (toolChoice.startsWith("read-only")) tools = "read, bash, grep, find, ls";
    else { const custom = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", ")); if (!custom) return; tools = custom; }

    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = `---\ndescription: ${description}\ntools: ${tools}\nprompt_mode: replace\n---\n\n${systemPrompt}\n`;
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      if (!await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`)) return;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
    };
  }

  async function showSettings(ctx: ExtensionCommandContext) {
    const choice = await ctx.ui.select("Settings", [
      `Max concurrency (current: ${manager.getMaxConcurrent()})`,
      `Default max turns (current: ${getDefaultMaxTurns() ?? "unlimited"})`,
      `Grace turns (current: ${getGraceTurns()})`,
      `Join mode (current: ${getDefaultJoinMode()})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()));
      if (val) { const n = parseInt(val, 10); if (n >= 1) { manager.setMaxConcurrent(n); notifyApplied(ctx, `Max concurrency set to ${n}`); } else ctx.ui.notify("Must be a positive integer.", "warning"); }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ctx.ui.input("Default max turns (0 = unlimited)", String(getDefaultMaxTurns() ?? 0));
      if (val) { const n = parseInt(val, 10); if (n === 0) { setDefaultMaxTurns(undefined); notifyApplied(ctx, "Default max turns set to unlimited"); } else if (n >= 1) { setDefaultMaxTurns(n); notifyApplied(ctx, `Default max turns set to ${n}`); } else ctx.ui.notify("Must be 0 or positive integer.", "warning"); }
    } else if (choice.startsWith("Grace turns")) {
      const val = await ctx.ui.input("Grace turns after wrap-up steer", String(getGraceTurns()));
      if (val) { const n = parseInt(val, 10); if (n >= 1) { setGraceTurns(n); notifyApplied(ctx, `Grace turns set to ${n}`); } else ctx.ui.notify("Must be a positive integer.", "warning"); }
    } else if (choice.startsWith("Join mode")) {
      const val = await ctx.ui.select("Default join mode", ["smart — auto-group 2+ agents in same turn", "async — always notify individually", "group — always group background agents"]);
      if (val) { const mode = val.split(" ")[0] as JoinMode; setDefaultJoinMode(mode); notifyApplied(ctx, `Default join mode set to ${mode}`); }
    }
  }

  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(snapshotSettings(), successMsg, (event, payload) => pi.events.emit(event, payload));
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
