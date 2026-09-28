import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TuiTest } from "@microsoft/tui-test";

test(
  "interactive companion without Herdr uses the same RPC child mode",
  { timeout: 40_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-host-tui-")));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const sessions = join(root, "children");
    await mkdir(cwd);
    await mkdir(agentDir);
    const config = join(root, "host.json");
    await writeFile(
      config,
      JSON.stringify({
        cwd,
        agentDir,
        model: { provider: "process-test", id: "process-test" },
        policy: {
          sessionDirectory: sessions,
          extensions: [
            {
              path: fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url)),
              protectionId: null,
            },
          ],
          environmentAllowlist: ["HOME", "PATH"],
          credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
          limits: { maxConcurrent: 4, maxDepth: 2, maxTurns: 4, timeoutSeconds: 20 },
        },
      }),
    );
    const terminal = TuiTest.ephemeral("companion", { timeouts: { text: 20_000, ready: 15_000 } });
    try {
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
          process.execPath,
          fileURLToPath(new URL("../../src/process-host.ts", import.meta.url)),
          config,
          "interactive",
        ],
        { cwd, cols: 130, rows: 38, retries: 0 },
      );
      await terminal.getByText("process-test").expect({ timeout: 15_000 });
      await terminal.type("editor-ready-marker");
      await terminal.getByText("editor-ready-marker").expect();
      await terminal.press("Home", "Ctrl+K");
      await terminal.write('\x1b[200~HOST:{"prompt":"interactive-child"}\x1b[201~');
      await terminal.press("Enter");
      await terminal.getByText("Done").expect({ timeout: 20_000 });
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
      assert.notEqual(result.pid, opened.shell_pid);
      assert.equal(result.cwd, cwd);
      assert.equal(result.users[0][0].text, "Task:\ninteractive-child");
    } finally {
      await terminal.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
