import { inspectionJournal } from "./inspection-journal.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProcessRpc } from "../../src/process-rpc.ts";
import type { ProcessObservation } from "../../src/process-contract.ts";
import { attachProcessRunner } from "../../src/process-runner.ts";
import type { ProcessHostPolicy } from "../../src/process-contract.ts";

const host = fileURLToPath(new URL("../../src/process-host.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));

test("host attach rejects invalid child startup policy before accessing resources or launching a child", async () => {
  for (const childStartupTimeoutMs of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    120001,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    "1000",
  ])
    await assert.rejects(
      attachProcessRunner(
        () => {
          throw new Error("must not access parent for invalid policy");
        },
        { childStartupTimeoutMs } as ProcessHostPolicy,
      ),
      { code: "INVALID_CHILD_STARTUP_TIMEOUT" },
    );
});

test(
  "companion RPC host Agent tool starts and resumes a persistent child in its retained worktree",
  { timeout: 60_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-host-")));
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir);
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    const config = join(root, "host.json");
    await writeFile(
      config,
      JSON.stringify({
        cwd,
        agentDir,
        model: { provider: "process-test", id: "process-test" },
        policy: {
          sessionDirectory: join(root, "children"),
          extensions: [{ path: provider, protectionId: null }],
          environmentAllowlist: ["HOME", "PATH"],
          credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
          limits: { maxConcurrent: 4, maxDepth: 2, maxTurns: 4, timeoutSeconds: 20 },
        },
      }),
    );
    const outcomes: Array<{
      status: string;
      agentId: string;
      process?: ProcessObservation;
      error?: string;
    }> = [];
    const client = await ProcessRpc.start({
      executable: "/bin/sh",
      args: [
        "-c",
        'exec "$@" 2>"$PASA_TEST_STDERR"',
        "pasa-default",
        process.execPath,
        host,
        config,
        "rpc",
      ],
      cwd,
      environment: {
        HOME: root,
        PASA_TEST_STDERR: join(root, "parent-stderr.log"),
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      requestTimeoutMs: 15_000,
      verifyReady: async (state) => {
        assert.equal(state.model?.provider, "process-test");
      },
      onEvent: (event) => {
        const e = event as any;
        if (e.type === "tool_execution_end" && e.toolName === "Agent")
          outcomes.push(
            e.result.details ?? { status: "missing-details", error: JSON.stringify(e.result) },
          );
      },
    });
    try {
      await client.prompt('HOST:{"prompt":"first","isolation":"worktree"}', {
        maxTurns: 4,
        timeoutMs: 25_000,
      });
      assert.equal(outcomes[0]?.status, "completed", JSON.stringify(outcomes));
      const first = outcomes[0].process!;
      assert.ok(first);
      assert.notEqual(first.pid, process.pid);
      assert.notEqual(first.pid, client.pid);
      assert.notEqual(first.cwd, cwd);
      assert.ok((await readFile(first.sessionFile, "utf8")).includes("Task:\\nfirst"));
      await client.prompt(
        `HOST:${JSON.stringify({ prompt: "follow-up", resume: outcomes[0].agentId })}`,
        { maxTurns: 4, timeoutMs: 25_000 },
      );
      assert.equal(outcomes[1]?.status, "completed", JSON.stringify(outcomes));
      const second = outcomes[1].process!;
      assert.equal(second.taskId, first.taskId);
      assert.equal(second.agentId, first.agentId);
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(second.sessionFile, first.sessionFile);
      assert.equal(second.cwd, first.cwd);
      assert.notEqual(second.pid, first.pid);
      assert.notEqual(second.processId, first.processId);
      assert.ok((await readFile(second.sessionFile, "utf8")).includes("Task:\\nfollow-up"));
      assert.deepEqual(await inspectionJournal(join(root, "parent-stderr.log"), false), []);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
