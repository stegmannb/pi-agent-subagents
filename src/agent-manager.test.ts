import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { AgentManager, agentFailureReason } from "./agent-manager.ts";
import type { AgentRecord } from "./types.ts";
import { cleanupWorktree, createWorktree, inspectWorktree } from "./worktree.ts";

for (const removal of ["clearCompleted", "cleanup"] as const) {
  test(`abort keeps worktree ownership through ${removal} and rejects overlapping resume`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-manager-lifetime-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init");
    await writeFile(join(cwd, "tracked"), "fixture\n");
    git("add", "tracked");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "initial",
    );
    const worktree = await createWorktree(cwd, "lifetime-test");

    let finish!: () => void;
    const execution = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let prompts = 0;
    let disposed = 0;
    const session = {
      messages: [],
      subscribe: () => () => {},
      prompt: () => {
        prompts++;
        return execution;
      },
      dispose: () => {
        disposed++;
      },
    } as unknown as AgentSession;
    const record: AgentRecord = {
      id: "lifetime-test",
      type: "general-purpose",
      description: "lifetime regression",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      abortController: new AbortController(),
      session,
      worktree,
    };
    const manager = new AgentManager();
    t.after(() => {
      finish();
      manager.dispose();
    });
    // Seed a completed session without a provider; resumeAgent itself runs against the gated session.
    const internals = manager as unknown as { agents: Map<string, AgentRecord>; cleanup(): void };
    internals.agents.set(record.id, record);
    const running = manager.resume(record.id, "continue");
    assert.equal(prompts, 1);
    assert.equal(record.worktreeActive, true);
    assert.equal(manager.abort(record.id), true);
    assert.equal(record.status, "stopped");
    record.completedAt = 0; // Make the stopped record eligible for timer expiry too.

    if (removal === "cleanup") internals.cleanup();
    else manager.clearCompleted();
    assert.equal(manager.getRecord(record.id), record);
    assert.equal(disposed, 0);
    assert.equal(
      manager.listAgents().some((r) => r.worktree?.id === worktree.id && r.worktreeActive),
      true,
    );
    assert.equal(await manager.resume(record.id, "must not overlap"), undefined);
    assert.equal(prompts, 1);
    assert.equal(record.worktreeActive, true);
    assert.equal((await inspectWorktree(worktree)).exists, true);

    finish();
    assert.equal(await running, record);
    assert.equal(record.worktreeActive, false);
    assert.equal(await manager.resume(record.id, "after actual completion"), record);
    assert.equal(prompts, 2);
    assert.equal(record.worktreeActive, false);
    record.completedAt = 0;
    if (removal === "cleanup") internals.cleanup();
    else manager.clearCompleted();
    assert.equal(manager.getRecord(record.id), undefined);
    assert.equal(disposed, 1);
    assert.equal((await inspectWorktree(worktree)).exists, true);
    assert.equal((await cleanupWorktree(cwd, worktree)).removed, true);
  });
}

test("agentFailureReason names the process phase when the run recorded no error", () => {
  const withPhase = (phase: string) =>
    agentFailureReason({ process: { phase } } as unknown as Pick<AgentRecord, "error" | "process">);
  assert.equal(withPhase("lost"), "process identity lost, no process is left to resume");
  assert.equal(
    withPhase("uncertain"),
    "process identity uncertain, verify the process before resuming",
  );
  assert.equal(withPhase("detached"), "no failure reason reported");
});

test("agentFailureReason prefers a recorded error", () => {
  assert.equal(
    agentFailureReason({ error: "worktree creation failed" }),
    "worktree creation failed",
  );
  assert.equal(agentFailureReason({}), "no failure reason reported");
});

test("ordinary extension refuses RPC selection before recording a phantom agent", async () => {
  const { createEventBus } = await import("@mariozechner/pi-coding-agent");
  const manager = new AgentManager();
  try {
    assert.throws(
      () =>
        manager.spawn(
          { events: createEventBus() } as any,
          {} as any,
          "general-purpose",
          "never run",
          { description: "missing host", runner: "rpc" },
        ),
      { code: "LIVE_PARENT_INVENTORY_UNAVAILABLE" },
    );
    assert.equal(manager.listAgents().length, 0);
    assert.equal(manager.hasRunning(), false);
  } finally {
    manager.dispose();
  }
});
