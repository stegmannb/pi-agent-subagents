import { inspectionJournal } from "./inspection-journal.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ProcessRpc } from "../../src/process-rpc.ts";
import {
  startProtectionParent,
  protectionCaseTimeoutMs,
  childStartupPolicy,
  childRunTimeoutSeconds,
  childPromptTimeoutMs,
} from "./parent-startup.ts";
import type { ProcessObservation } from "../../src/process-contract.ts";
import { verifyProtectionSources } from "./protection-sources.ts";

// This suite deliberately fails when exact real dependencies are unavailable.
const sources = verifyProtectionSources();
const host = fileURLToPath(new URL("../../src/process-host.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));

for (const scenario of [
  "protected-worktree",
  "global-agentdir-in-parent",
  "missing-target-config",
  "config-drift",
  "missing-preload",
] as const) {
  test(
    `actual Guard + OS Sandbox through Agent RPC: ${scenario}`,
    { timeout: protectionCaseTimeoutMs },
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-protected-")));
      const cwd = join(root, "repo");
      const agentDir =
        scenario === "global-agentdir-in-parent" ? join(cwd, "shared-agent") : join(root, "agent");
      const trace = join(root, "prompts.jsonl");
      await mkdir(cwd);
      await mkdir(agentDir);
      await writeFile(trace, "");
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
      // Configure before real module loading; don't mutate or reset live policies.
      const settings = {
        retry: { enabled: false },
        guard: { rules: { Agent: "allow", bash: { printf: "allow" } } },
      };
      await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
      const sandboxConfig = join(agentDir, "sandbox.json");
      await writeFile(sandboxConfig, JSON.stringify({ enabled: true }));
      if (scenario === "missing-target-config") {
        await mkdir(join(cwd, ".pi"));
        await writeFile(
          join(cwd, ".pi/sandbox.json"),
          JSON.stringify({ filesystem: { allowRead: [root] } }),
        );
      }
      const preload = join(sources.sandbox.path, "protection-source.mjs");
      const config = join(root, "host.json");
      await writeFile(
        config,
        JSON.stringify({
          inspectionDiagnostics: true,
          cwd,
          agentDir,
          model: { provider: "process-test", id: "process-test" },
          policy: {
            ...childStartupPolicy,
            sessionDirectory: join(root, "children"),
            extensions: [
              { path: provider, protectionId: null },
              { path: join(sources.guard.path, "index.ts"), protectionId: "pi-agent-guard" },
              {
                path: join(sources.sandbox.path, "pasa-extension.mjs"),
                protectionId: "pi-agent-sandbox",
              },
            ],
            nodeImports: [preload],
            environmentAllowlist: ["HOME", "PATH", "PASA_TEST_TRACE"],
            credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
            limits: {
              maxConcurrent: 4,
              maxDepth: 2,
              maxTurns: 4,
              timeoutSeconds: childRunTimeoutSeconds(30),
            },
          },
        }),
      );
      const outcomes: Array<{
        status: string;
        agentId: string;
        error?: string;
        process?: ProcessObservation;
      }> = [];
      let client: ProcessRpc | undefined;
      try {
        client = await startProtectionParent({
          executable: "/bin/sh",
          args: [
            "-c",
            'exec "$@" 2>"$PASA_TEST_STDERR"',
            "pasa-protection-test",
            process.execPath,
            ...(scenario === "missing-preload" ? [] : ["--import", preload]),
            host,
            config,
            "rpc",
          ],
          cwd,
          environment: {
            HOME: root,
            PATH: process.env.PATH,
            PI_CODING_AGENT_DIR: agentDir,
            PASA_TEST_TRACE: trace,
            PASA_TEST_STDERR: join(root, "parent-stderr.log"),
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
          },
          requestTimeoutMs: 20_000,
          verifyReady: async (state) => {
            assert.equal(state.model?.provider, "process-test");
          },
          onEvent: (event) => {
            const e = event as any;
            if (e.type === "extension_error") console.error(e);
            if (e.type === "tool_execution_end" && e.toolName === "Agent")
              outcomes.push(
                e.result.details ?? { status: "missing-details", error: JSON.stringify(e.result) },
              );
          },
        });
        if (scenario === "config-drift")
          await writeFile(sandboxConfig, JSON.stringify({ enabled: false }));
        // One shell execution must reach the allowed write and then hit the kernel denial.
        // A pre-tool refusal cannot satisfy both assertions below.
        const task = `CHILD:tool:${JSON.stringify({ name: "bash", arguments: { command: "printf permitted > permitted.txt; printf denied > .env" } })}`;
        await client.prompt(`HOST:${JSON.stringify({ prompt: task, isolation: "worktree" })}`, {
          maxTurns: 4,
          timeoutMs: childPromptTimeoutMs,
        });
        const prompts = (await readFile(trace, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const childPrompts = prompts.filter((p) => p.pid !== client!.pid);
        if (childPrompts.length)
          console.log(
            `protected Child first model invocation at process age ${childPrompts[0].processAgeMs} ms`,
          );
        if (scenario !== "protected-worktree" && scenario !== "global-agentdir-in-parent") {
          assert.equal(outcomes[0]?.status, "error", JSON.stringify(outcomes));
          assert.equal(
            childPrompts.length,
            0,
            "readiness refusal must happen before any child provider invocation",
          );
          return;
        }
        assert.equal(outcomes[0]?.status, "completed", JSON.stringify(outcomes));
        const first = outcomes[0].process!;
        assert.ok(first && first.pid !== client.pid && first.cwd !== cwd);
        assert.equal(await readFile(join(first.cwd, "permitted.txt"), "utf8"), "permitted");
        await assert.rejects(readFile(join(first.cwd, ".env")), { code: "ENOENT" });
        const sessionEntries = (await readFile(first.sessionFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.ok(
          sessionEntries.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolName === "bash" &&
              entry.message.isError === true,
          ),
          "actual shell denial must be recorded as a structured tool error",
        );
        assert.ok(childPrompts.length > 0);
        await client.prompt(
          `HOST:${JSON.stringify({ prompt: "follow-up", resume: outcomes[0].agentId })}`,
          { maxTurns: 4, timeoutMs: childPromptTimeoutMs },
        );
        assert.equal(outcomes[1]?.status, "completed", JSON.stringify(outcomes));
        const second = outcomes[1].process!;
        assert.equal(second.sessionId, first.sessionId);
        assert.equal(second.cwd, first.cwd);
        assert.notEqual(second.pid, first.pid);
        assert.notEqual(second.processId, first.processId);
      } catch (error) {
        console.error(await readFile(join(root, "parent-stderr.log"), "utf8").catch(() => ""));
        throw error;
      } finally {
        await client?.close();
        await inspectionJournal(join(root, "parent-stderr.log"));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
