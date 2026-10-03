import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentCwd } from "./cwd.ts";
import { appendErrorEntry, writeInitialEntry } from "./output-file.ts";
import {
  cleanupWorktree,
  createWorktree,
  inspectWorktree,
  loadWorktree,
  formatWorktreeStatus,
} from "./worktree.ts";

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

async function fixture(t: import("node:test").TestContext) {
  const cwd = await makeTempDir("pi-subagents-repo-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.name", "Pi Test"]);
  await git(cwd, ["config", "user.email", "pi@example.invalid"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(cwd, "tracked"), "initial\n");
  await writeFile(join(cwd, ".gitignore"), "ignored\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

async function snapshot(cwd: string) {
  return {
    head: await git(cwd, ["rev-parse", "HEAD"]),
    branch: await git(cwd, ["symbolic-ref", "HEAD"]),
    index: await readFile(join(cwd, ".git/index")),
    status: await git(cwd, ["status", "--porcelain=v1"]),
    diff: await git(cwd, ["diff", "HEAD"]),
    tracked: await readFile(join(cwd, "tracked")),
  };
}

test("a changed action identity immediately before Git removal retains the inspected worktree", async (t) => {
  const cwd = await fixture(t);
  const worktree = await createWorktree(cwd, "identity-race");
  const result = await cleanupWorktree(cwd, worktree, () => {
    throw new Error("PROCESS_IDENTITY_UNPROVEN");
  });
  assert.equal(result.removed, false);
  assert.match(result.worktreeError!, /PROCESS_IDENTITY_UNPROVEN/);
  assert.equal((await inspectWorktree(worktree)).exists, true);
  assert.equal(await readFile(join(worktree.path, "tracked"), "utf8"), "initial\n");
  assert.equal((await cleanupWorktree(cwd, worktree)).removed, true);
});

test("default HEAD is fixed, detached, registered, retained and explicitly removable", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "tracked"), "staged parent\n");
  await git(cwd, ["add", "tracked"]);
  await writeFile(join(cwd, "tracked"), "unstaged parent\n");
  await writeFile(join(cwd, "untracked"), "parent only\n");
  const before = await snapshot(cwd);
  const wt = await createWorktree(cwd, "../unsafe agent ID");
  assert.equal(wt.baseCommit, before.head);
  assert.equal(wt.id, await git(wt.path, ["rev-parse", "--absolute-git-dir"]));
  assert.deepEqual(await loadWorktree(wt.path), wt);
  assert.equal(await readFile(join(wt.path, "tracked"), "utf8"), "initial\n");
  const status = await inspectWorktree(wt);
  assert.equal(status.exists, true);
  assert.equal(status.hasChanges, false);
  assert.equal(status.branch, undefined);
  assert.equal(status.headCommit, before.head);
  assert.match(formatWorktreeStatus(status), /clean; commits beyond base: no/);
  assert.equal((await cleanupWorktree(cwd, wt)).removed, true);
  const repeated = await cleanupWorktree(cwd, wt);
  assert.equal(repeated.removed, false);
  assert.equal(repeated.exists, false);
  assert.match(repeated.worktreeError!, /Cleanup refused/);
  assert.deepEqual(await snapshot(cwd), before);
});

test("explicit branch and commit resolve before creation and do not follow later ref movement", async (t) => {
  const cwd = await fixture(t);
  const base = await git(cwd, ["rev-parse", "HEAD"]);
  await git(cwd, ["branch", "chosen-base"]);
  await writeFile(join(cwd, "tracked"), "next\n");
  await git(cwd, ["commit", "-am", "next"]);
  for (const ref of ["chosen-base", base]) {
    const wt = await createWorktree(cwd, "agent", ref);
    assert.equal(wt.baseCommit, base);
    assert.equal((await inspectWorktree(wt)).headCommit, base);
  }
  await git(cwd, ["branch", "-f", "chosen-base", "HEAD"]);
  const paths = await git(cwd, ["worktree", "list", "--porcelain"]);
  assert.equal(paths.split(`HEAD ${base}`).length - 1, 2);
});

test("invalid bases fail before allocating a worktree", async (t) => {
  const cwd = await fixture(t);
  const before = await git(cwd, ["worktree", "list", "--porcelain"]);
  for (const base of ["missing", "--help", "HEAD:tracked", ""]) {
    await assert.rejects(createWorktree(cwd, "agent", base), /Cannot create an isolated worktree/);
  }
  assert.equal(await git(cwd, ["worktree", "list", "--porcelain"]), before);
});

for (const mode of ["staged", "unstaged", "untracked", "ignored"]) {
  test(`${mode} child files survive inspection and refused cleanup without touching parent`, async (t) => {
    const cwd = await fixture(t);
    const before = await snapshot(cwd);
    const wt = await createWorktree(cwd, "agent");
    const name = mode === "staged" || mode === "unstaged" ? "tracked" : mode;
    await writeFile(join(wt.path, name), "child work\n");
    if (mode === "staged") await git(wt.path, ["add", name]);
    const childIndex = await readFile(join(wt.id, "index"));
    const status = await inspectWorktree(wt);
    assert.equal(status.hasUncommittedChanges, true);
    assert.equal(status.hasChanges, true);
    assert.equal((await cleanupWorktree(cwd, wt)).removed, false);
    assert.equal(await readFile(join(wt.path, name), "utf8"), "child work\n");
    assert.equal(await git(wt.path, ["rev-parse", "HEAD"]), wt.baseCommit);
    assert.deepEqual(await readFile(join(wt.id, "index")), childIndex);
    assert.deepEqual(await snapshot(cwd), before);
  });
}

test("clean detached child commits are retained until ancestry proves manual integration", async (t) => {
  const cwd = await fixture(t);
  const before = await snapshot(cwd);
  const wt = await createWorktree(cwd, "agent");
  await writeFile(join(wt.path, "tracked"), "committed child work\n");
  await git(wt.path, ["commit", "-am", "child"]);
  const status = await inspectWorktree(wt);
  assert.equal(status.hasUncommittedChanges, false);
  assert.equal(status.hasCommits, true);
  assert.equal(status.hasChanges, true);
  assert.equal(status.branch, undefined);
  assert.equal((await cleanupWorktree(wt.path, wt)).removed, false);
  await mkdir(join(wt.path, "subdir"));
  assert.equal((await cleanupWorktree(join(wt.path, "subdir"), wt)).removed, false);
  const refused = await cleanupWorktree(cwd, wt);
  assert.equal(refused.removed, false);
  assert.match(refused.worktreeError!, /not integrated/);
  assert.deepEqual(await snapshot(cwd), before);
  await git(wt.path, ["switch", "-c", "child-branch"]);
  assert.equal((await inspectWorktree(wt)).branch, "child-branch");
  // Integration is deliberately manual and outside the lifecycle operation.
  await git(cwd, ["merge", "--ff-only", status.headCommit!]);
  assert.equal((await cleanupWorktree(cwd, wt)).removed, true);
  assert.equal(await git(cwd, ["rev-parse", "child-branch"]), status.headCommit);
});

test("foreign repositories, unknown paths, forged base and substituted worktrees are refused", async (t) => {
  const cwd = await fixture(t);
  const other = await fixture(t);
  const wt = await createWorktree(cwd, "agent");
  assert.equal((await cleanupWorktree(other, wt)).removed, false);
  assert.equal((await cleanupWorktree(cwd, { ...wt, path: other })).removed, false);
  assert.equal((await cleanupWorktree(cwd, { ...wt, baseCommit: "forged" })).removed, false);
  await assert.rejects(loadWorktree(cwd));
  const original = wt.path + "-saved";
  await rename(wt.path, original);
  await symlink(other, wt.path);
  assert.equal((await cleanupWorktree(cwd, wt)).removed, false);
  assert.equal(await readFile(join(other, "tracked"), "utf8"), "initial\n");
});

test("failed Git inspection reports unknown state and preserves files", async (t) => {
  const cwd = await fixture(t);
  const wt = await createWorktree(cwd, "agent");
  await writeFile(join(wt.path, "tracked"), "preserve me\n");
  await rename(join(wt.path, ".git"), join(wt.path, "saved-git"));
  const status = await inspectWorktree(wt);
  assert.equal(status.exists, true);
  assert.equal(status.hasChanges, undefined);
  assert.ok(status.worktreeError);
  assert.equal((await cleanupWorktree(cwd, wt)).removed, false);
  assert.equal(await readFile(join(wt.path, "tracked"), "utf8"), "preserve me\n");
});
