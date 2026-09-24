# Pi process messaging proof

This isolated experiment runs **two actual Pi processes**, each with its own
session, working directory and configuration. It does not change or load the
production subagent extension. It targets the installed Pi 0.86.1 API, not the
repository's older 0.73 development dependency.

The model is a deterministic extension fixture. No external inference, API keys
or paid tokens are used. This tests Pi's process boundary, tool loop, steering,
session persistence and RPC/TUI behavior, not a model's ability to collaborate.

## Run

From the repository root with Node 22+ and Pi 0.86.1 on `PATH`:

```sh
direnv exec . node --test experiments/process-messaging/broker.test.mjs
direnv exec . node experiments/process-messaging/run.mjs
```

For a real interactive Pi TUI in a disposable PTY, on macOS from a terminal:

```sh
direnv exec . node experiments/process-messaging/run.mjs --tui
```

For a visible interactive responder in a new sibling Herdr pane, run **inside
Herdr** with its genuine inherited `HERDR_ENV`, socket and pane context:

```sh
direnv exec . node experiments/process-messaging/run.mjs --herdr
```

The Herdr mode refuses to run outside Herdr. It creates one right-hand sibling
pane without changing focus, then starts Pi there. It never discovers or controls
an unrelated session. The test asks its Pi to shut down afterwards and leaves
the created pane for inspection. The managed Herdr status extension is not loaded
in this isolated profile. Pane creation and interactive Pi are the scope here,
not Herdr's agent-state integration.

Each run prints the path to a private temporary `report.json`. That directory also
contains the actual Pi sessions, RPC/terminal output and stderr. Successful runs
exit zero; missing registration, missing response or failed assertions exit
nonzero. Temporary evidence is retained for inspection. The broker socket closes
and owned subprocesses stop. There is no repository/worktree cleanup or commit.

## What the test checks

1. A and B register different PIDs and session IDs, with separate working
   directories and only the two fixture tools enabled.
2. B begins an asynchronous `proof_work` tool call and waits at a controlled
   boundary. A's fixture model calls `proof_send` to ask B a question.
3. B's bridge receives the question while `ctx.isIdle()` is false and queues it
   with `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`.
4. The fixture releases the work boundary. Pi supplies the question to B's next
   model call. This does not interrupt an executing tool midway.
5. B calls `proof_send` with `replyTo`. The broker routes the reply directly to A,
   without asking another model to relay it. A's model context observes the
   correlated answer. Both agents reach `agent_settled`, and both sessions contain
   their received mail.

The same transport connects peers in RPC or TUI mode. The two peer names have no
parent-only privileges. This demonstrates the routing mechanism needed for both
parent/child and sibling communication, not a complete delegation hierarchy.

## Boundaries

`broker.mjs` uses a private Unix socket, a per-run token and connection-bound
sender IDs. It rejects unknown recipients, duplicate IDs and replies without a
matching open question. The unit tests also cover disconnects and wait timeouts.
A broker write is not a recipient acknowledgment. The report separately records
routing, receipt and observation in the model context.

This is not a production protocol. It has no durable mailbox, reconnect/replay,
backpressure, capability negotiation, crash recovery or full cancellation model.
The fixture intentionally omits project instructions, skills, providers, guard
and sandbox extensions. Verifying that production children load these correctly
is still required before integration. Do not copy the isolated launch profile
into a production runner.

## Automated Herdr smoke test

The smoke test starts a private, named Herdr session inside Microsoft's
`tui-test`, then runs `run.mjs --herdr` from its actual shell pane. It can run
outside Herdr and never attaches to the user's default session. No invented
`HERDR_ENV` or socket context is passed to the controller.

From this repository, install the pinned experiment-only dependency and run:

```sh
direnv exec . npm ci --prefix experiments/process-messaging/herdr-smoke --ignore-scripts --no-audit --no-fund
direnv exec . node experiments/process-messaging/herdr-smoke/smoke.mjs
```

Validated on macOS with Node 22.22.2, Pi 0.86.1, Herdr 0.9.0 and
`@microsoft/tui-test` 0.1.0-beta.5. The dependency is private to this experiment;
the extension does not acquire a runtime dependency on tui-test. This currently
uses POSIX shells and `/tmp`, not a Windows test runner.

The test asserts two panes, preserved focus after `--no-focus`, distinct Pi
processes and sessions, busy message delivery, correlated reply and persisted
mail. It then uses Herdr's CLI from the controller pane to focus the child and
sends real terminal input through tui-test. The deterministic model must answer
`Keyboard input observed.`; input echo alone does not satisfy the assertion.
The communication checks are the same checks used by the headless proof.

Two file checkpoints, enabled only by `PI_PROOF_SMOKE_DIR` in Herdr mode, keep
Pi alive for terminal inspection. Each has a 45-second deadline. Success requires
both the structured proof report and the controller's zero exit marker.

Each run uses a private short `/tmp/pasa-*` directory, a unique `pasa-test-*`
session, isolated XDG paths and Herdr config, a non-login `/bin/sh`, and an
allowlisted environment without inherited provider credentials. Onboarding,
update checks, sounds and agent restoration are disabled. The short path is
necessary on macOS: its normal long `TMPDIR` exceeds the Unix socket path limit
after Herdr appends its session directories.

The wrapper stops its exact named Herdr session in `finally` and checks the stop
response. Closing the tui-test terminal alone is insufficient because Herdr's
server is persistent. Evidence is retained: `smoke-report.json`, `controller.log`,
SVG screenshots and a trace with Markdown/JSON/HTML views. `proofRoot` points to
the separate Pi report and session files. These temporary files may be removed
by the OS. A hard kill of the wrapper cannot guarantee cleanup; the report's
unique session and isolated configuration identify what belongs to that run.

During exploration, the combined `press("Ctrl+B", "l")` and a locator mouse
click did not switch the focused Herdr pane before subsequent input. The cause
is not established. The passing test explicitly focuses through Herdr's CLI;
it proves terminal text input, not Herdr keyboard-shortcut or mouse-navigation
compatibility. Herdr agent-status integration, real providers, inherited guard
and sandbox configuration, recovery and production lifecycle remain untested.

References: [tui-test JavaScript API](https://github.com/microsoft/tui-test/blob/main/bindings/js/README.md)
and the installed `herdr --skill` / CLI help. Pin the beta version when repeating
the test; upstream is undergoing an API rewrite.
