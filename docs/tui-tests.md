# TUI tests

The TUI suite starts the installed pi CLI in a pseudo terminal and exercises this extension through the same `/agents` menus and tools a person uses. It pins `@microsoft/tui-test` 0.1.0-beta.5 and the direct pi packages to 0.73.0. Local Nix validation uses Node 22.22.2 and pnpm 10.33.2. The scripted provider in `tests/tui/fixtures/provider.ts` returns fixed responses and tool calls. No model service or API key is needed.

## Run locally

In the repository's direnv environment:

```sh
direnv allow "$PWD"
direnv exec "$PWD" devenv tasks run test:tui
direnv exec "$PWD" devenv tasks run test:tui:repeat
```

Both tasks install dependencies from the frozen lockfile first. `test:tui:repeat` runs the TUI suite three times for a bounded repeat check, stopping on the first failed run. Tests always execute; these tasks have no success cache.

`direnv exec "$PWD" devenv test` runs `check:fmt`, `check:lint`, `check:types`, `test:unit`, and `test:tui` through the `devenv:enterTest` dependency graph. The shared `deps:install` prerequisite runs once. The repeat task is explicit and is not part of the default test graph.

Use `devenv tasks list` to discover the named tasks or `devenv tasks run test:unit` for the existing unit suite. The underlying `pnpm test`, `pnpm run test:tui`, and `pnpm run test:tui:repeat` commands remain available.

To reproduce one file or test name, use the same Node invocation as `test:tui`:

```sh
direnv exec "$PWD" node --experimental-strip-types --test --test-concurrency=1 tests/tui/settings.test.ts
direnv exec "$PWD" node --experimental-strip-types --test --test-concurrency=1 --test-name-pattern='join mode' tests/tui/settings.test.ts
```

The suite runs one test file at a time because each case owns a real terminal process. A test case may take up to 60 seconds. The smoke test has a 30 second limit.

## CI and repository

[Forgejo](https://git.forest-arowana.ts.net/Bastian/pi-agent-subagents) is the primary repository. `.forgejo/workflows/test.yml` runs the required checks on pushes and pull requests and uploads terminal artifacts. GitHub is a mirror and has no separate test workflow. Use the Forgejo run for validation and review.

CI uses the repository's `flake.lock` to provide Node 22.22.3 and pnpm 10.33.4 through `nix shell --inputs-from . nixpkgs#nodejs_22 nixpkgs#pnpm_10`. It runs the same pnpm checks as the local devenv tasks, including the frozen dependency install. The checkout and Forgejo-compatible artifact actions are pinned to commit SHAs.

## Fixture and checks

`tests/tui/harness.ts` creates a temporary project, pi agent directory, and control directory for each case. It starts pi with `TuiTest.ephemeral`, a fixed terminal size, the scripted provider, and `index.ts`. The child process starts under `env -i` with a temporary `HOME`, XDG directories, and `PI_CODING_AGENT_DIR`; host credentials, proxy variables, extensions, and pi settings are absent. The CLI also receives `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-themes`. The test extensions are passed explicitly with `-e`.

The provider interprets `TUI:` prompts as requests for `Agent`, `get_subagent_result`, or `steer_subagent`. A child receives `CHILD:` prompts for completion, failure, long output, or a wait gate. These are real in-process pi sessions sharing the parent's model registry and isolated agent directory. The provider records requests and gate transitions in `events.ndjson`; extension lifecycle events go to `subagents.ndjson`. Tests inspect these events as well as the rendered terminal and files created by `/agents`. A waiting child proceeds only after the test writes `release-<gate>` in the control directory. The fixture closes pi, verifies its PID has exited, and removes its temporary directory in `finally`.

The default terminal is 110×36; boundary cases use 64×20 and resize during navigation. Assertions wait for visible text, selection changes, files, or lifecycle events. Polling checks conditions every 25 ms with a 10-second deadline; the provider's gate deadline is 15 seconds. There are no test retries. A small exact text snapshot checks the empty main menu without including volatile paths or durations.

| File | Covered behavior |
| --- | --- |
| `smoke.test.ts` | Real pi opens `/agents` and returns to the editor. |
| `layout.test.ts` | Empty running/custom lists, a compact menu snapshot, long descriptions, scrolling through 25 types, resizing, and project-over-personal precedence. |
| `menus.test.ts` | Built-in and custom agent menus, creation, invalid names, cancellation, editing, enable/disable, delete confirmation, eject, and reset. |
| `settings.test.ts` | Numeric settings, unlimited values, join modes, validation, cancellation, restart persistence, and unavailable cmux integration. |
| `lifecycle.test.ts` | Foreground and background Agent calls, completion and failure, result lookup, steering consumed by the child, Escape cancellation, timeout, independent and queued agents, and long output in a small terminal. |

The lifecycle cases exercise available tool and `/agents` flows. `/agents` has no stop button in this version, so cancellation is checked through Escape while a foreground child waits on a gate.

## Extend the fixtures

Use `withPi(t, options, async app => { ... })` for every case. Seed `projectAgents`, `globalAgents`, or `settings` only when they are prerequisites; perform the behavior being tested through terminal input. Assert both visible output and saved files or real lifecycle events. Use `app.restart()` when checking persistence.

For a new model scenario, add a narrowly matched branch in `provider.ts` and return a pi assistant message or tool call. For example, submit `TUI:background:CHILD:wait:example`, wait for the `waiting` event, then write `release-example` to `app.controlDir`. Use the observed `created` event's ID in `TUI:get:<id>` or `TUI:steer:<id>:<message>`. Do not generate lifecycle events in the provider: the event observer must record the extension's own events. Keep gate waits bounded and abort-aware.

## Failure artifacts

On failure, `withPi` writes `failure.txt`, `terminal.txt`, an SVG terminal screenshot, and any provider or lifecycle event logs under `test-results/<test-name>/<fixture-id>/`. `@microsoft/tui-test` also writes its trace and recording there. The Node test output prints the artifact directory. Forgejo Actions uploads `test-results/` even when an earlier check fails; the upload step ignores a missing directory.

Traces are retained for successful cases too. Start with `terminal.txt` and the event logs for a failure, then open the generated `trace.html` or SVG for input/render timing. An assertion failure during initial development verified the text and SVG capture path; a passing run does not suppress previous artifacts.

## Scope and compatibility

The suite uses the published [tui-test beta API](https://github.com/microsoft/tui-test/blob/main/bindings/js/README.md), including `TuiTest.ephemeral`, `run`, `press`, `type`, `submit`, `getByText`, `text`, and `screenshot`. The default Alacritty emulator runs headlessly; no GUI terminal or separate tui-test server is required. If a pi or terminal-test dependency changes, check those calls and the screen text assertions before updating the lockfile.

Linux with the Nix environment is validated locally. The fixture uses POSIX `env -i`; Windows is not supported by this suite. macOS and pi versions other than 0.73.0 have not been validated. cmux is intentionally absent, so its unavailable state is covered but actual sidebar integration is not. The separate `/plan` orchestration and real external model services are outside this suite. Existing worktree tests still run with `pnpm test`.
