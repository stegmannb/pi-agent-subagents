/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 */

import { requireProcessRunner } from "./process-runner.ts";
import { findCommunication, MANAGED_CHANGED_EVENT } from "./process-communication.ts";
import { PARENT_AGENT_TOOL_NAMES, SUBAGENT_CONTEXT_TOOL_NAMES } from "./tool-constants.ts";
import { buildParentContext } from "./context.ts";
import { getAgentConfig, getToolNamesForType } from "./agent-types.ts";
import type { ProcessExecutionResult } from "./process-contract.ts";
import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { normalizeMaxTurns, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.ts";
import type {
  AgentInvocation,
  AgentRecord,
  IsolationMode,
  SubagentType,
  ThinkingLevel,
} from "./types.ts";
import { appendErrorEntry } from "./output-file.ts";
import { addUsage } from "./usage.ts";
import {
  createWorktree,
  createSnapshotWorktree,
  inspectWorktree,
  type SnapshotOptions,
} from "./worktree.ts";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = {
  reason: "manual" | "threshold" | "overflow";
  tokensBefore: number;
};

const DEFAULT_MAX_CONCURRENT = 4;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  runner?: "in-process" | "rpc";
  onProcessEvent?: import("./process-rpc.ts").ProcessRpcOptions["onEvent"];
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  timeoutSeconds?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  worktreeBase?: string;
  worktreeSnapshot?: SnapshotOptions;
  cwd?: string;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private processResumes = new Map<string, ProcessExecutionResult["resume"]>();
  private processRunners = new Map<string, import("./process-contract.ts").ProcessRunner>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  private queue: { id: string; args: SpawnArgs }[] = [];
  private readyResolvers = new Map<string, () => void>();
  private defaultMaxTurns: number | undefined = undefined;
  private defaultTimeoutSeconds: number | undefined = undefined;
  private graceTurns = 5;
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  getDefaultMaxTurns(): number | undefined {
    return this.defaultMaxTurns;
  }
  setDefaultMaxTurns(n: number | undefined): void {
    this.defaultMaxTurns = normalizeMaxTurns(n);
  }
  getDefaultTimeoutSeconds(): number | undefined {
    return this.defaultTimeoutSeconds;
  }
  setDefaultTimeoutSeconds(n: number | undefined): void {
    this.defaultTimeoutSeconds = n == null || n <= 0 ? undefined : n;
  }
  getGraceTurns(): number {
    return this.graceTurns;
  }
  setGraceTurns(n: number): void {
    this.graceTurns = Math.max(1, n);
  }

  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const channel = findCommunication(pi.events);
    if (channel?.binding.parentId) {
      if (channel.binding.role.readOnly || options.runner === "in-process")
        throw new Error("ROLE_DELEGATION_FORBIDDEN");
      options = { ...options, runner: "rpc" };
    }
    if (
      options.worktreeSnapshot &&
      (options.isolation !== "worktree" || options.worktreeBase !== undefined)
    )
      throw new Error("worktree_snapshot requires isolation: worktree without worktree_base.");
    if (options.runner === "rpc") requireProcessRunner(pi.events);
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: options.invocation,
    };
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ id, args });
      record.readyPromise = new Promise<void>((resolve) => {
        this.readyResolvers.set(id, resolve);
      });
      return id;
    }

    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
  ) {
    record.status = "running";
    record.worktreeActive = options.isolation === "worktree";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    // Unblock any caller waiting on readyPromise
    const readyResolve = this.readyResolvers.get(id);
    if (readyResolve) {
      this.readyResolvers.delete(id);
      record.readyPromise = undefined;
      readyResolve();
    }
    this.onStart?.(record);

    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
    };

    const sourceCwd = options.cwd ?? ctx.cwd;
    record.completionPending = true;
    const promise = (async () => {
      let worktreeCwd: string | undefined;
      if (options.isolation === "worktree") {
        const wt = options.worktreeSnapshot
          ? await createSnapshotWorktree(sourceCwd, id, options.worktreeSnapshot)
          : await createWorktree(sourceCwd, id, options.worktreeBase);
        record.worktree = wt;
        worktreeCwd = wt.path;
      }
      if (options.runner === "rpc") {
        if (options.isolated) throw new Error("RPC_PROTECTION_OPT_OUT_FORBIDDEN");
        const tools = getToolNamesForType(type).filter(
          (name) =>
            pi.getActiveTools().includes(name) &&
            !getAgentConfig(type)?.disallowedTools?.includes(name),
        );
        if (!getAgentConfig(type)?.readOnly) {
          const registered = pi.getAllTools().map((t) => t.name);
          for (const name of [
            ...PARENT_AGENT_TOOL_NAMES,
            ...SUBAGENT_CONTEXT_TOOL_NAMES,
            "send_agent_message",
            "reply_agent_message",
            "list_agent_group",
          ])
            if (
              registered.includes(name) &&
              !getAgentConfig(type)?.disallowedTools?.includes(name) &&
              !tools.includes(name)
            )
              tools.push(name);
        }
        let turns = 0;
        const processRunner = requireProcessRunner(pi.events);
        this.processRunners.set(id, processRunner);
        const result = await processRunner.execute({
          taskId: id,
          prompt: (options.inheritContext ? buildParentContext(ctx) : "") + prompt,
          roleInstructions: getAgentConfig(type)?.systemPrompt,
          cwd: worktreeCwd ?? sourceCwd,
          role: {
            name: type,
            readOnly:
              getAgentConfig(type)?.readOnly ??
              tools.every((name) => ["read", "grep", "find", "ls"].includes(name)),
            allowedTools: tools,
          },
          model: options.model
            ? { provider: options.model.provider, id: options.model.id }
            : undefined,
          thinking: options.thinkingLevel,
          limits: {
            ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
            ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
          },
          signal: record.abortController!.signal,
          onIdentity: (identity) => {
            record.process = identity;
            if (
              [
                "question",
                "result-pending",
                "cleanup-pending",
                "cleanup-error",
                "detached",
              ].includes(identity.phase ?? "")
            )
              record.status = "waiting";
            else if (["lost", "uncertain"].includes(identity.phase ?? "")) record.status = "error";
            else if (["starting", "running"].includes(identity.phase ?? ""))
              record.status = "running";
          },
          onEvent: (event) => {
            if (event.type === "process_identity_uncertain" && record.process) {
              record.process = { ...record.process, phase: "uncertain" };
              record.status = "error";
            }
            if (event.type === "process_ownership_changed") record.status = "waiting";
            options.onProcessEvent?.(event);
            pi.events.emit("subagents:process_event", { identity: record.process, event });
            if (event.type === "turn_end") options.onTurnEnd?.(++turns);
            const e = event as import("@mariozechner/pi-coding-agent").AgentSessionEvent;
            if (e.type === "tool_execution_start" || e.type === "tool_execution_end") {
              if (e.type === "tool_execution_end") record.toolUses++;
              options.onToolActivity?.({
                type: e.type === "tool_execution_start" ? "start" : "end",
                toolName: e.toolName,
              });
            }
            if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
              options.onTextDelta?.(
                e.assistantMessageEvent.delta,
                e.assistantMessageEvent.partial.content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join(""),
              );
            if (e.type === "message_end" && e.message.role === "assistant") {
              addUsage(record.lifetimeUsage, e.message.usage);
              options.onAssistantUsage?.(e.message.usage);
            }
            if (e.type === "compaction_end" && !e.aborted && e.result) {
              const info = { reason: e.reason, tokensBefore: e.result.tokensBefore };
              record.compactionCount++;
              this.onCompact?.(record, info);
              options.onCompaction?.(info);
            }
          },
        });
        this.processResumes.set(id, result.resume);
        record.resultDelivery = result.delivery;
        return {
          responseText: result.responseText,
          session: undefined,
          aborted: false,
          steered: false,
          timedOut: false,
        };
      }
      return runAgent(ctx, type, prompt, {
        pi,
        agentId: id,
        graceTurns: this.graceTurns,
        model: options.model,
        maxTurns: options.maxTurns,
        timeoutSeconds: options.timeoutSeconds,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        thinkingLevel: options.thinkingLevel,
        cwd: worktreeCwd ?? sourceCwd,
        signal: record.abortController!.signal,
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options.onToolActivity?.(activity);
        },
        onTurnEnd: options.onTurnEnd,
        onTextDelta: options.onTextDelta,
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          options.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options.onCompaction?.(info);
        },
        onSessionCreated: (session) => {
          record.session = session;
          if (record.pendingSteers?.length) {
            for (const msg of record.pendingSteers) {
              session.steer(msg).catch(() => {});
            }
            record.pendingSteers = undefined;
          }
          options.onSessionCreated?.(session);
        },
      });
    })() // end async IIFE (worktree setup + runAgent)
      .then(async ({ responseText, session, aborted, steered, timedOut }) => {
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
          if (record.resultDelivery && !record.resultDelivery.ingested) record.status = "waiting";
          if (record.process && record.process.phase !== "completed")
            record.status = ["lost", "uncertain"].includes(record.process.phase ?? "")
              ? "error"
              : "waiting";
        }
        record.timedOut = timedOut;
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();
        detach();

        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {
            /* ignore */
          }
          record.outputCleanup = undefined;
        }

        if (record.worktree) {
          record.worktreeResult = await inspectWorktree(record.worktree);
        }
        record.worktreeActive = false;

        if (options.isBackground) {
          this.runningBackground--;
          try {
            this.onComplete?.(record);
          } catch {
            /* ignore */
          }
          this.drainQueue();
        }
        return responseText;
      })
      .catch(async (err) => {
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        detach();

        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {
            /* ignore */
          }
          record.outputCleanup = undefined;
        }

        if (record.worktree) {
          record.worktreeResult = await inspectWorktree(record.worktree);
        }
        record.worktreeActive = false;

        if (record.outputFile) {
          appendErrorEntry(record.outputFile, id, record.error, sourceCwd);
        }

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      })
      .finally(() => {
        record.completionPending = false;
        pi.events.emit(MANAGED_CHANGED_EVENT, {});
      });

    record.promise = promise;
  }

  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        const readyResolve = this.readyResolvers.get(next.id);
        if (readyResolve) {
          this.readyResolvers.delete(next.id);
          record.readyPromise = undefined;
          readyResolve();
        }
        this.onComplete?.(record);
      }
    }
  }

  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      isBackground: false,
    });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  async resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record || (!record.session && !this.processResumes.has(id))) return undefined;
    if (record.worktreeActive || record.status === "running" || record.status === "waiting")
      return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.worktreeResult = undefined;
    record.worktreeActive = !!record.worktree;

    try {
      record.abortController = new AbortController();
      const onAbort = () => record.abortController!.abort();
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let responseText: string;
      try {
        const resume = this.processResumes.get(id);
        if (resume) {
          const result = await resume(prompt, record.abortController.signal);
          this.processResumes.set(id, result.resume);
          record.resultDelivery = result.delivery;
          responseText = result.responseText;
        } else {
          responseText = await resumeAgent(record.session!, prompt, {
            onToolActivity: (activity) => {
              if (activity.type === "end") record.toolUses++;
            },
            onAssistantUsage: (usage) => {
              addUsage(record.lifetimeUsage, usage);
            },
            onCompaction: (info) => {
              record.compactionCount++;
              this.onCompact?.(record, info);
            },
            signal,
          });
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if ((record.status as AgentRecord["status"]) !== "stopped")
        record.status =
          record.resultDelivery && !record.resultDelivery.ingested ? "waiting" : "completed";
      if (record.process && record.process.phase !== "completed")
        record.status = ["lost", "uncertain"].includes(record.process.phase ?? "")
          ? "error"
          : "waiting";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    if (record.worktree) record.worktreeResult = await inspectWorktree(record.worktree);
    record.worktreeActive = false;
    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.process) {
      try {
        const current = this.processRunners
          .get(id)
          ?.inspect?.(record.process as import("./process-lifecycle.ts").ProcessHandle);
        if (!current || current.ownership !== "managed") return false;
      } catch {
        return false;
      }
    }

    if (record.status === "queued") {
      this.queue = this.queue.filter((q) => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      const readyResolve = this.readyResolvers.get(id);
      if (readyResolve) {
        this.readyResolvers.delete(id);
        record.readyPromise = undefined;
        readyResolve();
      }
      return true;
    }

    if (record.status === "waiting") {
      if (record.process) {
        record.abortController?.abort();
        if (
          ["result-pending", "cleanup-pending", "cleanup-error"].includes(
            record.process.phase ?? "",
          )
        )
          void this.processRunners
            .get(id)
            ?.abort?.(record.process as import("./process-lifecycle.ts").ProcessHandle)
            .catch((error) => {
              record.status = "error";
              record.error = error instanceof Error ? error.message : String(error);
            });
      }
      const resolve = record.helpResolver;
      record.helpResolver = undefined;
      record.helpMessage = undefined;
      record.status = "stopped";
      record.completedAt = Date.now();
      resolve?.("[cancelled: agent was stopped]");
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    // A stopped status acknowledges cancellation; the execution may still own the worktree.
    if (record.worktreeActive) return;
    if (record.process && record.process.phase !== "completed") return;
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
    this.processResumes.delete(id);
    this.processRunners.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || record.status === "waiting")
        continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || record.status === "waiting")
        continue;
      this.removeRecord(id, record);
    }
  }

  hasRunning(): boolean {
    return [...this.agents.values()].some(
      (r) => r.status === "running" || r.status === "queued" || r.status === "waiting",
    );
  }

  abortAll(): number {
    let count = 0;
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        const readyResolve = this.readyResolvers.get(queued.id);
        if (readyResolve) {
          this.readyResolvers.delete(queued.id);
          record.readyPromise = undefined;
          readyResolve();
        }
        count++;
      }
    }
    this.queue = [];
    for (const record of this.agents.values()) {
      if (record.status === "waiting") {
        if (record.process) {
          if (this.abort(record.id)) count++;
          continue;
        }
        const resolve = record.helpResolver;
        record.helpResolver = undefined;
        record.helpMessage = undefined;
        record.status = "stopped";
        record.completedAt = Date.now();
        resolve?.("[cancelled: all agents stopped]");
        count++;
      } else if (record.status === "running") {
        if (record.process) {
          if (this.abort(record.id)) count++;
          continue;
        }
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  async waitForAll(): Promise<void> {
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter((r) => r.status === "running" || r.status === "queued" || r.status === "waiting")
        .filter((r) => !(r.process && r.completedAt !== undefined))
        .map((r) => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    this.processResumes.clear();
    this.processRunners.clear();
  }
}
