import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProcessRpc } from "../../src/process-rpc.ts";

const cli = join(
  dirname(fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"))),
  "cli.js",
);
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));

test(
  "real Pi RPC preserves session and cwd across distinct processes without external inference",
  { timeout: 30_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-real-rpc-")));
    const cwd = join(root, "workspace");
    const agent = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");
    const sessionId = randomUUID();
    await mkdir(cwd);
    await mkdir(agent);
    await writeFile(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd,
      }) + "\n",
      { mode: 0o600 },
    );
    let client: ProcessRpc | undefined;
    const start = () =>
      ProcessRpc.start({
        executable: process.execPath,
        // Explicit empty test environment. This fixture does not claim protection parity.
        args: [
          cli,
          "--mode",
          "rpc",
          "--session",
          sessionFile,
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "-e",
          provider,
          "--model",
          "process-test/process-test",
        ],
        cwd,
        environment: {
          HOME: root,
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agent,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        requestTimeoutMs: 10_000,
        verifyReady: async (state, pid) => {
          assert.equal(state.sessionId, sessionId);
          assert.equal(state.sessionFile, sessionFile);
          assert.equal(state.model?.provider, "process-test");
          assert.ok(pid > 0);
          assert.notEqual(pid, process.pid);
        },
      });
    const previous = process.env.PASA_RPC_SECRET;
    process.env.PASA_RPC_SECRET = "must-not-inherit";
    try {
      client = await start();
      const firstPid = client.pid;
      const firstProcess = client.processId;
      const first = JSON.parse(await client.prompt("first", { maxTurns: 3, timeoutMs: 10_000 }));
      assert.deepEqual(first, {
        pid: firstPid,
        cwd,
        users: [[{ type: "text", text: "first" }]],
        inheritedSecret: null,
      });
      await client.close();
      client = undefined;
      assert.ok((await readFile(sessionFile, "utf8")).includes('"role":"assistant"'));
      client = await start();
      assert.notEqual(client.pid, firstPid);
      assert.notEqual(client.processId, firstProcess);
      const second = JSON.parse(
        await client.prompt("follow-up", { maxTurns: 3, timeoutMs: 10_000 }),
      );
      assert.deepEqual(second, {
        pid: client.pid,
        cwd,
        users: [[{ type: "text", text: "first" }], [{ type: "text", text: "follow-up" }]],
        inheritedSecret: null,
      });
    } finally {
      if (previous === undefined) delete process.env.PASA_RPC_SECRET;
      else process.env.PASA_RPC_SECRET = previous;
      await client?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
