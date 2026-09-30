> **Disclaimer:** This is a vibe-coded plugin created for myself to test if a flow like this makes sense for me. Use at your own risk.

# pi-agent-subagents

A [pi](https://github.com/mariozechner/pi) extension that adds autonomous sub-agent support to the coding agent.

The primary repository is [Bastian/pi-agent-subagents on Forgejo](https://git.forest-arowana.ts.net/Bastian/pi-agent-subagents). Issues, pull requests, and CI belong there. [GitHub](https://github.com/stegmannb/pi-agent-subagents) is a mirror.

## What it does

Provides delegation tools and a `/agents` management command:

| Tool | Description |
|------|-------------|
| `Agent` | Spawn a sub-agent for a complex multi-step task (foreground or background) |
| `get_subagent_result` | Check status and retrieve output from a background agent |
| `steer_subagent` | Send a mid-run steering message to a running agent |
| `cleanup_subagent_worktree` | Explicitly remove an owned worktree after inspection and integration |
| `integrate_subagent_worktree` | Explicitly apply committed child changes from a working-changes snapshot |

## Built-in agent types

| Type | Description |
|------|-------------|
| `general-purpose` | Full-access agent for complex tasks |
| `Explore` | Read-only codebase exploration (fast, uses Haiku) |
| `Plan` | Architecture and implementation planning |

Custom agents can be added as markdown files in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global).

## Installation

```bash
# inside your pi config repo
pnpm add pi-agent-subagents
```

Register the extension in your pi config, then reload.

## Usage

```
Agent(
  prompt: "Refactor the auth module to use the new token format",
  description: "auth refactor",
  subagent_type: "general-purpose",
  cwd: "/path/to/repository",
  isolation: "worktree",
  run_in_background: true
)
```

Set `cwd` to the git repository the agent should work in whenever the parent session was started from a workspace or another folder. Relative paths resolve from the parent session cwd.

Use `isolation: "worktree"` whenever that `cwd` is a git repository with at least one commit. It creates a retained detached worktree from committed `HEAD`, an existing ref passed as `worktree_base`, or working changes explicitly selected with `worktree_snapshot`. Omit isolation only when that is not possible or the agent must act in the live checkout. Invalid isolation requests fail. Worktrees and child commits survive completion, errors, cancellation and parent exit. See [retained worktrees](docs/worktrees.md) for snapshot selection, result fields, explicit integration and cleanup.

Run `/agents` in the pi TUI to browse agent types, manage running agents, and adjust settings (concurrency, max turns, join mode).

## Tests

Run `devenv test` for all checks, `devenv tasks run test:unit` for unit tests, or `devenv tasks run test:tui` for real pi terminal tests. The TUI tests use a scripted local provider and need no API credentials. See [TUI test guide](docs/tui-tests.md) for setup, focused runs, and failure artifacts.

### Native tooling patches

`pnpm-workspace.yaml` pins patches for the locked oxfmt 0.33.0, oxlint 1.66.0
and `@microsoft/tui-test` 0.1.0-beta.5 loaders. On an Alpine host, Nix Node uses
glibc while `/usr/bin/ldd` describes musl. The unpatched loaders prefer that host
file and request a musl binding,
although pnpm installs the GNU binding for the Node runtime.

The patches give a positive `process.report.getReport().header.glibcVersionRuntime`
result precedence on Linux. Without that result, the original musl/unknown
fallbacks remain unchanged. Package versions, optional dependency selection and
all CI checks stay unchanged. Install with `pnpm install --frozen-lockfile` to
apply the version-bound patches recorded in `pnpm-lock.yaml`.

When updating a patched dependency, inspect its new native loader and remove its
patch only when runtime glibc takes precedence upstream. Otherwise regenerate it with
`pnpm patch` and `pnpm patch-commit`. Validate a fresh frozen install and
`pnpm run ci:fmt`, `pnpm run ci:lint` and `pnpm run test:tui` with glibc Node on an
Alpine host, as well as the normal test suite. Do not force musl dependencies to compensate for a
loader choosing the wrong libc.

## Custom agents

Create a markdown file with frontmatter to define a custom agent:

```markdown
---
description: My specialist agent
tools: read, bash, grep, find, ls
prompt_mode: replace
max_turns: 40
timeout_seconds: 600
---

Your system prompt here.
```

`max_turns` bounds the number of agentic turns; `timeout_seconds` bounds wall-clock runtime regardless of turn count — the agent is aborted once either limit is hit. Both can also be passed as tool parameters (`max_turns`, `timeout_seconds`) or set as defaults via `/agents` settings.

## Local process messaging

The [local messaging API](docs/local-messaging.md) connects process agents through
one authenticated Unix socket broker. The [delegation tools](docs/process-delegation.md)
address parents, children and siblings, answer help requests directly, and retain
the parent host until required results reach its persistent session.

## Requirements

- `@mariozechner/pi-coding-agent` ≥ 0.70.5

## License

MIT

### RPC process runner

The existing runner remains the default. The [companion SDK host](docs/process-runner.md)
enables explicit `runner: "rpc"` delegation with persistent Pi sessions, retained
worktrees, and verified Guard/Sandbox reproduction. Ordinary extension loading
without that host refuses RPC selection because Pi 0.73.0 does not expose the
full live resource inventory to extensions.
Task processes can delegate independent read-only reviewers through the same host.
The shared default limit is four running children and two levels below the root.
