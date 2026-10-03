# Process ownership, termination and human dialogs

The companion host persists each RPC incarnation in
`policy.sessionDirectory/lifecycle/<processId>.json`. The private registration
binds task, agent, run, child and parent session, PID, cwd and session file. A
`current-<agentId>.json` index identifies the current incarnation. These files
are retained evidence. They do not instruct automatic recovery or respawning.

## Ownership and actions

| Ownership | Routing and parent-end behavior |
| --- | --- |
| `managed` | The owning parent can steer, abort and perform result-gated cleanup. Its end stops the registered process. |
| `manual` | Explicit takeover removes parent routing. Parent shutdown or disconnect leaves the process alive. |
| `external` | Explicit external takeover has the same parent termination boundary. |

`control_subagent_process` takes `agent_id`, `process_id`, `ownership_revision`
and `action`, one of `inspect`, `abort`, `manual`, `external` or `cleanup`.
For example, copy the identity from the current Agent result into:

```json
{
  "agent_id": "task-id",
  "process_id": "displayed-run-id",
  "ownership_revision": 0,
  "action": "manual"
}
```

Takeover atomically replaces ownership, revision and routing in one registration
under a per-run exclusive lock. It does not create a terminal pane, supply a new
transport or reconnect a disconnected process. The retained session and working
directory remain available to the new owner. Reservations remain held rather
than speculatively freeing capacity for detached work.

Every action rechecks the current registration and actual session header. Signal
targets also require the original `ChildProcess`, private run identity and a
fresh OS birth identity. Missing, contradictory or stale identities refuse the
action. Optional pane bindings must match too. A displayed action is a snapshot.
`steer_subagent` accepts optional `process_id` and `ownership_revision` to bind a
request to that snapshot. Direct group routing and correlated help replies also
reject stale or detached runs. Steering queues a cooperative model input and
does not abort the running tool.

## End and result states

A model turn ending does not dispose the host. An actual orderly parent end sends
`parent_exiting` through private IPC on a best-effort basis. An unexpected pipe
or IPC loss records `disconnected` separately. Managed processes receive a
cooperative abort when a run is active, TERM after 100 ms, then KILL after a
further 1000 ms if they still live and retain the same ownership and identity.
The child also bounds its own disconnect shutdown when tools ignore abort.
Transport cleanup has a three-second deadline. A proved OS exit may close its
own inherited pipes; a still-live process reports `PROCESS_CLEANUP_TIMEOUT`.
Manual or external processes hold their saved session after transport loss;
this does not report task success.

| Phase | Meaning |
| --- | --- |
| `starting`, `running` | Launch or active work. |
| `question` | An unresolved standard human dialog, including a blocked headless request. |
| `result-pending` | A received result lacks verified persistent parent ingestion. |
| `cleanup-pending`, `cleanup-error` | Result received; cleanup is outstanding or failed. |
| `completed` | Exact result persisted in the owning parent session and process cleanup finished. |
| `stopped`, `lost` | Explicit termination or proved process loss; no success is inferred. |
| `uncertain` | Identity cannot be proved; destructive actions are refused. |
| `detached` | Ownership transferred; communication loss is separately retained in `parentState`. |

Regular cleanup rereads the existing PASA result ledger and the owning parent
JSONL, requiring exactly one matching `pasa:result` entry. It closes only that
run. A failure retains result, delivery identity and `cleanup-error`; retrying
`cleanup` does not execute the task again or append another result. A later
incarnation invalidates old cleanup handles. Abort, timeout and parent loss may
stop managed processes without a result; their unresolved delivery remains
visible. Process cleanup never removes sessions, worktrees or evidence.

## Human dialog channel

Children expose the public Pi `select`, `confirm` and `input` methods through
private correlated IPC. The parent presents them through its UI with the same
expiry and cancellation signal. Late replies, mismatched IDs, invalid selections
and changed ownership cannot grant approval. Local child `AbortSignal`
cancellation explicitly dismisses its matching parent request. Cancellation or
expiry returns the SDK's denial/undefined result, never an approval.

Interactive companion hosts declare an actual human answer channel. A trusted
RPC host may explicitly configure `humanAnswerChannel: "rpc"` when its client
supplies human answers. Without that declaration, a request stays `question`
and blocked until cancellation, expiry, abort or process loss. The model cannot
enable the channel through Agent arguments. Arbitrary custom TUI and editor
requests are explicitly unsupported with `CUSTOM_TUI_UNSUPPORTED`.

`pnpm run test:lifecycle` and the corresponding devenv task exercise registrations,
owned OS processes, real SDK children, human denial/cancellation and failed cleanup
retry. The required `process-protections-lifecycle` Linux VM check uses the same
immutable offline bundle as the existing protection and delegation suites.
