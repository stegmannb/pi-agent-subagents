/**
 * cmux.ts — Optional cmux sidebar integration for agent observability.
 *
 * All functions are no-ops when cmux is not available or integration is disabled.
 * Detects cmux via CMUX_WORKSPACE_ID environment variable.
 */

import { execFile } from "node:child_process";

export function isCmuxAvailable(): boolean {
  return !!process.env.CMUX_WORKSPACE_ID;
}

function run(args: string[]): void {
  execFile("cmux", args, () => { /* ignore errors — cmux is best-effort */ });
}

export interface CmuxOptions {
  enabled: boolean;
  lingerMs: number;
}

export class CmuxReporter {
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private opts: CmuxOptions) {}

  get active(): boolean {
    return this.opts.enabled && isCmuxAvailable();
  }

  updateOptions(opts: Partial<CmuxOptions>): void {
    Object.assign(this.opts, opts);
  }

  onAgentStart(description: string, runningCount: number): void {
    if (!this.active) return;
    this.cancelLinger();
    run(["set-status", "pi",
      `${runningCount} agent${runningCount === 1 ? "" : "s"} running`,
      "--color", "#3b82f6"]);
    run(["log", "--level", "progress", "--source", "subagents",
      `Started: ${description}`]);
  }

  onAgentComplete(description: string, status: string, runningCount: number): void {
    if (!this.active) return;
    const level =
      status === "completed" ? "success" :
      status === "error" ? "error" :
      "warning";
    run(["log", "--level", level, "--source", "subagents",
      `${description}: ${status}`]);

    if (runningCount === 0) {
      run(["set-status", "pi", "Done ✓", "--color", "#22c55e"]);
      this.scheduleLinger();
    } else {
      run(["set-status", "pi",
        `${runningCount} agent${runningCount === 1 ? "" : "s"} running`,
        "--color", "#3b82f6"]);
    }
  }

  private scheduleLinger(): void {
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = undefined;
      if (!this.active) return;
      run(["clear-status", "pi"]);
      run(["clear-progress"]);
    }, this.opts.lingerMs);
  }

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
  }

  dispose(): void {
    this.cancelLinger();
    if (this.active) {
      run(["clear-status", "pi"]);
      run(["clear-progress"]);
    }
  }
}
