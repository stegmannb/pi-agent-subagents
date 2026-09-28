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

const sources = verifyProtectionSources();
const host = fileURLToPath(new URL("../../src/process-host.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/role-provider.ts", import.meta.url));

test(
  "actual protected Explore child enforces readOnly tools before first model invocation",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-role-")));
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const trace = join(root, "role.jsonl");
    await mkdir(cwd);
    await mkdir(agentDir);
    await writeFile(trace, "");
    await writeFile(join(cwd, "readable.txt"), "read-only role can read this committed marker");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "add", "readable.txt"]);
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "init",
    ]);
    // Allow the probes in Guard so a Guard refusal cannot masquerade as role enforcement.
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify(
        {
          retry: { enabled: false },
          guard: {
            rules: {
              Agent: "allow",
              read: "allow",
              write: "allow",
              role_mutation: "allow",
              bash: { printf: "allow" },
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(agentDir, "sandbox.json"), JSON.stringify({ enabled: true }));
    const preload = join(sources.sandbox.path, "protection-source.mjs");
    const config = join(root, "host.json");
    await writeFile(
      config,
      JSON.stringify({
        inspectionDiagnostics: true,
        cwd,
        agentDir,
        model: { provider: "role-test", id: "role-test" },
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
          environmentAllowlist: ["HOME", "PATH", "PASA_ROLE_TRACE"],
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
    const outcomes: Array<{ status: string; process?: ProcessObservation }> = [];
    let client: ProcessRpc | undefined;
    try {
      client = await startProtectionParent({
        executable: "/bin/sh",
        args: [
          "-c",
          'exec "$@" 2>"$PASA_TEST_STDERR"',
          "pasa-role-test",
          process.execPath,
          "--import",
          preload,
          host,
          config,
          "rpc",
        ],
        cwd,
        environment: {
          HOME: root,
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDir,
          PASA_ROLE_TRACE: trace,
          PASA_TEST_STDERR: join(root, "parent-stderr.log"),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        requestTimeoutMs: 20_000,
        verifyReady: async (state) => {
          assert.equal(state.model?.provider, "role-test");
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
      const mutations = (prefix: string) => [
        { name: "bash", arguments: { command: `printf bash > ${prefix}-bash.txt` } },
        { name: "write", arguments: { path: `${prefix}-write.txt`, content: "write" } },
        { name: "role_mutation", arguments: { path: `${prefix}-custom.txt` } },
      ];
      // First prove every mutation tool really exists and can execute with this live policy.
      await client.prompt(`HOST:${JSON.stringify(mutations("parent"))}`, {
        maxTurns: 4,
        timeoutMs: 45_000,
      });
      assert.equal(await readFile(join(cwd, "parent-bash.txt"), "utf8"), "bash");
      assert.equal(await readFile(join(cwd, "parent-write.txt"), "utf8"), "write");
      assert.equal(
        await readFile(join(cwd, "parent-custom.txt"), "utf8"),
        "custom mutation executed",
      );
      const calls = [{ name: "read", arguments: { path: "readable.txt" } }, ...mutations("child")];
      await client.prompt(
        `HOST:${JSON.stringify([
          {
            name: "Agent",
            arguments: {
              description: "Protected role probe",
              subagent_type: "Explore",
              runner: "rpc",
              model: "role-test/role-test",
              isolation: "worktree",
              prompt: `CHILD:${JSON.stringify(calls)}`,
            },
          },
        ])}`,
        { maxTurns: 4, timeoutMs: childPromptTimeoutMs },
      );
      assert.equal(outcomes[0]?.status, "completed", JSON.stringify(outcomes));
      const child = outcomes[0].process!;
      assert.ok(child && child.pid !== client.pid && child.cwd !== cwd);
      const events = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const first = events.find((event) => event.pid === child.pid && event.kind === "invocation");
      assert.ok(first?.prompt.startsWith("Task:\nCHILD:"), JSON.stringify(events));
      console.log(
        `protected role Child first model invocation at process age ${first.processAgeMs} ms`,
      );
      const parent = events.find(
        (event) => event.pid === client!.pid && event.kind === "invocation",
      );
      for (const name of ["read", "bash", "write", "role_mutation"])
        assert.ok(parent.tools.includes(name), `${name} must actually be offered in Parent`);
      assert.deepEqual(
        [...first.tools].sort(),
        parent.tools.filter((name: string) => ["read", "grep", "find", "ls"].includes(name)).sort(),
        "first Child invocation must receive exactly the available read-only tools",
      );
      assert.ok(first.tools.includes("read"));
      assert.ok(
        first.tools.every((name: string) => ["read", "grep", "find", "ls"].includes(name)),
        JSON.stringify(first),
      );
      for (const name of ["bash", "write", "edit", "role_mutation"])
        assert.ok(
          !first.tools.includes(name),
          `${name} must be absent before the first model invocation`,
        );
      assert.ok(
        events.some((event) => event.pid === child.pid && event.kind === "registered"),
        "custom tool must actually load in Child",
      );
      assert.ok(
        events.some((event) => event.pid === client!.pid && event.kind === "mutation"),
        "custom handler must execute in Parent",
      );
      assert.ok(
        !events.some((event) => event.pid === child.pid && event.kind === "mutation"),
        "custom handler must never execute in Child",
      );
      const messages = (await readFile(child.sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
      const requested = messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .filter((part) => part.type === "toolCall")
        .map((part) => part.name);
      assert.deepEqual(
        requested,
        calls.map((call) => call.name),
        "actual Child model must attempt every probe",
      );
      const results = messages.filter((message) => message.role === "toolResult");
      const read = results.find((message) => message.toolName === "read");
      assert.ok(read && !read.isError, JSON.stringify(results));
      assert.match(JSON.stringify(read.content), /read-only role can read this committed marker/);
      for (const name of ["bash", "write", "role_mutation"]) {
        const result = results.find((message) => message.toolName === name);
        assert.equal(result?.isError, true, `${name} must be refused by real dispatch`);
        assert.ok(
          JSON.stringify(result.content).includes(`Tool ${name} not found`),
          JSON.stringify(result),
        );
      }
      for (const suffix of ["bash", "write", "custom"])
        await assert.rejects(readFile(join(child.cwd, `child-${suffix}.txt`)), { code: "ENOENT" });
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
