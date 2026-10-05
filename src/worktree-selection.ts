/**
 * worktree-selection.ts — Reject invalid Agent worktree selections.
 *
 * Messages are returned, not thrown: the Agent tool turns them into hard tool
 * errors so the model corrects its arguments, and AgentManager keeps the throw
 * as a defensive backstop. Each message names every offending parameter and the
 * complete correction, because a message that named only one of several
 * conflicts invited another failing retry, and the earlier "requires a new
 * Agent with isolation" wording was read as an extra requirement to satisfy
 * rather than a conflict to resolve.
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
  const names = [
    ...(base !== undefined ? ["worktree_base"] : []),
    ...(snapshot !== undefined ? ["worktree_snapshot"] : []),
  ];
  if (names.length === 0) return undefined;

  const provided = names.join(" and ");
  const problems: string[] = [];
  if (names.length === 2)
    problems.push("worktree_base and worktree_snapshot are mutually exclusive, both were provided");
  if (resume !== undefined) {
    problems.push(`${provided} cannot be combined with resume`);
  } else if (isolation !== "worktree") {
    problems.push(
      `${provided} ${names.length === 2 ? "require" : "requires"} isolation: "worktree"`,
    );
  }
  if (problems.length === 0) return undefined;

  return `Agent call rejected: ${problems.join("; ")}. ${correction(names, resume, isolation)}`;
}

function correction(
  names: string[],
  resume: string | undefined,
  isolation: IsolationMode | undefined,
): string {
  const provided = names.join(" and ");
  if (resume !== undefined)
    return `A resumed agent keeps its existing workspace: remove ${provided} from the call, then retry.`;
  if (names.length === 2)
    return `Keep one of them${isolation === "worktree" ? "" : ' and add isolation: "worktree"'} for the new worktree: worktree_base for an existing ref, worktree_snapshot for current working changes. Then retry.`;
  return `Add isolation: "worktree" or remove ${provided}, then retry.`;
}
