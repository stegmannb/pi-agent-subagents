# RPC process runner and companion host

The existing in-process runner remains the default. Set `runner: "rpc"` on the
`Agent` tool to use the process runner. This requires the companion SDK host:
ordinary Pi extension loading cannot expose the complete live parent resource
inventory in Pi 0.73.0 and refuses with `LIVE_PARENT_INVENTORY_UNAVAILABLE`.

The host uses exported `createAgentSessionRuntime`, `AgentSession.resourceLoader`,
`createEventBus`, `InteractiveMode` and `runRpcMode` APIs. Interactive and headless
parents launch the same RPC child. No terminal pane or Herdr installation is
required.

`pnpm run test:process:protections` prepares exact reviewed Guard and Sandbox
source archives and exercises their real productive entries. The committed
manifest records upstream URL, base and commit IDs, Git tree, archive SHA256,
and license provenance. Preparation verifies the archive and reconstructed tree,
rejects unsafe entries, then installs production dependencies with the frozen
lockfile and scripts disabled. Sources live under ignored `test-results/` paths.
No checkout credentials or other worker directories are required. Missing
sources, failed native initialization, or changed tracked source fail the suite.
On macOS the named devenv task runs this suite directly. On Linux it builds
`checks.x86_64-linux.process-protections`, which requires eight runs of the
isolated VM described in [protection-vm.md](protection-vm.md). This requires a
local or configured remote x86_64-linux Nix builder. The guest includes
Bubblewrap, socat and ripgrep for actual OS sandbox initialization.

The `process-protections` workflow runs eight mandatory matrix jobs on every
push and pull request. Each job builds one suite on the existing runner class
and has a 45-minute limit for preparation, building and execution. Each VM
retains its 1200-second limit. `fail-fast: false` lets the other suites finish
if one fails. The independent factory smoke job proves VM infrastructure;
these consumer suites qualify the actual protection and delegation behavior.

All eight suites use the same immutable `preparedBundle` and unchanged VM
factory. Each suffix identifies a `process-protections-<suite>` Nix check,
matrix job and directory in the local aggregate output:

| Suite | Cases | Required behavior |
| --- | --- | --- |
| `baseline-rpc` | 5 | Original Guard and Sandbox RPC cases. |
| `baseline-ui` | 2 | Read-only role enforcement and interactive protection. |
| `nested-review` | 1 | Protected nested review and correction. |
| `nested-roles` | 2 | Protected role-file drift at startup and continuation. |
| `communication-joins` | 4 | SDK review/correction and all three join modes. |
| `communication-address` | 4 | Foreground help, sibling steering and role-file drift. |
| `communication-help` | 3 | Background help in all three join modes. |
| `communication-results` | 6 | Four pending-ingestion cases, shared OS-process budgets and actual SDK session persistence. |

The local aggregate derivation depends on all eight successful VM outputs and
retains their separate service logs and journals. It cannot succeed with a
missing run. CI's `process-protections` completion job depends on the entire
matrix and runs even after a failure. It accepts only a matrix result of
`success`; a failed, cancelled, skipped or missing result cannot pass. That job
does not rebuild the VMs. Require all eight suite results and the completion
job for the same commit. A green completion job alone is not the full evidence.

Each matrix job uploads `process-protections-<suite>-logs`, including the
streamed build log on failure and the service log and journal when produced.
Boot errors, unavailable capabilities, failed assertions and timeouts fail the
affected suite and prevent aggregate success. The split preserves all 27 cases
exactly once, with their original assertions. Each suite uses the fixture timing
policy described below.
The macOS command still runs all 27 cases together. Actual CI timing must be
measured on its runner; local success does not establish CI runtime. Matrix
scheduling and preparation can increase total wall time beyond one job's limit.

The VM sets `PASA_PROTECTION_VM=1` only for its test process. The fixtures
explicitly configure `policy.childStartupTimeoutMs: 120000` and allow the same
bound for the test Parent's first `get_state` response. They also explicitly
select `limits.timeoutSeconds: 180` for Child runs under TCG. This finite
functional test allowance includes preprompt checks and nested Child startup;
it does not pause or restart while a nested reviewer runs.
Native fixtures and product defaults remain unchanged. The QEMU fixtures also
select `policy.qualificationPreset: "qemu-functional"` for the fixed 20/40/80-second
snapshot, inspection and initial-readiness windows described below. Ordinary
control requests retain their deadlines. Outer waits include startup and run budgets; the
690-second case bound accounts for Parent startup and two Child incarnations.
Each Parent prompt retains its 285-second deadline, the Child-done wait remains
260 seconds, and the VM and CI job limits remain 1200 seconds and 45 minutes.
Parent startup and Child process age at the first model invocation are logged. These measurements
include TCG overhead and are not native runtime performance claims.

```sh
nix build --no-update-lock-file --print-build-logs \
  .#checks.x86_64-linux.process-protections
```

To limit simultaneous VM runs on a configured builder, build explicit suite
checks in pairs, then run the aggregate command above. For example:

```sh
nix build --no-update-lock-file --print-build-logs \
  .#checks.x86_64-linux.process-protections-baseline-rpc \
  .#checks.x86_64-linux.process-protections-baseline-ui
```

Build the remaining six suite checks on the same source before the final
aggregate. Preserve each original build log and output directory. A single
suite or pair is not a complete qualification.

`nix/protection-bundle.nix` builds an offline test input from an explicit source
fileset and three fixed-output `fetchPnpmDeps` stores. The runner includes its
development test tools; adapters install only production dependencies. All
installs are frozen, offline and run with scripts disabled. Building with Linux
`pkgs` selects Linux native dependencies, independent of a developer's Mac
installation. The result exposes the project at `${bundle}/repo` and supplies a
`preparedBundle` derivation for the VM factory's typed input.

After copying that directory to an owned writable test directory, run
`PASA_PROTECTION_PREPARED=1 pnpm run test:process:protections`. This mode performs
no package installation. It rechecks source provenance and every preinstalled
dependency file hash, symlink target and executable bit before running the same
test suite. A changed or added dependency refuses the run. The prepared
bundle is a test input; it supplies no protection readiness attestations.

## Starting the host

Use Node 22 with TypeScript stripping and the pinned Pi 0.73.0 dependencies.
Create a trusted local JSON configuration, using absolute paths:

```json
{
  "cwd": "/work/project",
  "agentDir": "/home/user/.pi/agent",
  "model": { "provider": "provider-name", "id": "exact-model-id" },
  "policy": {
    "sessionDirectory": "/home/user/.pi/agent/subagent-sessions",
    "childStartupTimeoutMs": 10000,
    "extensions": [
      { "path": "/extensions/pi-agent-guard/index.ts", "protectionId": "pi-agent-guard" },
      { "path": "/extensions/pi-agent-sandbox/pasa-extension.mjs", "protectionId": "pi-agent-sandbox" },
      { "path": "/extensions/provider/index.ts", "protectionId": null }
    ],
    "nodeImports": ["/extensions/pi-agent-sandbox/protection-source.mjs"],
    "environmentAllowlist": ["HOME", "PATH"],
    "credentials": {
      "authFile": "/home/user/.pi/agent/auth.json",
      "environmentNames": []
    },
    "limits": { "maxConcurrent": 4, "maxDepth": 2, "maxTurns": 20, "timeoutSeconds": 600 }
  }
}
```

```sh
node --import /extensions/pi-agent-sandbox/protection-source.mjs \
  src/process-host.ts /private/host-config.json interactive
# Use rpc instead of interactive for a JSONL parent.
```

`policy.childStartupTimeoutMs` is optional. It accepts a positive safe integer
up to 120000 milliseconds and defaults to 10000. Host attachment rejects invalid
values before capturing resources or launching a Child. It controls only the
first Child `get_state` response, which includes loading Pi and extensions.
The transport still validates that state, disables retries, inspects the Child
and verifies its readiness before any prompt. All those subsequent requests and
verification retain their original ten-second default; protection snapshot and
before-prompt captures default to five seconds. The separately selected functional
QEMU qualification preset is described below. The startup setting
never extends model run limits and is fixed when the runner attaches.

The protection packages must implement the snapshot-v1 producer contract below.
Their native loading requirements apply to the parent before importing Pi and
to every child. `nodeImports` repeats those preloads for children and fingerprints
their files. Listing a preload does not prove the parent loaded it; the real
producer must attest its loaded state. Old protection versions without the
interface fail closed.

For the Sandbox native entry, the companion sets `PASA_SANDBOX_PI_ENTRY` to its
resolved Pi 0.73.0 SDK entry before loading extensions. It explicitly passes this
same nonsecret path to children. The Sandbox attests the setting and the actual
loaded SDK dependency closure, including deployments without its development SDK.
The early Node preload is still required in the parent invocation.

The CLI establishes the configured process cwd and `PI_CODING_AGENT_DIR` before
loading extensions. The exported `createCompanionHost` API requires both to be
established by its caller. Changing the companion's process cwd through session
replacement is refused. Launch a fresh host for a different parent cwd.

The host also loads the subagents extension and classifies its own known entry
point. Every other actually loaded extension needs an explicit classification.
Use `null` only after establishing that an extension is not a protection
component. Auto-discovered extensions remain part of the inventory; undeclared
ones refuse delegation. Never classify a protection as ordinary to pass a check.
The host configuration is trusted operator input, not an Agent tool parameter.

## Session and workspace contract

`Agent` accepts the existing `isolation: "worktree"`, `worktree_base` and `cwd`
parameters. The manager creates the retained worktree before resolving protection
replay for that exact cwd. It never snapshots working changes or removes a
worktree automatically. The snapshot/integration APIs remain separate.

A fresh launch exclusively creates a mode-0600 version-3 Pi session header in a
mode-0700 owned directory. Its session ID is chosen before spawning. Follow-up
through `Agent.resume` keeps the same task ID, logical agent ID, session file and
worktree; each incarnation has a new logical process ID and OS PID. Session
header, ownership, resource fingerprints and protections are checked again.
Session files and working files survive failure and completion.

Agent result details expose `process.taskId`, `agentId`, `sessionId`, `processId`,
`pid`, `sessionFile` and `cwd`. The agent manager retains the resume handle for
completed RPC children. Clearing an in-memory record does not remove its session
or workspace. Reattaching such records across host restarts is outside this
version.

## Parent capture and child readiness

The actual SDK host supplies its already-loaded ResourceLoader and EventBus.
The runner compares loaded code/instructions/provider references with its host
baseline. Persisted Pi settings must match the running SettingsManager. A
second resource discovery pass is not accepted as a substitute for that live
inventory.

For every required protection, the runner sends
`pasa:protection:snapshot:v1` on the trusted local bus. Types live in
`src/protection-adapter.ts`. Requests bind a fresh request ID, protection ID,
expected live session ID and canonical target cwd. Producers return either:

- `ready`, with current cwd/session/generation, actual initialized enablement,
  code/configuration/environment fingerprints, current state digest, and a
  file-backed replay digest for the exact target cwd;
- `unsupported`, with a fixed reason for unavailable, disabled, changed or
  nonreproducible state.

Missing producers, unknown versions, duplicate responses, stale sessions and
expired snapshot deadlines refuse the launch, with a five-second default. Temporary
rules, grants, toggles and
other runtime-only state may be explicitly unsupported. The runner never resets
parent state, drops protection or retries a task to make reproduction succeed.

The child uses a private Node IPC channel for bootstrap and inspection. It
loads the captured extension/skill/instruction selection, binds actual
credential references and authenticates its own broker participant. Auth values
are not placed on command lines, copied into profiles or persisted in bootstrap
files. Child environment values come from the explicit allowlist and separate
credential-name list; the parent environment is never spread into it.

After real extension initialization, the child independently collects the same
protection snapshots. It compares them against the expected target replay state,
loaded code and configuration. Only Guard's exact `.pi/settings.json` and
Sandbox's exact `.pi/sandbox.json` project paths map to child cwd after the
producer verifies that target, with unchanged hashes. All other references stay
exact, including global configuration physically located inside parent cwd.

Readiness also checks session, PID, model, thinking, resource identities, complete
active tool names and broker identity. The parent is recaptured immediately
before authorization; changed generation/state invalidates the launch. The child
checks again on prompt input, before model start, before compaction and before
tool calls. Pi catches extension hook exceptions, so rejection at the model or
compaction boundary immediately exits the private Child before inference can
continue. Termination is a capability supplied only by the private Child entrypoint;
the boundary has no PID selection or independent host-termination operation.
Without a binding it refuses input and cannot continue a model hook. A final
built-in boundary restricts extension tools as well as built-ins. Role tools are an explicit subset
of the parent's active tools. `isolated: true` cannot disable protections in RPC
mode.

No model prompt is sent before successful inspection. Readiness errors kill the
child and return a terminal error to the manager. No fallback to an unprotected
process occurs.

## RPC and results

The [delegation contract](process-delegation.md) defines shared group limits,
addressed tools, nested roles, persistent result ingestion and parent wakeups.

`src/process-rpc.ts` implements the installed Pi 0.73.0 JSONL protocol.
A correlated successful `prompt` response means preflight acceptance, not task
success. Pi acknowledges only after input hooks, possible compaction and
`before_agent_start`. This acknowledgement uses the configured whole-run budget,
whose timer starts before the final readiness check and also bounds model and
tool execution. It does not get an independent ten-second control-request limit
or a fresh run budget after acknowledgement. It does not change other request or
protection deadlines; the explicit qualification preset below selects those
inspection/readiness/snapshot windows separately.

The transport also requires `agent_start`, an assistant `message_end`
with stop reason `stop`, and `agent_end`. Text deltas, terminal readiness, an
empty event stream or early exit cannot mark completion. Provider errors,
aborts, truncated results, command rejection and deadline expiry fail the run.
For a managed process task, the authenticated result handoff is also required.
An intermediate `agent_end` may be followed by a guarded automatic continuation
while children or results are pending. It does not reset the original deadline
or cumulative turn counter.

The result collector starts its deadline just before the managed RPC prompt.
Expiry of either run timer terminates the Child with `TIME_LIMIT` and emits one
`process_limit` event with `limit: "time"`. A result-collection timeout uses a
dedicated local error type; arbitrary channel errors with the same text are
not interpreted as timer expiry. Other collection failures remain
`RESULT_DELIVERY_FAILED`. A received result with failed persistence keeps its
separate `ResultDelivery.error: "PARENT_SESSION_WRITE_FAILED"` and
`ingested: false`; no timeout path invents result receipt or persistence.

JSONL frames and private IPC bootstrap/inspection messages have a four-MiB size
limit. Command queues and waits are bounded. Unexpected correlation and invalid
JSON terminate the process. Stderr is drained without forwarding or retaining
possibly sensitive diagnostics. Process errors use fixed codes. Closing first
sends SIGTERM, then SIGKILL after a bounded grace period.

The private Child encodes fatal boot, input, model, compaction and disconnect
failures in its numeric exit status. `src/process-child-failure.ts` defines the
fixed phase/code table: five phase slots of 32 values begin at 64 and stay below
256, the Unix exit-status bound. Entries are stable; unused values remain opaque.
Only an own data property named `code` with an explicitly listed string is
accepted. Unknown values use `CHILD_FAILURE`. The encoder never reads error
messages, stacks or causes, invokes code getters, or coerces arbitrary objects.

The Child computes this small status synchronously and passes it directly to
its existing immediate `process.exit`. There is no file, pipe write, asynchronous
IPC delivery, flush or acknowledgement before termination. The OS retains the
status for the owning transport. Only a privately bootstrapped Child's ordinary
exit is decoded; signals, unassigned statuses and generic Pi processes retain
`PROCESS_EXITED`. For example, a captured resource change at the input boundary
returns `Pi RPC failed: RESOURCE_CHANGED [child:input]`. A prior transport error
or deadline remains the first failure and is not replaced by a later exit.

This is failure information, not authenticated evidence of a particular cause:
code already running inside the Child can exit with the same numeric status.
It cannot grant readiness, authorize a prompt, or mark a run complete. Native
crashes and external kills may carry no internal diagnosis. Failure diagnostics
do not change inspections or selected deadlines, and no raw Child stderr is
retained or forwarded.

Structured events carry text progress, tool start/end and tool errors, assistant
usage, compaction and limits. `SpawnOptions.onProcessEvent` and the local
`subagents:process_event` bus event expose these with process identities. The
manager also updates its normal usage and activity counters. Auto-retry is
disabled and the transport never retries tool actions or accepted prompts.

## Validation

`pnpm run test:process` covers fake-Pi failure paths, real deterministic Pi
persistence, and the productive companion RPC host through the actual Agent
tool. `pnpm run test:process:tui` starts the actual interactive companion without
Herdr. Both have named devenv tasks and CI steps. Existing unit/TUI suites remain
required.

Fixtures that explicitly classify only a deterministic provider as ordinary
prove transport/host behavior, not protection parity. Real Guard/Sandbox tests
must additionally use the owning packages' attested loading paths and actual
initialization, including different child cwd, missing configuration and drift,
and must prove that failed readiness executed no child prompt.

RPC role instructions are appended to the captured parent instructions. They do
not replace the parent's protections or resource inventory. Built-in Explore,
Plan, code-review and security-audit roles explicitly declare read-only mode;
RPC removes shell and mutation tools from these roles. Custom agent frontmatter
may declare `read_only: true` for the same boundary. `disallowed_tools` is also
respected. Optional parent conversation inheritance remains an explicit Agent
setting and is carried as task context.

The actual protected role test in `tests/process/protections-role-real.test.ts`
uses the deterministic local provider in `tests/process/fixtures/role-provider.ts`.
It records the tools offered at the Explore child's first model invocation,
reads a committed file, and deliberately requests `bash`, `write` and a
registered custom mutation tool. All three mutations must fail without creating
files. The same protected parent first executes each mutation successfully,
and the custom extension must also load in the child. This proves the role
boundary without depending on a Guard denial or an unavailable tool fixture.

### Private inspection timing

Diagnostics are off by default. Trusted host code may supply
`ProcessHostPolicy.onInspectionDiagnostic`; a companion host configuration may
set `inspectionDiagnostics: true` to write fixed `PASA_INSPECTION` JSON records
to stderr. Agent arguments cannot enable it. The CLI sink emits at most 512
records for the host lifetime. It never includes request identifiers, paths,
hashes, resource contents, prompts, credentials, or foreign error messages.

Each record has exactly `stage`, `phase`, `event`, and `durationMs`. Stages are
`startup` and `preprompt`. Phases are `request`, `inspection`, `resources`,
`nodeBinary`, `session`, `extensions`, `guard`, `sandbox`, and `return`.
Events are `start`, `end`, or `error`; duration is a finite nonnegative number.
`nodeBinary` measures the existing complete executable hash within the resource
check. Producer phases include capture and parity verification. `return` measures
the synchronous IPC send call, not acknowledgement or receiver scheduling.
The Parent measures the complete request, including a failed request.

The private transport accepts at most 32 diagnostic frames per inspection and
128 per Child transport, each at most 512 bytes. It retains at most two request
contexts and 64 observations. `getInspectionDiagnostics()` returns copies of
that bounded history. Unsolicited, malformed, mismatched, oversized, or excessive
frames fail the transport closed. Frames on stdout cannot enter this history.
Diagnostic frames never resolve inspection requests, reset deadlines, authorize
readiness, or establish completion. Missing diagnostics do not replace the
ordinary proof requirement. Sink exceptions leave the actual verification result
unchanged.

Only the two control inspections are instrumented. Input, model, and compaction
barriers retain their immediate private exit path, without diagnostic flush,
file writes, or awaited acknowledgements. Diagnostics do not change reads, their
order, protection checks, or the selected deadlines. Records are untrusted observations
from the Child, not authenticated causes or evidence of protection. A successful
measured run cannot identify the component that timed out in a different run.

The real protection tests explicitly enable this mode through the production
host and Child entrypoints. They recover bounded, validated stderr observations
in `finally`, including failed cases, so the existing service journals retain
them. Test assertions and VM/CI budgets are unchanged. An externally killed
process can lose buffered IPC or stderr records; delivery is not guaranteed.

### Functional QEMU qualification timing

The trusted host policy may explicitly set
`qualificationPreset: "qemu-functional"`. This is the only supported preset.
Absence preserves production timing. Unknown strings, `null`, numbers, objects
and other values are rejected before Parent capture/spawn and again by the
private Child bootstrap. Agent/model arguments and environment variables cannot
select it. The selected preset is captured for the runner lifetime and passed
through the private bootstrap; it is not part of model-controlled task limits.

| Bound | Default | `qemu-functional` |
| --- | ---: | ---: |
| Each protection snapshot response | 5000 ms | 20000 ms |
| Private Child inspection | 10000 ms | 40000 ms |
| Initial readiness, including inspection and Parent verification | 10000 ms | 80000 ms |

The constants are fixed. Generic `requestProtectionSnapshot` callers retain
their five-second hard cap. Only the explicitly preset-bound trusted snapshot
call can use twenty seconds. All Parent captures, including Resume and readiness
recaptures, use the selected bound. The shared Child inspection applies it to
control, input, model, compaction and tool hooks. Every fresh source/scope read,
its order, response validation, lease check, parity comparison, role restriction
and immediate local refusal remains in place. Both the asynchronous timer and
the elapsed-time check on a synchronous producer response enforce the selected
finite snapshot bound.

Inspection and initial readiness have separate timers. The latter starts before
the initial inspection; preprompt verification never restarts the whole-run
budget. Ordinary RPC requests retain their existing timeout, including explicit
caller overrides. Selecting this preset does not change first-response startup,
prompt acknowledgement, whole-run, outer test, VM or CI budgets. The preset is
valid only for a private bootstrapped transport; it does not extend generic Pi
RPC readiness.

Only the real QEMU protection fixtures opt in, alongside their existing explicit
startup allowance. Ordinary SDK and macOS tests use defaults. Linux qualification
with this preset proves the actual functional protection checks and OS denial
under these finite test windows. It does **not** prove production responses meet
five seconds or production inspections meet ten seconds. In the VM an otherwise
valid response after five seconds may deliberately be accepted before twenty
seconds. The preset is not a production latency repair, a measurement of the
minimum required allowance, or proof of any historical timeout's producer cause.
A failed qualification does not trigger retries or automatic budget increases.
