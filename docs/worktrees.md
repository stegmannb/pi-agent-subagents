# Retained worktrees

`Agent` accepts `isolation: "worktree"` with an optional `worktree_base` naming an existing branch, tag or commit. The default is `HEAD` in `cwd`. Git resolves that value to a commit before creating a detached worktree. Moving the source branch afterward does not change the child's base. These modes do not copy uncommitted parent files. Use explicit `worktree_snapshot` for working changes. Both selections are rejected without worktree isolation or on resume, and cannot be combined: `worktree_base` and `worktree_snapshot` are alternatives, never a pair. A rejected selection fails the `Agent` call with an error naming the offending parameters, so the caller must correct its arguments instead of repeating the call.

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

Automatic integration, force deletion and recovery of running sessions are outside this version. Working-content snapshots and explicit integration are described below.

## Working-content snapshots

The `Agent` tool supports the same snapshot selection in foreground and background, with either runner:

```text
Agent(
  description: "Review current refactor",
  subagent_type: "code-review",
  runner: "rpc",
  prompt: "Review the current refactor. Return target/base, findings, evidence and blockers.",
  isolation: "worktree",
  worktree_snapshot: {
    untracked_paths: ["src/new-helper.ts"],
    exclude_paths: ["local-credentials"]
  }
)
```

An empty `worktree_snapshot: {}` copies tracked working changes and selects no
untracked files. Omitting it keeps the default committed-HEAD behavior; passing
it together with `worktree_base` is an error. Resume
uses the existing workspace; it does not take another snapshot.

The additive TypeScript API in `src/worktree.ts` creates a retained child from the parent's current working files:

```ts
import { createSnapshotWorktree, integrateSnapshotWorktree } from "./src/worktree.ts";

const child = await createSnapshotWorktree("/path/to/parent", "agent-id", {
  untrackedPaths: ["src/new-helper.ts"],
  excludePaths: ["local-credentials", "private-config"],
});
// Run the child in child.path. Review and commit its changes there, then stop writers.
const report = await integrateSnapshotWorktree("/path/to/parent", child);
if (!report.integrated) console.error(report.conflicts, report.recoveryPaths);
```

The existing `createWorktree(cwd, agentId, base?)` API and lifecycle retain their behavior. Lifecycle and result retrieval never integrate changes. The integration tool below requires a separate deliberate call.

Snapshot mode captures current bytes of tracked files, including staged additions, staged and unstaged modifications, deletions, executable bits and symlink target strings. A file present in HEAD or the index counts as tracked. If a staged deletion has been recreated on disk, its current bytes are included. Staging boundaries are not copied into the child. Untracked files require exact repository-relative file paths in `untrackedPaths`; directories, globs, traversal, non-UTF-8 filenames and Git administrative paths are not accepted. Unselected new files remain solely in the parent.

Git ignore rules apply even to tracked files. The built-in exclusions also omit `.env` and `.env.*`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `secret`/`secrets`, `credential`/`credentials` with optional leading dots and dotted suffixes, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `auth.json`, standard `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519` names, `.pem`, `.key`, `.p12`, `.pfx`, `node_modules`, `.devenv` and `.direnv`. `excludePaths` adds exact paths or directory prefixes. Explicitly selecting an excluded path fails; there is no force override. This is a path policy, not a content secret scanner. Callers must identify additional sensitive paths. Existing repository history is shared with the child, so exclusion does not hide already committed history.

V1 rejects submodule entries, unresolved index entries, nested repositories, including bare repositories, outside excluded/ignored resources, unsupported filesystem objects, and paths with unsafe ancestors. Symlink contents are read as target strings, never followed. The snapshot writes raw Git blobs without clean filters. If checkout conversion changes those bytes, creation fails and reports the retained partial worktree.

The snapshot commit has the original parent HEAD as its parent but is never committed onto the parent's branch. A unique `refs/pi-subagents/snapshots/<uuid>` ref retains it. `child.baseCommit` names that immutable snapshot. `child.snapshot` stores `parentHead`, `parentPath`, the retention ref and selection/exclusion policy. These fields survive `loadWorktree`. Compare `snapshot.parentHead..baseCommit` for inherited work and `baseCommit..child HEAD` for the child's own work. The snapshot contains exclusions as well as inherited modifications, so never merge the snapshot commit blindly into the parent.

Capture checks parent HEAD, branch, byte-identical index and porcelain status around reads and compares complete captured file bytes across repeated passes. A change detected during creation aborts. Parent branch, index and working files are never modified by capture. Objects written before an abort may remain unreachable; once a retention ref or worktree exists it is preserved for explicit inspection. No automatic cleanup runs.

## Explicit snapshot integration

After reviewing and committing the child's changes and stopping all writers, call:

```text
integrate_subagent_worktree(agent_id: "the-id-returned-by-Agent")
```

This tool accepts only a worktree owned by an agent record in the current
session and uses its recorded original parent checkout. It refuses an active
agent, an unknown agent or a worktree created without a working-changes
snapshot. Expired records require the explicit host API or manual recovery.
The returned structured details contain `integrated`, `childHead`,
`changedPaths`, `conflicts` and optional `recoveryPaths`. Integration applies
bytes only. It does not grant review approval, satisfy a merge gate or delete
the worktree.

Integration requires the registered original parent checkout and a clean, committed child HEAD descending from its snapshot base. Ignored child outputs are not integrated. Uncommitted or untracked child files cause a refusal so the integrated revision is explicit. The report includes the captured `childHead`, `changedPaths` and per-path `conflicts`.

Integration binds the on-disk registration to the original `WorktreeInfo` retained by the caller. The worktree identity and path, snapshot base, original parent path and HEAD, retention ref, exclusions and selected untracked paths must all match. A changed registration causes a refusal before parent mutation, including when it removes an exclusion. Integration uses the retained selection and checks the registration again immediately before applying files. API callers must retain the original record; reloading an altered registration cannot establish the original selection.

Only paths changed between the immutable snapshot and that child commit are considered. For each path, the current parent must equal either the snapshot or the desired child bytes and mode. Matching child contents make repeated integration harmless. Unrelated parent edits and staging remain intact. A different parent version produces a conflict even if a textual merge might be possible; V1 performs no automatic line merge. Directory/file shape conflicts also require manual resolution.

The entire change set is checked before writing. A known conflict returns without changing any parent file. Before each file replacement or deletion the implementation rechecks parent HEAD/index and affected contents. Writes use temporary files and atomic per-file rename. If a later check detects a concurrent writer, integration rolls back its own files only while they still equal its written bytes. It never restores over a detected external edit. `recoveryPaths` identifies files it could not safely restore; preserve both worktrees and inspect them manually. Parent HEAD and index are never updated, and integration neither commits nor removes the child or its snapshot ref.

Stop all external writers for capture and integration. A repository-scoped exclusive lock serializes calls to this integration API, but editors and ordinary Git commands do not honor it. Git and ordinary filesystems provide no atomic transaction across HEAD, index and several paths. Checks detect observed concurrent changes; they cannot exclude a writer racing between the last check and rename, an ABA change between reads, or guarantee rollback after process death. A stale `pi-subagents-integration.lock` in the common Git directory requires explicit recovery after confirming no integration is running. Registrations and this lock are not a security boundary against processes that can modify repository files or metadata.

Cleanup remains separate and keeps its ancestry requirement. Applying child bytes alone does not prove that child commits are ancestors of the parent's HEAD. Snapshot refs remain retained even after explicit worktree removal; deleting them is a separate deliberate Git operation after reviewing retention needs.

Run the real temporary Git fixtures with `pnpm run test:snapshots` or `devenv tasks run test:snapshots`. They also run as part of `pnpm test` and the existing `test:unit` devenv task.

`pnpm run test:delegation` or `devenv tasks run test:delegation` exercises the
registered Agent and integration tools through a real companion SDK host and
separate RPC child processes with a deterministic provider. It checks HEAD and
named bases, explicit new-file selection, persistent resume, dirty-child and
conflict refusals, and parent index/branch preservation. This focused fixture
does not load protection adapters; the actual OS protection suite remains a
separate qualification requirement.
