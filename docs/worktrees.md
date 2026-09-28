# Retained worktrees

`Agent` accepts `isolation: "worktree"` with an optional `worktree_base` naming an existing branch, tag or commit. The default is `HEAD` in `cwd`. Git resolves that value to a commit before creating a detached worktree. Moving the source branch afterward does not change the child's base. Uncommitted parent files are not copied. `worktree_base` is rejected without worktree isolation or on resume.

Worktrees live under `<git-common-dir>/pi-agent-worktrees/<uuid>`, outside the parent's working files and system temporary directories. The returned identity is the actual per-worktree Git administrative directory. Its `pi-subagents.json` registration stores the path, immutable `baseCommit`, agent ID and common repository directory. A detached worktree has no branch field. If the child creates a branch, inspection reports its real name.

Success, failure, cancellation, record expiry and parent shutdown preserve worktrees, including those with a clean status and child commits. No lifecycle operation stages, commits, resets, stashes, integrates or removes work. Resuming a retained session uses the same directory. Parent shutdown does not make a session restorable in V1; the registered workspace remains independently inspectable.

Agent results, completion notifications and `get_subagent_result` show the retained path, ID, base, current HEAD and whether files or commits differ from the base. Result retrieval refreshes the state. Inspection failures report unknown change state, never a clean result. The underlying `inspectWorktree` function is read-only; it disables optional Git index refreshes. Ignored files count as local work for cleanup safety.

## Inspect and integrate manually

Stop the child and any other process writing to its worktree before integration or cleanup. Given the reported path and base:

```sh
git -C /path/to/child status --short --ignored
git -C /path/to/child log --oneline BASE..HEAD
git -C /path/to/child diff BASE
```

Review untracked files separately. Create a branch in the child if useful, then commit deliberately after review. Integrate that reviewed commit or branch from the target checkout using your normal merge workflow. Nothing automatically changes the parent's branch, index or files.

## Explicit cleanup

After stopping writers, call:

```text
cleanup_subagent_worktree(
  path: "/path/from/agent/result",
  cwd: "/path/to/integration/checkout"
)
```

The tool reloads the on-disk registration, so it also works after the original parent ends or forgets a completed agent. It refuses known active agents, unknown or substituted worktrees, another repository, the child itself as integration checkout, uncommitted/untracked/ignored files, and child commits not reachable from `cwd`'s current HEAD. A worktree still at its base needs no integration proof. V1 uses ancestry, not patch equivalence: squash merges and cherry-picks alone do not establish safe cleanup. There is no force override. A repeated cleanup reports a refusal/missing registration and deletes nothing. Existing child branches are retained.

The TypeScript API in `src/worktree.ts` exposes `createWorktree(cwd, agentId, base?)`, `loadWorktree(path)`, `inspectWorktree(info)` and `cleanupWorktree(cwd, info)`. Cleanup returns `removed: true` only after Git removes the worktree successfully. Callers must quiesce external writers; the registration is an ownership record, not a security boundary against processes that can modify repository metadata. Externally moved worktrees require manual recovery because their saved identity no longer matches. Failed setup preserves any partial worktree and reports its path for manual inspection.

Working-changes snapshots, automatic integration, force deletion and recovery of running sessions are outside this version.
