import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createSnapshotWorktree,
  integrateSnapshotWorktree,
  loadWorktree,
  inspectWorktree,
  cleanupWorktree,
} from "./worktree.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (
    await exec("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
  ).stdout.trim();
}
async function fixture(t: import("node:test").TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-snapshot-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init");
  await git(cwd, "config", "user.name", "Test");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "a"), "base a\n");
  await writeFile(join(cwd, "b"), "base b\n");
  await writeFile(join(cwd, ".gitignore"), "ignored/\n");
  await commit(cwd);
  return cwd;
}
async function commit(cwd: string) {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "fixture");
}
async function parentState(cwd: string) {
  return {
    head: await git(cwd, "rev-parse", "HEAD"),
    headBytes: await readFile(join(cwd, ".git/HEAD")),
    branch: await git(cwd, "symbolic-ref", "HEAD"),
    index: await readFile(join(cwd, ".git/index")),
    status: await git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
  };
}
async function missing(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("snapshot captures staged and unstaged raw bytes, with byte-identical parent HEAD/index/status", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "a"), "staged a\n");
  await git(cwd, "add", "a");
  const bytes = Buffer.from([0, 13, 10, 255, 42]);
  await writeFile(join(cwd, "a"), bytes);
  await writeFile(join(cwd, "b"), "unstaged b\n");
  await writeFile(join(cwd, "selected"), "selected\n");
  await writeFile(join(cwd, "unselected"), "private working draft\n");
  const before = await parentState(cwd);
  const worktree = await createSnapshotWorktree(cwd, "child", { untrackedPaths: ["selected"] });
  assert.deepEqual(await parentState(cwd), before);
  assert.deepEqual(await readFile(join(worktree.path, "a")), bytes);
  assert.equal(await readFile(join(worktree.path, "b"), "utf8"), "unstaged b\n");
  assert.equal(await readFile(join(worktree.path, "selected"), "utf8"), "selected\n");
  await missing(join(worktree.path, "unselected"));
  assert.equal(worktree.snapshot?.parentHead, before.head);
  assert.equal(await git(cwd, "rev-parse", `${worktree.baseCommit}^`), before.head);
  assert.equal(await git(cwd, "rev-parse", worktree.snapshot!.ref), worktree.baseCommit);
  assert.deepEqual(await loadWorktree(worktree.path), worktree);
  const status = await inspectWorktree(worktree);
  assert.equal(status.hasChanges, false);
  await writeFile(join(cwd, "b"), "later parent\n");
  assert.equal(await readFile(join(worktree.path, "b"), "utf8"), "unstaged b\n");
});

test("snapshot handles staged rename, deletions, executable and external symlink without dereferencing", async (t) => {
  const cwd = await fixture(t);
  await git(cwd, "mv", "a", "renamed\tfile");
  await rm(join(cwd, "b"));
  await writeFile(join(cwd, "executable"), "#!/bin/sh\n");
  await chmod(join(cwd, "executable"), 0o755);
  await symlink("/outside/nonexistent/secret", join(cwd, "link"));
  await git(cwd, "add", "executable", "link");
  const before = await parentState(cwd);
  const child = await createSnapshotWorktree(cwd, "child");
  assert.deepEqual(await parentState(cwd), before);
  await missing(join(child.path, "a"));
  await missing(join(child.path, "b"));
  assert.equal(await readFile(join(child.path, "renamed\tfile"), "utf8"), "base a\n");
  assert.equal(await readlink(join(child.path, "link")), "/outside/nonexistent/secret");
  assert.ok((await lstat(join(child.path, "executable"))).mode & 0o111);
});

test("tracked secrets and ignored resources are omitted; explicit excluded selections fail closed", async (t) => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, "ignored"));
  await writeFile(join(cwd, "ignored/runtime"), "runtime bytes");
  await writeFile(join(cwd, ".env"), "TOKEN=private\n");
  await writeFile(join(cwd, "private.key"), "key");
  await writeFile(join(cwd, "custom-private"), "private");
  await git(cwd, "add", ".env", "private.key", "custom-private");
  await git(cwd, "add", "-f", "ignored/runtime");
  const child = await createSnapshotWorktree(cwd, "child", { excludePaths: ["custom-private"] });
  for (const path of [".env", "private.key", "custom-private", "ignored/runtime"])
    await missing(join(child.path, path));
  await writeFile(join(cwd, "auth.json"), "credentials");
  for (const path of [".netrc", ".npmrc", "secrets.yaml", ".credentials"]) {
    await writeFile(join(cwd, path), "credential bytes");
    await assert.rejects(
      createSnapshotWorktree(cwd, "child", { untrackedPaths: [path] }),
      /excluded/,
    );
  }
  await assert.rejects(
    createSnapshotWorktree(cwd, "child", { untrackedPaths: ["auth.json"] }),
    /excluded/,
  );
  await writeFile(join(cwd, "ignored/new"), "ignored");
  await assert.rejects(
    createSnapshotWorktree(cwd, "child", { untrackedPaths: ["ignored/new"] }),
    /excluded/,
  );
  for (const path of ["../escape", "/tmp/outside", ".git/config", "ignored"]) {
    await assert.rejects(createSnapshotWorktree(cwd, "child", { untrackedPaths: [path] }));
  }
});

test("submodules and unselected nested repositories are rejected, ignored runtime repos excluded", async (t) => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, "nested"));
  await git(join(cwd, "nested"), "init");
  await assert.rejects(createSnapshotWorktree(cwd, "child"), /Nested repositories/);
  await rm(join(cwd, "nested"), { recursive: true });
  await mkdir(join(cwd, "ignored"));
  await git(join(cwd, "ignored"), "init");
  const child = await createSnapshotWorktree(cwd, "child");
  await missing(join(child.path, "ignored"));
  await git(cwd, "init", "--bare", "nested-bare");
  await assert.rejects(createSnapshotWorktree(cwd, "child"), /Nested repositories/);
  await rm(join(cwd, "nested-bare"), { recursive: true });
  const head = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "update-index", "--add", "--cacheinfo", `160000,${head},module`);
  await assert.rejects(createSnapshotWorktree(cwd, "child"), /Submodules/);
});

test("integration applies only committed child delta and retains inherited parent work, index and child", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "a"), "parent staged\n");
  await git(cwd, "add", "a");
  await writeFile(join(cwd, "b"), "parent unstaged\n");
  const before = await parentState(cwd);
  const child = await createSnapshotWorktree(cwd, "child");
  await writeFile(join(child.path, "a"), "child result\n");
  await writeFile(join(child.path, "new"), "child new\n");
  await commit(child.path);
  await writeFile(join(cwd, "b"), "independent later parent\n");
  const result = await integrateSnapshotWorktree(cwd, child);
  assert.equal(result.integrated, true, JSON.stringify(result));
  assert.deepEqual(result.changedPaths, ["a", "new"]);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "child result\n");
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "independent later parent\n");
  assert.equal(await readFile(join(cwd, "new"), "utf8"), "child new\n");
  const after = await parentState(cwd);
  assert.equal(after.head, before.head);
  assert.equal(after.branch, before.branch);
  assert.deepEqual(after.index, before.index);
  assert.equal((await inspectWorktree(child)).exists, true);
  assert.equal((await cleanupWorktree(cwd, child)).removed, false);
  assert.equal((await integrateSnapshotWorktree(cwd, child)).integrated, true);
});

test("conflict on one path leaves all other paths unchanged, including new files", async (t) => {
  const cwd = await fixture(t);
  const child = await createSnapshotWorktree(cwd, "child");
  await writeFile(join(child.path, "a"), "child a\n");
  await writeFile(join(child.path, "b"), "child b\n");
  await writeFile(join(child.path, "new"), "child new\n");
  await commit(child.path);
  await writeFile(join(cwd, "b"), "parent diverged\n");
  const before = await parentState(cwd);
  const result = await integrateSnapshotWorktree(cwd, child);
  assert.equal(result.integrated, false);
  assert.deepEqual(
    result.conflicts.map((c) => c.path),
    ["b"],
  );
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "base a\n");
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "parent diverged\n");
  await missing(join(cwd, "new"));
  assert.deepEqual(await parentState(cwd), before);
});

test("child rename, deletion, mode and symlink changes integrate without dereferencing", async (t) => {
  const cwd = await fixture(t);
  await symlink("a", join(cwd, "link"));
  await commit(cwd);
  const child = await createSnapshotWorktree(cwd, "child");
  await rename(join(child.path, "a"), join(child.path, "renamed"));
  await chmod(join(child.path, "renamed"), 0o755);
  await rm(join(child.path, "b"));
  await rm(join(child.path, "link"));
  await symlink("/outside/missing", join(child.path, "link"));
  await mkdir(join(child.path, "dir"));
  await writeFile(join(child.path, "dir/new"), "new");
  await commit(child.path);
  const result = await integrateSnapshotWorktree(cwd, child);
  assert.equal(result.integrated, true, JSON.stringify(result));
  await missing(join(cwd, "a"));
  await missing(join(cwd, "b"));
  assert.ok((await lstat(join(cwd, "renamed"))).mode & 0o111);
  assert.equal(await readlink(join(cwd, "link")), "/outside/missing");
  assert.equal(await readFile(join(cwd, "dir/new"), "utf8"), "new");
});

test("integration refuses uncommitted child changes, excluded additions, wrong parent, ancestor symlinks", async (t) => {
  const cwd = await fixture(t);
  const child = await createSnapshotWorktree(cwd, "child");
  await writeFile(join(child.path, "a"), "uncommitted");
  assert.match((await integrateSnapshotWorktree(cwd, child)).conflicts[0].reason, /Commit/);
  await writeFile(join(child.path, ".env"), "secret");
  await commit(child.path);
  assert.equal((await integrateSnapshotWorktree(cwd, child)).integrated, false);
  await git(child.path, "rm", ".env");
  await mkdir(join(child.path, "dir"));
  await writeFile(join(child.path, "dir/new"), "new");
  await commit(child.path);
  await symlink("/tmp", join(cwd, "dir"));
  const conflict = await integrateSnapshotWorktree(cwd, child);
  assert.equal(conflict.integrated, false);
  assert.match(conflict.conflicts[0].reason, /Unsafe ancestor|symbolic link/);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "base a\n");
  const other = await fixture(t);
  assert.match(
    (await integrateSnapshotWorktree(other, child)).conflicts[0].reason,
    /original parent/,
  );
});

/** A real Git wrapper schedules a writer at a deterministic command boundary. */
async function injectGit(t: import("node:test").TestContext, body: string) {
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const bin = await mkdtemp(join(tmpdir(), "pi-snapshot-git-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const original = process.env.PATH;
  const wrapper = `#!${process.execPath}\nconst fs = require('node:fs');\nconst cp = require('node:child_process');\nconst args = process.argv.slice(2);\n${body}\nconst result = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});\nprocess.exit(result.status ?? 1);\n`;
  await writeFile(join(bin, "git"), wrapper, { mode: 0o755 });
  process.env.PATH = `${bin}:${original}`;
  t.after(() => {
    process.env.PATH = original;
  });
  return bin;
}

test("snapshot aborts on concurrent content change even when porcelain status is unchanged", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "a"), "already dirty\n");
  const before = await parentState(cwd);
  const marker = join(cwd, ".git/injected");
  await injectGit(
    t,
    `if(args.includes('hash-object') && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); fs.writeFileSync(${JSON.stringify(join(cwd, "a"))}, 'concurrent dirty\\n'); }`,
  );
  await assert.rejects(createSnapshotWorktree(cwd, "child"), /Concurrent parent change/);
  assert.deepEqual(await parentState(cwd), before);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "concurrent dirty\n");
});

test("snapshot aborts on concurrent branch movement", async (t) => {
  const cwd = await fixture(t);
  const head = await git(cwd, "rev-parse", "HEAD");
  const marker = join(cwd, ".git/injected");
  await injectGit(
    t,
    `if(args.includes('hash-object') && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); cp.spawnSync(${JSON.stringify((await exec("which", ["git"])).stdout.trim())}, ['switch','-c','concurrent'], {cwd:${JSON.stringify(cwd)}}); }`,
  );
  await assert.rejects(createSnapshotWorktree(cwd, "child"), /Concurrent parent change/);
  assert.equal(await git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(await git(cwd, "symbolic-ref", "--short", "HEAD"), "concurrent");
});

test("concurrent change after first integration write rolls back only own changes", async (t) => {
  const cwd = await fixture(t);
  const child = await createSnapshotWorktree(cwd, "child");
  await writeFile(join(child.path, "a"), "child a\n");
  await writeFile(join(child.path, "b"), "child b\n");
  await commit(child.path);
  const before = await parentState(cwd);
  const marker = join(cwd, ".git/injected");
  await injectGit(
    t,
    `if(process.cwd() === fs.realpathSync(${JSON.stringify(cwd)}) && fs.readFileSync(${JSON.stringify(join(cwd, "a"))}, 'utf8') === 'child a\\n' && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); fs.writeFileSync(${JSON.stringify(join(cwd, "b"))}, 'external b\\n'); }`,
  );
  const result = await integrateSnapshotWorktree(cwd, child);
  assert.equal(result.integrated, false);
  assert.match(result.conflicts[0].reason, /Concurrent parent content/);
  assert.equal(result.recoveryPaths, undefined);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "base a\n");
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "external b\n");
  const after = await parentState(cwd);
  assert.equal(after.head, before.head);
  assert.deepEqual(after.index, before.index);
});

test("snapshot aborts on a concurrent staged edit without changing that index", async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, "a"), "dirty before capture\n");
  const head = await git(cwd, "rev-parse", "HEAD");
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const marker = join(cwd, ".git/injected");
  await injectGit(
    t,
    `if(args.includes('hash-object') && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); cp.spawnSync(${JSON.stringify(realGit)}, ['add','a'], {cwd:${JSON.stringify(cwd)}}); fs.copyFileSync(${JSON.stringify(join(cwd, ".git/index"))}, ${JSON.stringify(join(cwd, ".git/expected-index"))}); }`,
  );
  await assert.rejects(createSnapshotWorktree(cwd, "child"), /Concurrent parent change/);
  assert.equal(await git(cwd, "rev-parse", "HEAD"), head);
  assert.deepEqual(
    await readFile(join(cwd, ".git/index")),
    await readFile(join(cwd, ".git/expected-index")),
  );
  assert.equal(await git(cwd, "show", ":a"), "dirty before capture");
});

test("integration excludes force-added child runtime files and retains an existing API lock", async (t) => {
  const cwd = await fixture(t);
  const child = await createSnapshotWorktree(cwd, "child");
  await mkdir(join(child.path, "ignored"));
  await writeFile(join(child.path, "ignored/runtime"), "runtime");
  await git(child.path, "add", "-f", "ignored/runtime");
  await git(child.path, "commit", "-m", "runtime");
  const result = await integrateSnapshotWorktree(cwd, child);
  assert.equal(result.integrated, false);
  assert.match(result.conflicts[0].reason, /Excluded/);
  await missing(join(cwd, "ignored/runtime"));
  const lock = join(cwd, ".git/pi-subagents-integration.lock");
  await writeFile(lock, "other owner");
  assert.equal((await integrateSnapshotWorktree(cwd, child)).integrated, false);
  assert.equal(await readFile(lock, "utf8"), "other owner");
});

test("inherited Git routing cannot redirect snapshot worktree creation into the parent index", async (t) => {
  const cwd = await fixture(t);
  const before = await parentState(cwd);
  const original = {
    index: process.env.GIT_INDEX_FILE,
    worktree: process.env.GIT_WORK_TREE,
    directory: process.env.GIT_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      GIT_INDEX_FILE: original.index,
      GIT_WORK_TREE: original.worktree,
      GIT_DIR: original.directory,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.GIT_INDEX_FILE = join(cwd, ".git/index");
  process.env.GIT_WORK_TREE = cwd;
  process.env.GIT_DIR = join(cwd, ".git");
  const child = await createSnapshotWorktree(cwd, "child");
  assert.deepEqual(await readFile(join(cwd, ".git/index")), before.index);
  assert.notEqual(child.path, cwd);
  assert.equal((await inspectWorktree(child)).exists, true);
});
