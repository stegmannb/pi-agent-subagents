import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentCwd } from "./cwd.ts";
import { appendErrorEntry, writeInitialEntry } from "./output-file.ts";
import { cleanupWorktree, createWorktree } from "./worktree.ts";

const execFileAsync = promisify(execFile);

async function makeTempDir(prefix: string): Promise<string> {
  const root = tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("resolveAgentCwd resolves relative, absolute, and @-prefixed paths", () => {
  assert.equal(resolveAgentCwd("/workspace", undefined), "/workspace");
  assert.equal(resolveAgentCwd("/workspace", "repo"), "/workspace/repo");
  assert.equal(resolveAgentCwd("/workspace", "/tmp/repo"), "/tmp/repo");
  assert.equal(resolveAgentCwd("/workspace", "@repo"), "/workspace/repo");
});

test("createWorktree reports the cwd and underlying Git error", async () => {
  const cwd = await makeTempDir("pi-subagents-non-repo-");

  try {
    await assert.rejects(createWorktree(cwd, "test-agent"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.message, /git rev-parse --is-inside-work-tree/);
      assert.match(error.message, /not a git repository/i);
      assert.match(error.message, /pass cwd pointing to a Git repository/i);
      assert.match(error.message, /does not include uncommitted or untracked changes/i);
      return true;
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("appendErrorEntry records setup failures in the transcript", async () => {
  const cwd = await makeTempDir("pi-subagents-transcript-");
  const path = join(cwd, "agent.output");

  try {
    writeInitialEntry(path, "test-agent", "Review changes", cwd);
    appendErrorEntry(path, "test-agent", "worktree setup failed", cwd);

    const entries = (await readFile(path, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.equal(entries[1].type, "error");
    assert.equal(entries[1].error, "worktree setup failed");
    assert.equal(entries[1].cwd, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createWorktree creates and cleans up a detached worktree from HEAD", async () => {
  const cwd = await makeTempDir("pi-subagents-repo-");
  let worktreePath: string | undefined;

  try {
    await git(cwd, ["init"]);
    await writeFile(join(cwd, "README.md"), "fixture\n", "utf-8");
    await git(cwd, ["add", "README.md"]);
    await git(cwd, [
      "-c",
      "user.name=Pi Subagents Test",
      "-c",
      "user.email=pi-subagents@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);

    const sourceHead = await git(cwd, ["rev-parse", "HEAD"]);
    const worktree = await createWorktree(cwd, "test-agent");
    worktreePath = worktree.path;

    assert.equal(await git(worktree.path, ["rev-parse", "HEAD"]), sourceHead);
    assert.equal(await git(worktree.path, ["status", "--porcelain"]), "");

    const result = await cleanupWorktree(cwd, worktree, "test cleanup");
    assert.deepEqual(result, { hasChanges: false });
    worktreePath = undefined;
  } finally {
    if (worktreePath) {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd,
      }).catch(() => undefined);
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
