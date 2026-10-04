import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";
import type { ProcessRegistration } from "../../src/process-lifecycle.ts";
import {
  childStartupPolicy,
  childRunTimeoutSeconds,
  childPromptTimeoutMs,
  startProtectionParent,
} from "./parent-startup.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export async function setup(scenario: string, human = false, duplicate = false) {
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
        ...(duplicate
          ? {
              nodeImports: [
                fileURLToPath(new URL("./fixtures/qualification-redelivery.mjs", import.meta.url)),
              ],
            }
          : {}),
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
          "PASA_QUALIFICATION_DUPLICATE",
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
      ...(duplicate ? { PASA_QUALIFICATION_DUPLICATE: "1" } : {}),
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
      if (duplicate) console.log(`Qualification lifecycle fixture retained at ${root}`);
      else await rm(root, { recursive: true, force: true });
    },
  };
}
