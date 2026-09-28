/** Git worktrees retained until an explicit, checked cleanup. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SnapshotInfo {
  parentPath: string;
  parentHead: string;
  ref: string;
  excludePaths: string[];
  untrackedPaths: string[];
}

export interface WorktreeInfo {
  /** Git's real per-worktree administrative directory. */
  id: string;
  path: string;
  baseCommit: string;
  snapshot?: SnapshotInfo;
}

export interface WorktreeStatus extends WorktreeInfo {
  exists: boolean;
  headCommit?: string;
  /** Present only when HEAD names an actual branch. */
  branch?: string;
  hasUncommittedChanges?: boolean;
  hasCommits?: boolean;
  hasChanges?: boolean;
  worktreeError?: string;
}

export interface WorktreeCleanupResult extends WorktreeStatus {
  removed: boolean;
}

interface Registration extends WorktreeInfo {
  agentId: string;
  commonDir: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim();
}

function reason(error: unknown): string {
  const e = error as { stderr?: string; message?: string };
  return e?.stderr?.trim() || e?.message || String(error);
}

async function commonDir(cwd: string): Promise<string> {
  return realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

export async function createWorktree(
  cwd: string,
  agentId: string,
  base = "HEAD",
): Promise<WorktreeInfo> {
  let command = ["rev-parse", "--is-inside-work-tree"];
  let path: string | undefined;
  try {
    if ((await git(cwd, command)) !== "true") throw new Error("cwd is not a working tree");
    command = ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`];
    const baseCommit = await git(cwd, command);
    const common = await commonDir(cwd);
    // Store outside temporary directories and outside the parent's tracked files.
    const root = join(common, "pi-agent-worktrees");
    await mkdir(root, { recursive: true });
    path = join(root, randomUUID());
    command = ["worktree", "add", "--detach", path, baseCommit];
    await git(cwd, command);
    path = await realpath(path);
    const id = await realpath(await git(path, ["rev-parse", "--absolute-git-dir"]));
    const registration: Registration = { id, path, baseCommit, agentId, commonDir: common };
    await writeFile(join(id, "pi-subagents.json"), JSON.stringify(registration), { flag: "wx" });
    return { id, path, baseCommit };
  } catch (error) {
    throw new Error(
      [
        `Cannot create an isolated worktree from ${cwd}.`,
        `Failed command: git ${command.join(" ")}`,
        `Git error: ${reason(error)}`,
        path ? `Any partially created worktree is preserved at ${path}.` : "",
        "Hint: pass cwd pointing to a Git repository with at least one commit and an existing base. Worktree isolation does not include uncommitted or untracked changes.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/** Check the registration against Git identity, not a caller-supplied path alone. */
async function registered(worktree: WorktreeInfo): Promise<Registration> {
  const registration: Registration = JSON.parse(
    await readFile(join(worktree.id, "pi-subagents.json"), "utf8"),
  );
  for (const key of ["id", "path", "baseCommit"] as const) {
    if (registration[key] !== worktree[key])
      throw new Error(`Worktree registration mismatch: ${key}`);
  }
  if ((await lstat(worktree.path)).isSymbolicLink()) throw new Error("Worktree path is a symlink");
  if (
    (await realpath(worktree.path)) !== worktree.path ||
    (await realpath(await git(worktree.path, ["rev-parse", "--absolute-git-dir"]))) !==
      worktree.id ||
    (await commonDir(worktree.path)) !== registration.commonDir ||
    (await realpath(await git(worktree.path, ["rev-parse", "--show-toplevel"]))) !== worktree.path
  ) {
    throw new Error("Worktree identity no longer matches its registration");
  }
  return registration;
}

/** Reload an owned worktree after its parent session has ended. */
export async function loadWorktree(path: string): Promise<WorktreeInfo> {
  const canonicalPath = await realpath(path);
  const id = await realpath(await git(canonicalPath, ["rev-parse", "--absolute-git-dir"]));
  const saved: Registration = JSON.parse(await readFile(join(id, "pi-subagents.json"), "utf8"));
  const worktree = {
    id,
    path: canonicalPath,
    baseCommit: saved.baseCommit,
    ...(saved.snapshot ? { snapshot: saved.snapshot } : {}),
  };
  await registered(worktree);
  return worktree;
}

/** Read-only on every lifecycle path, including failure and abort. */
export async function inspectWorktree(worktree: WorktreeInfo): Promise<WorktreeStatus> {
  let exists = false;
  try {
    await lstat(worktree.path);
    exists = true;
    await registered(worktree);
    const headCommit = await resolveCommit(worktree.path, "HEAD");
    // Include ignored files: explicit cleanup must not discard local build/output files either.
    const status = await git(worktree.path, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored",
    ]);
    const branchRef = await git(worktree.path, ["rev-parse", "--symbolic-full-name", "HEAD"]);
    const branch = branchRef.startsWith("refs/heads/") ? branchRef.slice(11) : undefined;
    const hasUncommittedChanges = status.length > 0;
    const hasCommits = headCommit !== worktree.baseCommit;
    return {
      ...worktree,
      exists,
      headCommit,
      branch,
      hasUncommittedChanges,
      hasCommits,
      hasChanges: hasUncommittedChanges || hasCommits,
    };
  } catch (error) {
    return { ...worktree, exists, worktreeError: `Cannot inspect worktree: ${reason(error)}` };
  }
}

/** No force override. Stop the child before calling this explicit operation. */
export async function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
): Promise<WorktreeCleanupResult> {
  const status = await inspectWorktree(worktree);
  try {
    if (status.worktreeError) throw new Error(status.worktreeError);
    const registration = await registered(worktree);
    if ((await commonDir(cwd)) !== registration.commonDir)
      throw new Error("Worktree belongs to another repository");
    if ((await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]))) === worktree.path) {
      throw new Error("Cleanup requires a separate integration checkout, not the child worktree");
    }
    if (status.hasUncommittedChanges) throw new Error("Worktree has uncommitted or ignored files");
    // Conservative V1: only ancestry proves integration. Squash/cherry-pick equivalence does not.
    if (status.hasCommits) {
      const integratedHead = await resolveCommit(cwd, "HEAD");
      try {
        await git(cwd, ["merge-base", "--is-ancestor", status.headCommit!, integratedHead]);
      } catch {
        throw new Error("Worktree commits are not integrated into the cleanup caller's HEAD");
      }
    }
    await git(cwd, ["worktree", "remove", worktree.path]);
    return { ...status, exists: false, removed: true };
  } catch (error) {
    return {
      ...status,
      removed: false,
      worktreeError: `Cleanup refused; no work removed: ${reason(error)}`,
    };
  }
}

export function formatWorktreeStatus(status: WorktreeStatus): string {
  return [
    `Worktree: ${status.path} (${status.exists ? "retained" : "missing"})`,
    `Worktree ID: ${status.id}`,
    `Base: ${status.baseCommit}`,
    status.snapshot
      ? `Snapshot parent: ${status.snapshot.parentHead}; child delta base: ${status.baseCommit}`
      : undefined,
    `Head: ${status.headCommit ?? "unknown"} (${status.branch ?? (status.headCommit ? "detached" : "unknown")})`,
    `Changes: ${status.hasUncommittedChanges === undefined ? "unknown" : status.hasUncommittedChanges ? "uncommitted" : "clean"}; commits beyond base: ${status.hasCommits === undefined ? "unknown" : status.hasCommits ? "yes" : "no"}`,
    status.worktreeError,
  ]
    .filter(Boolean)
    .join("\n");
}

export { createSnapshotWorktree, integrateSnapshotWorktree } from "./worktree-snapshot.ts";
export type { SnapshotOptions, IntegrationResult } from "./worktree-snapshot.ts";
