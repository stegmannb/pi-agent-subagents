import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { watch } from "node:fs";
import type { ProcessRegistration } from "../../src/process-lifecycle.ts";
import {
  childStartupPolicy,
  childRunTimeoutSeconds,
  childPromptTimeoutMs,
  protectionCaseTimeoutMs,
  startProtectionParent,
} from "./parent-startup.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(scenario: string, human = false) {
  const root = await realpath(await mkdtemp("/tmp/pasa-life-host-"));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent"),
    children = join(root, "children"),
    socketPath = join(root, "s");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(join(cwd, "work.txt"), "retained work\n");
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "base",
  ]);
  const ready = deferred<ProcessRegistration>(),
    answers = deferred<{ selected: string; input: string; confirmed: boolean }>(),
    disconnected = deferred<void>();
  let childSocket: Socket | undefined;
  const server = createServer((socket) => {
    childSocket = socket;
    let partial = "";
    socket.on("data", (data) => {
      partial += data.toString();
      let index: number;
      while ((index = partial.indexOf("\n")) >= 0) {
        const value = JSON.parse(partial.slice(0, index));
        partial = partial.slice(index + 1);
        if (value.pid) ready.resolve(value);
        else answers.resolve(value);
      }
    });
    socket.on("close", () => disconnected.resolve());
  });
  server.listen(socketPath);
  await once(server, "listening");
  const config = join(root, "host.json");
  await writeFile(
    config,
    JSON.stringify({
      cwd,
      agentDir,
      model: { provider: "process-test", id: "process-test" },
      policy: {
        ...childStartupPolicy,
        ...(human ? { humanAnswerChannel: "rpc" } : {}),
        sessionDirectory: children,
        extensions: [
          {
            path: fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url)),
            protectionId: null,
          },
          {
            path: fileURLToPath(new URL("./fixtures/lifecycle-probe.ts", import.meta.url)),
            protectionId: null,
          },
        ],
        environmentAllowlist: [
          "HOME",
          "PATH",
          "PASA_LIFE_REGISTRY",
          "PASA_LIFE_SOCKET",
          "PASA_LIFE_SCENARIO",
        ],
        credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
        limits: { maxTurns: 4, timeoutSeconds: childRunTimeoutSeconds(20) },
      },
    }),
  );
  const questions: string[] = [],
    outcomes: unknown[] = [];
  const parent = await startProtectionParent({
    executable: process.execPath,
    args: [
      ...(["cleanup", "loss"].includes(scenario)
        ? [
            "--import",
            fileURLToPath(new URL("./fixtures/lifecycle-cleanup-fault.mjs", import.meta.url)),
          ]
        : []),
      fileURLToPath(new URL("../../src/process-host.ts", import.meta.url)),
      config,
      "rpc",
    ],
    cwd,
    environment: {
      HOME: root,
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PASA_LIFE_REGISTRY: join(children, "lifecycle"),
      PASA_LIFE_SOCKET: socketPath,
      PASA_LIFE_SCENARIO: scenario,
    },
    requestTimeoutMs: 15000,
    verifyReady: async () => {},
    onDialog: async (request) => {
      questions.push(request.method);
      if (scenario === "cancel") return new Promise(() => {});
      return {
        type: "extension_ui_response",
        id: request.id,
        ...(request.method === "confirm"
          ? { confirmed: false }
          : { value: request.method === "select" ? "two" : "human explanation" }),
      };
    },
    onEvent: (e) => {
      if (e.type === "tool_execution_end" && e.toolName === "Agent") outcomes.push(e.result);
    },
  });
  const prompt = parent.prompt(
    `HOST:${JSON.stringify({ prompt: 'CHILD:tool:{"name":"bash","arguments":{"command":"echo lifecycle"}}', isolation: "worktree" })}`,
    { maxTurns: 4, timeoutMs: childPromptTimeoutMs },
  );
  void prompt.catch(() => {});
  const run = await ready.promise;
  assert.notEqual(run.pid, parent.pid);
  assert.notEqual(run.pid, process.pid);
  assert.notEqual(run.cwd, cwd);
  return {
    root,
    parent,
    prompt,
    run,
    ready,
    answers,
    disconnected,
    questions,
    outcomes,
    cancelQuestion: () => childSocket!.write("cancel\n"),
    record: async () =>
      JSON.parse(
        await readFile(join(children, "lifecycle", `${run.processId}.json`), "utf8"),
      ) as ProcessRegistration,
    waitState: (predicate: (value: ProcessRegistration) => boolean) =>
      new Promise<ProcessRegistration>((resolve, reject) => {
        const directory = join(children, "lifecycle");
        const watcher = watch(directory, () => void check());
        const timer = setTimeout(() => {
          watcher.close();
          reject(new Error("TEST_LIFECYCLE_STATE_TIMEOUT"));
        }, childPromptTimeoutMs);
        async function check() {
          try {
            const value = JSON.parse(
              await readFile(join(directory, `${run.processId}.json`), "utf8"),
            ) as ProcessRegistration;
            if (predicate(value)) {
              clearTimeout(timer);
              watcher.close();
              resolve(value);
            }
          } catch (error) {
            clearTimeout(timer);
            watcher.close();
            reject(error);
          }
        }
        void check();
      }),
    close: async () => {
      await parent.close();
      childSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
test(
  "actual companion/child routes select/input/denied approval and persists one result before cleanup",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("dialogs", true);
    try {
      assert.deepEqual(await f.answers.promise, {
        selected: "two",
        input: "human explanation",
        confirmed: false,
      });
      await f.prompt;
      await f.disconnected.promise;
      const value = await f.record();
      assert.equal(value.phase, "completed");
      assert.equal(value.delivery?.ingested, true);
      assert.deepEqual(f.questions, ["select", "input", "confirm"]);
      assert.equal(f.outcomes.length, 1);
      assert.equal(await readFile(join(f.run.cwd, "work.txt"), "utf8"), "retained work\n");
      assert.ok((await readFile(f.run.sessionFile, "utf8")).includes("HUMAN_APPROVAL_DENIED"));
    } finally {
      await f.close();
    }
  },
);
for (const stop of ["parent-exiting", "parent-kill", "question-disconnect"] as const)
  test(
    `actual ${stop} stops only the managed own child and retains unresolved evidence`,
    { timeout: protectionCaseTimeoutMs },
    async () => {
      const f = await setup(stop === "question-disconnect" ? "question" : "held");
      try {
        if (stop === "question-disconnect")
          await f.waitState((value) => value.phase === "question");
        if (stop === "parent-exiting") await f.parent.close();
        else process.kill(f.parent.pid, "SIGKILL");
        await f.disconnected.promise;
        await assert.rejects(f.prompt);
        const value = await f.record();
        assert.equal(
          value.parentState,
          stop === "parent-exiting" ? "parent_exiting" : "disconnected",
        );
        assert.notEqual(value.phase, "completed");
        assert.notEqual(value.delivery?.ingested, true);
        assert.equal(f.questions.length, 0);
        assert.equal(await readFile(join(f.run.cwd, "work.txt"), "utf8"), "retained work\n");
        assert.ok((await readFile(f.run.sessionFile, "utf8")).includes(f.run.sessionId));
      } finally {
        await f.close();
      }
    },
  );
for (const ownership of ["manual", "external"] as const)
  test(
    `actual ${ownership} takeover survives parent kill and revokes old routing/actions`,
    { timeout: protectionCaseTimeoutMs },
    async () => {
      const f = await setup("held");
      try {
        await f.parent.command(`/life-control ${JSON.stringify({ handle: f.run, ownership })}`);
        const taken = await f.record();
        assert.equal(taken.ownership, ownership);
        assert.equal(taken.routeParentId, null);
        assert.equal(taken.revision, 1);
        process.kill(f.parent.pid, "SIGKILL");
        await assert.rejects(f.prompt);
        await f.waitState((value) => value.parentState === "disconnected");
        assert.doesNotThrow(() => process.kill(f.run.pid!, 0));
        const value = await f.record();
        assert.equal(value.ownership, ownership);
        assert.notEqual(value.phase, "completed");
        assert.equal(await readFile(join(f.run.cwd, "work.txt"), "utf8"), "retained work\n");
      } finally {
        process.kill(f.run.pid!, "SIGKILL");
        await f.disconnected.promise;
        await f.close();
      }
    },
  );

test(
  "persisted result survives failed cleanup; retry closes the same run without another result or restart",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("cleanup");
    try {
      await f.prompt;
      const failed = await f.record();
      assert.equal(failed.phase, "cleanup-error");
      assert.equal(failed.delivery?.ingested, true);
      assert.doesNotThrow(() => process.kill(failed.pid!, 0));
      assert.ok(JSON.stringify(f.outcomes).includes("Process lifecycle pending"));
      await f.parent.command(
        `/life-control ${JSON.stringify({ handle: failed, action: "assert-reserved" })}`,
      );
      const state = await f.parent.getState();
      const countResults = async () =>
        (await readFile(state.sessionFile!, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (entry) =>
              entry.customType === "pasa:result" && entry.data.resultId === failed.resultId,
          );
      assert.equal((await countResults()).length, 1);
      await f.parent.command(
        `/life-control ${JSON.stringify({ handle: failed, action: "cleanup" })}`,
      );
      await f.disconnected.promise;
      const done = await f.record();
      assert.equal(done.phase, "completed");
      assert.equal(done.processId, failed.processId);
      assert.equal(done.pid, failed.pid);
      await f.parent.command(
        `/life-control ${JSON.stringify({ handle: done, action: "assert-released" })}`,
      );
      assert.equal((await countResults()).length, 1);
      assert.equal(await readFile(join(done.cwd, "work.txt"), "utf8"), "retained work\n");
      await f.parent.close();
      assert.equal((await f.record()).phase, "completed");
    } finally {
      await f.close();
    }
  },
);

test(
  "actual SDK AbortSignal cancels the correlated parent dialog without granting approval",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("cancel", true);
    try {
      await f.waitState((value) => value.phase === "question");
      f.cancelQuestion();
      assert.deepEqual(await f.answers.promise, { confirmed: false });
      await f.prompt;
      await f.disconnected.promise;
      const value = await f.record();
      assert.equal(value.phase, "completed");
      assert.equal(value.delivery?.ingested, true);
      assert.ok((await readFile(value.sessionFile, "utf8")).includes("HUMAN_APPROVAL_CANCELLED"));
    } finally {
      await f.close();
    }
  },
);

test(
  "explicit abort after persisted result and failed cleanup stops only that run and retains its result",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("cleanup");
    try {
      await f.prompt;
      const value = await f.record();
      assert.equal(value.phase, "cleanup-error");
      await f.parent.command(`/life-control ${JSON.stringify({ handle: value, action: "abort" })}`);
      await f.disconnected.promise;
      const stopped = await f.record();
      assert.equal(stopped.phase, "stopped");
      assert.equal(stopped.delivery?.ingested, true);
      assert.equal(stopped.processId, value.processId);
      assert.ok((await readFile(stopped.sessionFile, "utf8")).includes("TEST_PERSISTED_RESULT"));
    } finally {
      await f.close();
    }
  },
);

test(
  "actual process loss before confirmed parent ingestion retains unresolved result identity and refuses success cleanup",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("loss");
    try {
      await f.prompt;
      await f.disconnected.promise;
      const value = await f.record();
      assert.equal(value.phase, "lost");
      assert.equal(value.delivery?.produced, true);
      assert.equal(value.delivery?.ingested, false);
      assert.equal(value.delivery?.identity.childProcessId, value.processId);
      assert.ok(JSON.stringify(f.outcomes).includes("Agent failed"));
      const before = JSON.stringify(value);
      await assert.rejects(
        f.parent.command(`/life-control ${JSON.stringify({ handle: value, action: "cleanup" })}`),
      );
      assert.equal(JSON.stringify(await f.record()), before);
      assert.equal(await readFile(join(value.cwd, "work.txt"), "utf8"), "retained work\n");
      assert.ok((await readFile(value.sessionFile, "utf8")).includes("TEST_PERSISTED_RESULT"));
    } finally {
      await f.close();
    }
  },
);
