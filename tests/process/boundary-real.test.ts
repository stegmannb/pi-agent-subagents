import { inspectionJournal } from "./inspection-journal.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProcessRpc } from "../../src/process-rpc.ts";
import type { ProcessObservation } from "../../src/process-contract.ts";
import { secretFailure } from "./fixtures/boundary-mutation.ts";

const host = fileURLToPath(new URL("../../src/process-host.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
const mutation = fileURLToPath(new URL("./fixtures/boundary-mutation.ts", import.meta.url));
const boundary = fileURLToPath(new URL("../../src/process-boundary.ts", import.meta.url));
const cli = join(
  dirname(fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"))),
  "cli.js",
);
const rows = async (path: string): Promise<any[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

for (const [hook, phase] of [
  ["session_start", "inspect"],
  ["input", "child:input"],
  ["before_agent_start", "child:model"],
  ["session_before_compact", "child:compaction"],
]) {
  for (const failure of hook === "session_start" ? ["resource"] : ["resource", "unknown"]) {
    test(
      `real SDK diagnoses ${failure} rejection in ${hook} without provider invocation or secrets`,
      { timeout: 60_000 },
      async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-boundary-")));
        const cwd = join(root, "repo");
        const agentDir = join(root, "agent");
        const config = join(root, "host.json");
        const settings = join(agentDir, "settings.json");
        const trace = join(root, "provider.jsonl");
        const hookTrace = join(root, "hooks.jsonl");
        await mkdir(cwd);
        await mkdir(agentDir);
        await writeFile(
          settings,
          JSON.stringify({
            compaction: { enabled: true, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
        );
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
        const environment = {
          HOME: root,
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PASA_TEST_TRACE: trace,
          PASA_TEST_STDERR: join(root, "parent-stderr.log"),
          PASA_BOUNDARY_TRACE: hookTrace,
          PASA_BOUNDARY_CONFIG: settings,
          PASA_BOUNDARY_PARENT_CWD: cwd,
          PASA_BOUNDARY_MUTATION: hook,
          PASA_BOUNDARY_FAILURE: failure,
        };
        await writeFile(
          config,
          JSON.stringify({
            inspectionDiagnostics: true,
            cwd,
            agentDir,
            model: { provider: "process-test", id: "process-test" },
            policy: {
              sessionDirectory: join(root, "children"),
              extensions: [provider, mutation].map((path) => ({ path, protectionId: null })),
              environmentAllowlist: [
                "HOME",
                "PATH",
                "PASA_TEST_TRACE",
                "PASA_BOUNDARY_TRACE",
                "PASA_BOUNDARY_CONFIG",
                "PASA_BOUNDARY_PARENT_CWD",
                "PASA_BOUNDARY_MUTATION",
                "PASA_BOUNDARY_FAILURE",
              ],
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
        const events: unknown[] = [];
        let client: ProcessRpc | undefined;
        try {
          client = await ProcessRpc.start({
            executable: "/bin/sh",
            args: [
              "-c",
              'exec "$@" 2>"$PASA_TEST_STDERR"',
              "pasa-diagnostic",
              process.execPath,
              host,
              config,
              "rpc",
            ],
            cwd,
            environment,
            requestTimeoutMs: 15_000,
            verifyReady: async () => {},
            onEvent: (event) => {
              events.push(event);
              const e = event as any;
              if (e.type === "tool_execution_end" && e.toolName === "Agent")
                outcomes.push(e.result.details);
            },
          });
          await client.prompt('HOST:{"prompt":"first","isolation":"worktree"}', {
            maxTurns: 4,
            timeoutMs: 25_000,
          });
          if (hook === "session_before_compact") {
            assert.equal(outcomes[0]?.status, "completed", JSON.stringify(outcomes));
            const file = outcomes[0].process!.sessionFile;
            const entries = await rows(file);
            const last = entries.findLast(
              (e) => e.type === "message" && e.message.role === "assistant",
            );
            assert.ok(last);
            // Seed a resumed session above the real SDK's automatic compaction threshold.
            last.message.usage.input = 131_000;
            last.message.usage.totalTokens = 131_001;
            await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
            await client.prompt(
              `HOST:${JSON.stringify({ prompt: "resume", resume: outcomes[0].agentId })}`,
              { maxTurns: 4, timeoutMs: 25_000 },
            );
          }
          const diagnostics = await inspectionJournal(join(root, "parent-stderr.log"), false);
          assert.ok(
            diagnostics.some(
              (d) =>
                d.stage === (hook === "session_start" ? "startup" : "preprompt") &&
                d.phase === "nodeBinary" &&
                d.event === "end",
            ),
          );
          const outcome = outcomes.at(-1)!;
          assert.equal(outcome.status, "error", JSON.stringify(outcomes));
          assert.equal(
            outcome.error,
            hook === "session_start"
              ? "Pi RPC failed: CHILD_NOT_READY"
              : `Pi RPC failed: ${failure === "resource" ? "RESOURCE_CHANGED" : "CHILD_FAILURE"} [${phase}]`,
          );
          assert.ok(!JSON.stringify(events).includes("SENSITIVE_BOUNDARY_DIAGNOSTIC"));
          assert.ok(!outcome.error.includes(secretFailure));
          assert.equal(
            (await client.getState()).model?.provider,
            "process-test",
            "Parent must remain alive after only its Child exits",
          );
          const hooks = await rows(hookTrace);
          assert.equal(hooks.length, 1, JSON.stringify(hooks));
          assert.equal(hooks[0].hook, hook);
          if (hook !== "session_start") assert.equal(hooks[0].pid, outcome.process!.pid);
          else assert.ok(diagnostics.some((d) => d.phase === "resources" && d.event === "error"));
          assert.equal(
            (await rows(trace)).filter((row) => row.pid === hooks[0].pid).length,
            0,
            "mutation must prevent normal AND compaction provider calls",
          );
          assert.throws(() => process.kill(hooks[0].pid, 0), { code: "ESRCH" });
        } finally {
          await client?.close();
          await inspectionJournal(join(root, "parent-stderr.log"));
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}

test(
  "real SDK cannot invoke a provider with a missing private boundary binding",
  { timeout: 20_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-boundary-missing-")));
    const trace = join(root, "provider.jsonl");
    let client: ProcessRpc | undefined;
    try {
      client = await ProcessRpc.start({
        executable: process.execPath,
        args: [
          cli,
          "--mode",
          "rpc",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "-e",
          provider,
          "-e",
          boundary,
          "--model",
          "process-test/process-test",
        ],
        cwd: root,
        environment: {
          HOME: root,
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: root,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PASA_TEST_TRACE: trace,
        },
        requestTimeoutMs: 10_000,
        verifyReady: async () => {},
      });
      const prompt = client.prompt("must never reach provider", { maxTurns: 2, timeoutMs: 1000 });
      const rejection = assert.rejects(prompt, { code: "TIME_LIMIT" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        (await client.getState()).isStreaming,
        false,
        "an unbound boundary may not terminate a generic Pi host",
      );
      await rejection;
      assert.deepEqual(await rows(trace), []);
    } finally {
      await client?.close();
      await inspectionJournal(join(root, "parent-stderr.log"));
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const qualificationPreset of [null, "unknown", 20000, {}, [], false]) {
  test(`actual private Child rejects invalid bootstrap preset before accessing profile: ${JSON.stringify(qualificationPreset)}`, async () => {
    await assert.rejects(
      ProcessRpc.start({
        executable: process.execPath,
        args: [fileURLToPath(new URL("../../src/process-child.ts", import.meta.url))],
        cwd: tmpdir(),
        environment: {},
        bootstrapData: { qualificationPreset },
        verifyReady: async () => {
          assert.fail("invalid bootstrap cannot reach readiness");
        },
      }),
      { code: "INVALID_QUALIFICATION_PRESET", phase: "child:boot" },
    );
  });
}
