/**
 * worktree.ts — Git worktree isolation for agents.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function formatCommandError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const commandError = error as { stderr?: unknown; message?: unknown };
    const stderr =
      typeof commandError.stderr === "string" ? commandError.stderr.trim() : "";
    if (stderr) return stderr;
    if (typeof commandError.message === "string") return commandError.message;
  }
  return String(error);
}

function worktreeSetupError(
  cwd: string,
  command: string[],
  error: unknown,
): Error {
  return new Error(
    [
      `Cannot create an isolated worktree from ${cwd}.`,
      `Failed command: git ${command.join(" ")}`,
      `Git error: ${formatCommandError(error)}`,
      "Hint: pass cwd pointing to a Git repository with at least one commit, or omit worktree isolation. Worktree isolation starts from HEAD and does not include uncommitted or untracked changes.",
    ].join("\n"),
  );
}

export async function createWorktree(
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo> {
  const verifyCommand = ["rev-parse", "--is-inside-work-tree"];
  try {
    await execFileAsync("git", verifyCommand, { cwd, timeout: 5000 });
  } catch (error) {
    throw worktreeSetupError(cwd, verifyCommand, error);
  }

  const headCommand = ["rev-parse", "HEAD"];
  try {
    await execFileAsync("git", headCommand, { cwd, timeout: 5000 });
  } catch (error) {
    throw worktreeSetupError(cwd, headCommand, error);
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);
  const addCommand = ["worktree", "add", "--detach", worktreePath, "HEAD"];

  try {
    await execFileAsync("git", addCommand, { cwd, timeout: 30000 });
    return { path: worktreePath, branch };
  } catch (error) {
    throw worktreeSetupError(cwd, addCommand, error);
  }
}

export async function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: worktree.path, timeout: 10000 },
    );
    const status = stdout.trim();

    if (!status) {
      await removeWorktree(cwd, worktree.path);
      return { hasChanges: false };
    }

    await execFileAsync("git", ["add", "-A"], {
      cwd: worktree.path,
      timeout: 10000,
    });
    const safeDesc = agentDescription.slice(0, 200);
    await execFileAsync("git", ["commit", "-m", `pi-agent: ${safeDesc}`], {
      cwd: worktree.path,
      timeout: 10000,
    });

    let branchName = worktree.branch;
    try {
      await execFileAsync("git", ["branch", branchName], {
        cwd: worktree.path,
        timeout: 5000,
      });
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      await execFileAsync("git", ["branch", branchName], {
        cwd: worktree.path,
        timeout: 5000,
      });
    }

    await removeWorktree(cwd, worktree.path);

    return { hasChanges: true, branch: branchName, path: worktree.path };
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

async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd, timeout: 10000 },
    );
  } catch {
    try {
      await execFileAsync("git", ["worktree", "prune"], {
        cwd,
        timeout: 5000,
      });
    } catch {
      /* ignore */
    }
  }
}

export async function pruneWorktrees(cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "prune"], {
      cwd,
      timeout: 5000,
    });
  } catch {
    /* ignore */
  }
}
