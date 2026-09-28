import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inspectWorktree, loadWorktree } from "../../src/worktree.ts";
import { withPi, type PiFixture } from "./harness.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}
function setup(app: PiFixture) {
  git(app.projectDir, "init", "-q");
  git(app.projectDir, "config", "user.name", "Test");
  git(app.projectDir, "config", "user.email", "test@example.invalid");
  git(app.projectDir, "config", "commit.gpgsign", "false");
  writeFileSync(join(app.projectDir, "tracked"), "initial\n");
  git(app.projectDir, "add", ".");
  git(app.projectDir, "commit", "-qm", "initial");
  git(app.projectDir, "branch", "explicit-base");
  return git(app.projectDir, "rev-parse", "HEAD");
}
async function prompt(app: PiFixture, text: string) {
  await app.editorReady();
  await app.terminal.submit(text);
}
async function retained(app: PiFixture) {
  const path = await app.waitFor(() => {
    const paths = git(app.projectDir, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    return paths.length === 2 ? paths[1].slice(9) : undefined;
  }, "worktree created");
  return app.waitFor(async () => {
    try {
      return await loadWorktree(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }, "worktree registration completes");
}

for (const mode of ["complete", "error", "abort", "parent-end"] as const) {
  for (const work of ["clean", "dirty", "commit"] as const) {
    test(`worktree preserves ${work} state on ${mode}`, { timeout: 60_000 }, async (t) => {
      await withPi(t, { cols: 160, rows: 50 }, async (app) => {
        const base = setup(app);
        const parentIndex = readFileSync(join(app.projectDir, ".git/index"));
        await prompt(
          app,
          "TUI:worktree:" +
            JSON.stringify({
              prompt: mode === "error" ? "CHILD:wait-error:retention" : "CHILD:wait:retention",
              worktree_base: "explicit-base",
              run_in_background: mode !== "abort",
            }),
        );
        const wt = await retained(app);
        assert.equal(wt.baseCommit, base);
        await app.waitFor(
          () => app.readEvents("events.ndjson").some((e) => e.event === "waiting"),
          "child waits",
        );
        if (work !== "clean") {
          writeFileSync(join(wt.path, "tracked"), "staged child work\n");
          git(wt.path, "add", "tracked");
          if (work === "commit") git(wt.path, "commit", "-qm", "child");
          else {
            writeFileSync(join(wt.path, "tracked"), "unstaged child work\n");
            writeFileSync(join(wt.path, "untracked"), "new child work\n");
          }
        }
        const childHead = git(wt.path, "rev-parse", "HEAD");
        const childIndex = readFileSync(join(wt.id, "index"));
        if (mode === "abort") await app.escape();
        else if (mode === "parent-end") await app.restart();
        else {
          if (mode === "complete" && work === "clean") {
            await prompt(app, `TUI:cleanup:${wt.path}`);
            await app.expect("Cleanup refused: agent is still active.");
          }
          writeFileSync(join(app.controlDir, "release-retention"), "release\n");
          await app.waitFor(
            () =>
              app.readEvents().some((e) => e.event === (mode === "error" ? "failed" : "completed")),
            "child finishes",
          );
        }
        const state = await inspectWorktree(wt);
        assert.equal(state.exists, true);
        assert.equal(state.hasCommits, work === "commit");
        assert.equal(state.hasUncommittedChanges, work === "dirty");
        assert.equal(state.headCommit, childHead);
        assert.deepEqual(readFileSync(join(wt.id, "index")), childIndex);
        if (work === "dirty") {
          assert.equal(readFileSync(join(wt.path, "tracked"), "utf8"), "unstaged child work\n");
          assert.equal(readFileSync(join(wt.path, "untracked"), "utf8"), "new child work\n");
        }
        assert.equal(git(app.projectDir, "rev-parse", "HEAD"), base);
        assert.deepEqual(readFileSync(join(app.projectDir, ".git/index")), parentIndex);
        assert.equal(git(app.projectDir, "status", "--porcelain"), "");
        if (mode !== "parent-end") {
          const started = app.readEvents().find((e) => e.event === "started");
          await prompt(app, `TUI:get:${started.data.id}`);
          await app.expect(`Base: ${base}`);
          await app.expect(`Head: ${state.headCommit}`);
          await app.expect(`commits beyond base: ${work === "commit" ? "yes" : "no"}`);
          await app.expect("retained");
        }
        // A restarted parent reloads ownership; dirty files and own commits still refuse cleanup.
        await prompt(app, `TUI:cleanup:${wt.path}`);
        await app.expect(work === "clean" ? "Removed worktree:" : "Cleanup refused");
        assert.equal((await inspectWorktree(wt)).exists, work !== "clean");
      });
    });
  }
}
