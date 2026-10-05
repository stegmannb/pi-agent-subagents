/**
 * worktree-selection.ts — Reject invalid Agent worktree selections.
 *
 * Messages are returned, not thrown: the Agent tool reports them as hard tool
 * errors so the model fixes its arguments, and AgentManager throws them as a
 * defensive backstop. The message names the offending parameters — the earlier
 * "requires a new Agent with isolation" wording was read as an extra
 * requirement to satisfy instead of a conflict to resolve.
 */

import type { IsolationMode } from "./types.ts";

export interface WorktreeSelection {
  isolation?: IsolationMode;
  resume?: string;
  worktree_base?: string;
  worktree_snapshot?: unknown;
}

export function worktreeSelectionError(selection: WorktreeSelection): string | undefined {
  const { isolation, resume, worktree_base: base, worktree_snapshot: snapshot } = selection;
  if (base !== undefined && snapshot !== undefined)
    return "Agent call rejected: worktree_base and worktree_snapshot are mutually exclusive and both were provided. Keep worktree_base for a worktree from an existing ref, or worktree_snapshot for current working changes — never both. Correct the arguments and retry.";
  if (base !== undefined && resume)
    return "Agent call rejected: worktree_base cannot be combined with resume. Resume reuses the existing workspace. Remove worktree_base and retry.";
  if (snapshot !== undefined && resume)
    return "Agent call rejected: worktree_snapshot cannot be combined with resume. Resume reuses the existing workspace. Remove worktree_snapshot and retry.";
  if (base !== undefined && isolation !== "worktree")
    return 'Agent call rejected: worktree_base requires isolation: "worktree". Add isolation: "worktree" or remove worktree_base, then retry.';
  if (snapshot !== undefined && isolation !== "worktree")
    return 'Agent call rejected: worktree_snapshot requires isolation: "worktree". Add isolation: "worktree" or remove worktree_snapshot, then retry.';
  return undefined;
}
