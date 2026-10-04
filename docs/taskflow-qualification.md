# Generic Taskflow qualification

This reference defines the minimum technical handoff for a Taskflow consumer.
It exercises PASA-0005 result ingestion and event-driven joins together with
PASA-0006 process ownership and cleanup. PASA-0009 supplies this qualification.
TF-0005 and TF-0006 can refer to this document and those three implementation
tasks. Running it does not deploy a Taskflow workflow or qualify a Taskflow pilot.
Herdr and a full snapshot system are optional.

## Invocation and dependencies

Use a companion host with an actual Pi session and resource loader. Root Agent
calls select `runner: "rpc"`; nested mutating tasks default to RPC. Reviewers
inherit the model and only the parent's read tools. See the complete
[delegation contract](process-delegation.md), [start profile](process-start-profile.md),
[workspace contract](worktrees.md) and [lifecycle contract](process-lifecycle.md).

The fixture uses Pi SDK 0.73.0, Node 22 and the frozen pnpm lock. Its registered
provider produces fixed tool calls inside real Pi processes, with no external
inference, credential or network request. The version is in `package.json`.
Record the exact commit and clean source state for each run:

```sh
git rev-parse HEAD
git status --porcelain
direnv exec "$PWD" pnpm install --frozen-lockfile
direnv exec "$PWD" pnpm run test:qualification
# Equivalent named devenv task:
direnv exec "$PWD" devenv tasks run test:qualification
```

The pnpm command runs natively on macOS or inside a prepared Linux guest.
The named devenv task selects the isolated VM on Linux, matching the existing
protection task's host boundary.

`test:qualification` prepares the pinned Guard and Sandbox sources, runs the
combined scenarios serially and includes the existing result-persistence and
lifecycle matrices. Their assertions remain the source for individual states.
Run the unchanged baseline suites too:

```sh
direnv exec "$PWD" pnpm run ci:fmt
direnv exec "$PWD" pnpm run ci:lint
direnv exec "$PWD" pnpm run ci:check
direnv exec "$PWD" pnpm test
direnv exec "$PWD" pnpm run test:process
direnv exec "$PWD" pnpm run test:delegation
direnv exec "$PWD" pnpm run test:process:tui
direnv exec "$PWD" pnpm run test:tui
direnv exec "$PWD" pnpm run test:process:protections
```

The required Linux check uses the same immutable offline bundle and ordinary
UID 1000 NixOS guest as the protection suites:

```sh
nix build --no-update-lock-file --print-build-logs \
  .#checks.x86_64-linux.process-protections-taskflow-qualification
```

The Forgejo protection matrix includes this check. All existing protection
suites remain required. The new check also belongs to the protection aggregate.
The native command has 36 cases. The new VM has the twelve result and combined
cases; the original 24-case lifecycle matrix stays in the separate required
`process-protections-lifecycle` VM. Repeating that matrix's intentional
600-second timeout in the combined VM leaves insufficient time for its nested
scenarios within the existing 2400-second budget. No test-name filter, skipped
assertion or enlarged deadline is used.
See [VM preparation and diagnostics](protection-vm.md) for the bundle and failure
export contract. The service job has 60 minutes; the VM has 2400 seconds. QEMU
child/result and outer prompt/done allowances remain 600 and 900 seconds, with
2100 seconds per case. Startup and protection verification have separate
budgets. Native limits and production defaults remain unchanged.

## Combined scenario

An interactive parent without Herdr and a headless parent each delegate a
mutating task in a retained worktree. The task writes work, starts a sibling
that asks correlated help, and starts a read-only reviewer. Test-owned barriers
keep both descendants alive through the budget attempt. They use filesystem
events, with no sleep or parse retry.

The task's first model turn ends. Correlated help resumes that same process and
session. An observer on its actual reply tool captures the real broker group
with three active descendants and one pending request. The task answers that
precise request in its first resumed model turn, within the unchanged
30-second help deadline. It then calls the group tool and attempts a fourth
reservation, which fails with `CONCURRENCY_LIMIT`. Both descendants stay active
until the actual failure notification releases their barriers. The reviewer reads the fixed
input, reports findings and cannot write. Result notifications resume the task
again. It collects each required full result once and writes the correction
only after both exact `pasa:result` entries are on the task's actual JSONL disk.
The task then publishes its result to the root's actual session.

The headless case runs separately for `async`, `group` and `smart`. The same
combined scenario also runs with inherited Guard and OS Sandbox. Guard settings
use Pi's canonical JSON formatting from startup so a formatting-only SDK flush
does not correctly trigger the protection source-drift refusal.

## State matrix and evidence

| Case and test source | Required technical and task state |
| --- | --- |
| Headless joins, interactive parent and protected nesting, `qualification-real.test.ts` | Same task process/session through help and result wakeups; distinct reviewer/sibling processes; refused excess process; full findings precede correction and root delivery. All three registrations finish `completed` with verified ingestion. Worktrees and sessions remain readable. |
| Duplicate broker result and failed cleanup, `qualification-lifecycle-real.test.ts` | One real child publishes the identical envelope twice over the broker. Exactly one parent entry persists. Injected close failure leaves `cleanup-error` and holds the reservation. Explicit cleanup closes that same run without append or execution. |
| New incarnation after that cleanup, `qualification-lifecycle-real.test.ts` | Explicit resume retains session and worktree with a new process/run. The old handle is refused; the new registration and both parent results are unchanged by the refused action. No automatic recovery runs. |
| Real EACCES and memory-first SDK append, `delegation-results-real.test.ts`, `result-persistence-real.test.ts` | Result remains available, delivery stays `PARENT_SESSION_WRITE_FAILED` and task waits. Disk contains no invented result acknowledgement; redelivery does not append another memory entry or start a task. |
| Process loss during ingestion, `lifecycle-host-real.test.ts` | Exact lost run/result identity remains, ingestion is false, cleanup is refused and workspace/session evidence remains. Exit alone cannot prove success. |
| No human channel, parent loss and ownership transfer, `lifecycle-host-real.test.ts` | Missing answer stays blocked; cancellation/denial cannot approve. Managed loss stops only the owned child. Manual/external runs survive parent loss with revoked old routing. None reports successful ingestion by inference. |
| Contradictory/stale OS or registry identity, `process-lifecycle.test.ts`, `lifecycle-rpc-real.test.ts` | Mutation is refused before signalling or cleanup; retained data identifies the unresolved state. |

Combined fixtures retain `host.json`, stderr, provider trace, real session JSONL,
private lifecycle registrations and worktrees. Successful combined tests write
`qualification-proof.json` identifying the exact parents, runs and results.
The duplicate-publication journal records actual completed broker calls, not
just attempted sends. Assertions still verify the owning JSONL and registration.
TAP output prints retained fixture paths. Linux driver diagnostics export the
combined review fixtures before cleanup, including process observations and
normal core metadata. A subsequent successful run cannot establish a prior
crash's cause.

## Handoff limits

Record macOS native and actual Linux guest results separately, with source,
bundle and original log hashes. Nix evaluation on macOS is not Linux execution.
An unavailable host, failed assertion, incomplete log or missing suite is open.
The Linux protection baseline contains 52 cases, including 28 existing protection
cases; the new qualification does not replace them. No Windows support is claimed.

Technical ingestion and `completed` process cleanup do not confer independent
review, human approval, merge or apply authority. A consumer must inspect
`delivery.ingested === true` and the lifecycle state before treating collection
as a completed technical handoff. Pending save or cleanup retains the result
and work. It never instructs another execution, automatic session repair or
broker recovery. These tests make no durable replay or exactly-once promise
across broker loss. Provider CI, independent review and fresh merged-main
acceptance are separate delivery gates.
