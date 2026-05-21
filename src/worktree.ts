/**
 * worktree.ts — Git worktree isolation for agents.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branch?: string;
  path?: string;
  /** Set when a git operation failed and the worktree was preserved for manual recovery. */
  worktreeError?: string;
}

export function createWorktree(
  cwd: string,
  agentId: string,
): WorktreeInfo | undefined {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", worktreePath, "HEAD"],
      { cwd, stdio: "pipe", timeout: 30000 },
    );
    return { path: worktreePath, branch };
  } catch {
    return undefined;
  }
}

export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    })
      .toString()
      .trim();

    if (!status) {
      removeWorktree(cwd, worktree.path);
      return { hasChanges: false };
    }

    execFileSync("git", ["add", "-A"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    });
    const safeDesc = agentDescription.slice(0, 200);
    execFileSync("git", ["commit", "-m", `pi-agent: ${safeDesc}`], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    });

    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    }
    worktree.branch = branchName;

    removeWorktree(cwd, worktree.path);

    return { hasChanges: true, branch: worktree.branch, path: worktree.path };
  } catch (err) {
    // Do NOT remove the worktree — preserve it so the user can recover their work.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      hasChanges: false,
      path: worktree.path,
      worktreeError: `Git operation failed; work preserved at ${worktree.path} — ${reason}`,
    };
  }
}

function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd, stdio: "pipe", timeout: 10000 },
    );
  } catch {
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      /* ignore */
    }
  }
}

export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    /* ignore */
  }
}
