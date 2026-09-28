import { inspectionJournal } from "./inspection-journal.ts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { verifyProtectionSources } from "./protection-sources.ts";
import { TuiTest } from "@microsoft/tui-test";
import { performance } from "node:perf_hooks";
import {
  protectionVM,
  protectionCaseTimeoutMs,
  parentStartupTimeoutMs,
  childStartupPolicy,
  childRunTimeoutSeconds,
  childDoneTimeoutMs,
} from "./parent-startup.ts";

test(
  "interactive companion with real Guard and OS Sandbox uses a protected RPC worktree",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const sources = verifyProtectionSources();
    const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-host-tui-")));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const sessions = join(root, "children");
    const trace = join(root, "prompts.jsonl");
    await mkdir(cwd);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify(
        {
          retry: { enabled: false },
          lastChangelogVersion: "0.73.0",
          guard: { rules: { Agent: "allow", bash: { printf: "allow" } } },
        },
        null,
        2,
      ),
    );
    await writeFile(join(agentDir, "sandbox.json"), JSON.stringify({ enabled: true }));
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
          sessionDirectory: sessions,
          nodeImports: [preload],
          extensions: [
            { path: join(sources.guard.path, "index.ts"), protectionId: "pi-agent-guard" },
            {
              path: join(sources.sandbox.path, "pasa-extension.mjs"),
              protectionId: "pi-agent-sandbox",
            },
            {
              path: fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url)),
              protectionId: null,
            },
          ],
          environmentAllowlist: ["HOME", "PATH", "PASA_TEST_TRACE"],
          credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
          limits: {
            maxConcurrent: 4,
            maxDepth: 2,
            maxTurns: 4,
            timeoutSeconds: childRunTimeoutSeconds(20),
          },
        },
      }),
    );
    const terminal = TuiTest.ephemeral("companion", { timeouts: { text: 20_000, ready: 15_000 } });
    try {
      const started = performance.now();
      const startupBudget = protectionVM ? parentStartupTimeoutMs : 15_000;
      const opened = await terminal.run(
        "env",
        [
          "-i",
          `HOME=${root}`,
          `PATH=${process.env.PATH}`,
          "TERM=xterm-256color",
          "LANG=C.UTF-8",
          "PI_OFFLINE=1",
          "PI_SKIP_VERSION_CHECK=1",
          `PI_CODING_AGENT_DIR=${agentDir}`,
          `PASA_TEST_TRACE=${trace}`,
          `PASA_TEST_STDERR=${join(root, "parent-stderr.log")}`,
          "/bin/sh",
          "-c",
          'exec "$@" 2>"$PASA_TEST_STDERR"',
          "pasa-diagnostic",
          process.execPath,
          "--import",
          preload,
          fileURLToPath(new URL("../../src/process-host.ts", import.meta.url)),
          config,
          "interactive",
        ],
        { cwd, cols: 130, rows: 38, retries: 0 },
      );
      await terminal
        .getByText("process-test")
        .expect({ timeout: Math.max(1, Math.ceil(startupBudget - (performance.now() - started))) });
      // Pi paints the editor before awaiting session_start handlers. Its normal
      // main-loop callback is installed only after initialization. Loaded resources
      // appear after those handlers; editor round trips below then confirm input.
      await terminal
        .getByText("[Extensions]")
        .expect({ timeout: Math.max(1, Math.ceil(startupBudget - (performance.now() - started))) });
      console.log(
        `protected Parent interactive startup: ${Math.round(performance.now() - started)} ms`,
      );
      await terminal.type("editor-ready-marker");
      await terminal.getByText("editor-ready-marker").expect();
      await terminal.press("Home", "Ctrl+K");
      await terminal.getByText("editor-ready-marker").expect({ not: true });
      const prompt =
        "CHILD:tool:" +
        JSON.stringify({
          name: "bash",
          arguments: { command: "printf permitted > permitted.txt; printf denied > .env" },
        });
      await terminal.write(
        "\x1b[200~HOST:" + JSON.stringify({ prompt, isolation: "worktree" }) + "\x1b[201~",
      );
      await terminal.getByText("HOST:").expect();
      await terminal.press("Enter");
      await terminal.getByText("Done").expect({ timeout: childDoneTimeoutMs });
      const files = (await readdir(sessions)).filter((path) => path.endsWith(".jsonl"));
      assert.equal(files.length, 1);
      const entries = (await readFile(join(sessions, files[0]), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const answer = entries.findLast(
        (e) => e.type === "message" && e.message.role === "assistant",
      );
      assert.ok(answer);
      const result = JSON.parse(answer.message.content[0].text);
      console.log(
        `protected interactive Child model response at process age ${result.processAgeMs} ms`,
      );
      assert.notEqual(result.pid, opened.shell_pid);
      assert.notEqual(result.cwd, cwd);
      assert.equal(await readFile(join(result.cwd, "permitted.txt"), "utf8"), "permitted");
      await assert.rejects(readFile(join(result.cwd, ".env")), { code: "ENOENT" });
      assert.ok(
        entries.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "bash" &&
            entry.message.isError === true,
        ),
      );
    } catch (error) {
      console.error(await terminal.text());
      console.error(
        "Provider trace:",
        await readFile(trace, "utf8").catch(() => "<no provider invocation recorded>"),
      );
      throw error;
    } finally {
      await terminal.close();
      await inspectionJournal(join(root, "parent-stderr.log"));
      await rm(root, { recursive: true, force: true });
    }
  },
);
