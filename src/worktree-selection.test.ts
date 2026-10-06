import assert from "node:assert/strict";
import test from "node:test";
import { worktreeSelectionError } from "./worktree-selection.ts";

test("accepts every single worktree selection", () => {
  assert.equal(worktreeSelectionError({}), undefined);
  assert.equal(worktreeSelectionError({ isolation: "worktree" }), undefined);
  assert.equal(worktreeSelectionError({ isolation: "worktree", worktree_base: "HEAD" }), undefined);
  assert.equal(worktreeSelectionError({ isolation: "worktree", worktree_snapshot: {} }), undefined);
  assert.equal(
    worktreeSelectionError({
      isolation: "worktree",
      worktree_snapshot: { untracked_paths: ["a.ts"] },
    }),
    undefined,
  );
});

test("rejects worktree_base plus worktree_snapshot and names both parameters", () => {
  const error = worktreeSelectionError({
    isolation: "worktree",
    worktree_base: "HEAD",
    worktree_snapshot: {},
  });
  assert.ok(error);
  assert.match(error, /mutually exclusive/);
  assert.match(error, /worktree_base/);
  assert.match(error, /worktree_snapshot/);
  assert.match(error, /retry/);
});

test("rejects worktree selections combined with resume", () => {
  const base = worktreeSelectionError({
    isolation: "worktree",
    resume: "agent-id",
    worktree_base: "HEAD",
  });
  assert.ok(base);
  assert.match(base, /worktree_base cannot be combined with resume/);

  const snapshot = worktreeSelectionError({
    isolation: "worktree",
    resume: "agent-id",
    worktree_snapshot: {},
  });
  assert.ok(snapshot);
  assert.match(snapshot, /worktree_snapshot cannot be combined with resume/);
});

test("reports every conflict of a three-way selection in one complete correction", () => {
  const error = worktreeSelectionError({
    isolation: "worktree",
    resume: "agent-id",
    worktree_base: "HEAD",
    worktree_snapshot: {},
  });
  assert.ok(error);
  assert.match(error, /mutually exclusive/);
  assert.match(error, /cannot be combined with resume/);
  assert.match(error, /remove worktree_base and worktree_snapshot from the call/);
  // The guidance must be a single correction, not one conflict per retry.
  assert.equal(error.match(/then retry/g)?.length, 1);
});

test("rejects worktree selections without isolation", () => {
  const base = worktreeSelectionError({ worktree_base: "HEAD" });
  assert.ok(base);
  assert.match(base, /worktree_base requires isolation: "worktree"/);

  const snapshot = worktreeSelectionError({ worktree_snapshot: {} });
  assert.ok(snapshot);
  assert.match(snapshot, /worktree_snapshot requires isolation: "worktree"/);
});
