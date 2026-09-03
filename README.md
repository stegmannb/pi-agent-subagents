> **Disclaimer:** This is a vibe-coded plugin created for myself to test if a flow like this makes sense for me. Use at your own risk.

# pi-agent-subagents

A [pi](https://github.com/mariozechner/pi) extension that adds autonomous sub-agent support to the coding agent.

## What it does

Provides three tools and a `/agents` management command:

| Tool | Description |
|------|-------------|
| `Agent` | Spawn a sub-agent for a complex multi-step task (foreground or background) |
| `get_subagent_result` | Check status and retrieve output from a background agent |
| `steer_subagent` | Send a mid-run steering message to a running agent |

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

Use `isolation: "worktree"` whenever that `cwd` is a git repository with at least one commit. It creates a temporary worktree from committed `HEAD`. Omit isolation only when that is not possible (not a git repo, no commits) or the agent must see uncommitted/untracked files in the live working tree. Invalid isolation requests fail.

Run `/agents` in the pi TUI to browse agent types, manage running agents, and adjust settings (concurrency, max turns, join mode).

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

## Requirements

- `@mariozechner/pi-coding-agent` ≥ 0.70.5

## License

MIT
