/**
 * types.ts — Type definitions for the subagent system.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { WorktreeInfo, WorktreeStatus } from "./worktree.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SubagentType = string;

export type IsolationMode = "worktree";

export type JoinMode = "async" | "group" | "smart";

export interface CompletionReport {
  summary: string;
  status: "success" | "partial" | "failed";
  artifacts?: string[];
}

export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  readOnly?: boolean;
  disallowedTools?: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  timeoutSeconds?: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
  isDefault?: boolean;
  enabled?: boolean;
  source?: "default" | "project" | "global";
}

export interface AgentInvocation {
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  timeoutSeconds?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolation?: IsolationMode;
  cwd?: string;
  worktreeBase?: string;
}

export type LifetimeUsage = {
  input: number;
  output: number;
  cacheWrite: number;
};

export interface AgentRecord {
  process?: import("./process-contract.ts").ProcessObservation;
  id: string;
  type: SubagentType;
  description: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "steered"
    | "aborted"
    | "stopped"
    | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  groupId?: string;
  joinMode?: JoinMode;
  resultConsumed?: boolean;
  pendingSteers?: string[];
  worktree?: WorktreeInfo;
  worktreeResult?: WorktreeStatus;
  worktreeActive?: boolean;
  toolCallId?: string;
  outputFile?: string;
  outputCleanup?: () => void;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  invocation?: AgentInvocation;
  timedOut?: boolean;
  helpResolver?: (response: string) => void;
  helpMessage?: string;
  completionReport?: CompletionReport;
  readyPromise?: Promise<void>;
}

export interface HelpRequestDetails {
  agentId: string;
  description: string;
  message: string;
}

export interface NotificationDetails {
  worktree?: WorktreeStatus;
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  reportStatus?: "success" | "partial" | "failed";
  artifacts?: string[];
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
