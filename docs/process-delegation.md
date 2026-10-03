# Process delegation and results

The companion host uses the same extension in RPC and interactive mode. At the
root, `Agent` still defaults to the existing in-process runner. Select `runner:
"rpc"` for a process task. Inside that task, `Agent` defaults to another process;
an explicit in-process selection is refused. Ordinary extension loading without
the companion host refuses process execution with `LIVE_PARENT_INVENTORY_UNAVAILABLE`.

## Tools and addressing

| Tool or command | Behavior |
| --- | --- |
| `Agent` | Delegate or resume an owned task. Existing roles, background mode, workspace selection and model overrides apply. Built-in process reviewers inherit the current model unless explicitly overridden. |
| `list_agent_group()` | Return this authenticated address, group members with their roles/depth/active state, and pending correlated help requests. |
| `send_agent_message({agent_id, message})` | Address a member of the same group, including a sibling. `parent` aliases the current parent. Reports transport receipt, not task completion. |
| `steer_subagent({agent_id, message})` | Accept an owned local task ID or authenticated group address. Answer a pending help request from that address directly; otherwise queue steering at a safe model transition. |
| `request_help({message})` | Wait for a correlated direct parent reply. A queued model notification is not a reply. |
| `reply_agent_message({request_id, message})` | Answer exactly one pending request without running the requesting model. |
| `/agent-reply REQUEST_ID MESSAGE` | Human/host reply through Pi's command path, including while a foreground `Agent` tool blocks the parent model. The RPC adapter also exposes `replyHelp(requestId, message)`. |
| `control_subagent_process({agent_id, process_id, ownership_revision, action})` | Inspect, abort, explicitly transfer ownership or retry cleanup for the exact displayed process run. See [process-lifecycle.md](process-lifecycle.md). |
| `get_subagent_result({agent_id, wait?, verbose?})` | Retrieve the existing task result. A failed parent-session write is explicitly reported as pending delivery. |
| `report_complete` | Record `summary`, `status`, optional `goal`, `basis`, `findings`, `evidence`, and `blockers`. It does not approve a review or merge and does not bypass outstanding children. |

Read-only reviewers/scouts receive only the intersection of the parent's tools
with `read`, `grep`, `find`, and `ls`. They cannot spawn work, mutate files or
integrate worktrees. Their final assistant response still produces a host-bound
result. Mutating task roles can use communication and delegation tools within
their inherited rights. In-process agents do not receive the process host's
addressing tools or its root identity.

## Group and source binding

One root broker owns the whole group. Defaults are four running descendants,
excluding the root, and depth two below it. Trusted `ProcessHostPolicy.limits`
can configure `maxConcurrent` and `maxDepth`; both must be positive finite safe
integers no greater than 2147483647. Descendants may only narrow these limits.
Reserve is atomic across all connected processes. The owning host releases its
reservation after closing the process, including failed starts. Unknown or lost
ownership does not free capacity speculatively. There is no broker-loss recovery.

The broker assigns identity, parentage, depth, role, and incarnation. Private IPC
passes those bindings and a per-incarnation credential to the child. A task hosts
its actual Pi `AgentSession` and loaded `ResourceLoader`; it does not construct a
second broker or pretend that bootstrap metadata is a loader inventory.

Each process has a fixed, file-backed role append prompt containing its resolved
role and cwd. Its path and full content hash are part of the profile and checked
against actual loaded text. Existing instructions, skills, extensions, providers,
and protection sources remain freshly verified. The child's model/provider and
thinking defaults come explicitly from its resolved private bootstrap. Other
settings are freshly reconstructed from their original file sources. Unexplained
in-memory settings changes and file drift are refused.

Input, model start, compaction, and tool checks remain in place. The public Pi
`context` hook also verifies before every model continuation, including queued
steering and follow-ups. Automatic wakeups use the guarded public prompt path.
No resource-hash cache, broader read allowlist or qualification timeout is added.

## Result ownership and joins

The result envelope contains `goal`, `basis`, `findings`, `evidence`, `blockers`,
and the host-bound `resultId`, `taskId`, `childAgentId`, `childSessionId`,
`childProcessId`, and `parentSessionId`. These are generic fields, independent of
any project tracker or review system. Default evidence includes the child's
retained session file. Explicit reports may provide more useful evidence.

`resultDelivery` records four separate states: produced, accepted by the broker,
received by the parent transport, and ingested into the parent's session file.
The parent writes a `pasa:result` custom entry through Pi's public SessionManager.
It then reads the actual JSONL file, checks its session header, and verifies the
single matching entry and complete identity before marking ingestion successful.
An in-memory entry or successful SDK return alone does not prove persistence.

Repeated identical results are idempotent within the supported host lifetime.
Conflicting data, another sender, and stale run/recipient bindings are rejected.
If Pi has already appended to memory before a disk-write failure, redelivery
does not append a duplicate. It remains pending unless the original entry can be
verified on disk. No automatic session repair, task respawn or durable broker
replay service is promised. Existing results and session files remain available.

The lower `ProcessRunner.execute()` and result `resume()` APIs return a
`ProcessExecutionResult` containing `responseText` and `delivery`.
`ProcessCommunication.waitResult()` collects the received result and returns
`{ result, delivery }`. These promises may fulfill after a parent-session save
failure with `delivery.ingested === false` and
`delivery.error === "PARENT_SESSION_WRITE_FAILED"`. Fulfillment means the result
and its delivery status are available; it does not acknowledge persistent
ingestion. Consumers must check `delivery?.ingested === true` before declaring
that handoff complete. Neither `responseText` nor a missing `delivery` field
proves ingestion.

When ingestion is pending, retain the result, its identity and the owning
session, and report the pending delivery or error. Do not turn collection into
an indefinite wait for a failed write, discard the result, start another task,
or append a duplicate session entry. This API does not automatically repair the
session. The Agent tools apply this contract by returning `Result delivery
pending` and keeping the task in `waiting`.

All three existing join modes retain the owning host and result receiver:

| Mode | Notification behavior | Completion condition |
| --- | --- | --- |
| `async` | Individual completion notices. The model may finish its own turn while children run. | Required children and their persistent result ingestion must resolve before the process publishes its final result. |
| `group` | Batch completion notice, with existing partial/straggler behavior. | A partial notice does not satisfy the remaining children or missing ingestion. |
| `smart` | Existing grouped behavior for a batch, individual behavior for a single child. | The same ownership, ingestion, pending-help and notification conditions apply. |

Completion bookkeeping, pending notifications and correlated help also hold the
parent open. Results wake an idle parent or enter its next safe transition while
busy. Models do not poll. The original process run keeps its overall deadline
and cumulative turn limit across those continuations.

## Example review and correction

From a root hosted session:

```json
{"description":"Implement parser correction","subagent_type":"general-purpose","runner":"rpc","isolation":"worktree","worktree_snapshot":{"untracked_paths":["fixtures/new-input.txt"]},"prompt":"Correct the parser. Delegate an independent read-only review before reporting findings and evidence."}
```

Inside that task:

```json
{"description":"Independent parser review","subagent_type":"code-review","isolation":"worktree","worktree_snapshot":{},"prompt":"Review the current working snapshot. Return the goal and inspected basis, concrete findings, checks performed, and any blockers."}
```

Resume the returned root task ID for corrections. Resume retains that task's
session file and workspace, with a new process incarnation and credential.
It does not create a second task or implicitly change the model. Use
`integrate_subagent_worktree({agent_id})` only after explicitly committing the
child's changes and checking the review. The [workspace contract](worktrees.md)
defines dirty-parent, dirty-child, conflict, active-child and ownership refusals.
Neither transport receipt nor a completion report replaces that decision.

Process fulfillment also does not prove finished cleanup. Inspect the lifecycle
phase; only `completed` confirms result-gated process cleanup. Pending cleanup
keeps the task waiting and retains its result for the same-run retry.
