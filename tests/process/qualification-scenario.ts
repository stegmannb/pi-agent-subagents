import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiTest } from "@microsoft/tui-test";
import { ProcessRpc } from "../../src/process-rpc.ts";
import {
  childStartupPolicy,
  childRunTimeoutSeconds,
  childPromptTimeoutMs,
  childDoneTimeoutMs,
  parentStartupTimeoutMs,
  startProtectionParent,
} from "./parent-startup.ts";
import { verifyProtectionSources } from "./protection-sources.ts";
import { inspectionJournal } from "./inspection-journal.ts";

export async function qualificationScenario(
  mode: "async" | "group" | "smart",
  interactive = false,
  protectedHost = false,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-nested-qualification-")));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent"),
    children = join(root, "children");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(join(cwd, "review.txt"), "fixed input for independent review\n");
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
  await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ defaultJoinMode: mode }));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        retry: { enabled: false },
        guard: {
          rules: { Agent: "allow", read: "allow", write: "allow", report_complete: "allow" },
        },
      },
      null,
      2,
    ),
  );
  const extensions: Array<{ path: string; protectionId: string | null }> = [
    {
      path: fileURLToPath(new URL("./fixtures/qualification-provider.ts", import.meta.url)),
      protectionId: null,
    },
  ];
  const imports: string[] = [];
  if (protectedHost) {
    const sources = verifyProtectionSources();
    await writeFile(join(agentDir, "sandbox.json"), JSON.stringify({ enabled: true }));
    extensions.push(
      { path: join(sources.guard.path, "index.ts"), protectionId: "pi-agent-guard" },
      { path: join(sources.sandbox.path, "pasa-extension.mjs"), protectionId: "pi-agent-sandbox" },
    );
    imports.push(join(sources.sandbox.path, "protection-source.mjs"));
  }
  const config = join(root, "host.json");
  await writeFile(
    config,
    JSON.stringify({
      cwd,
      agentDir,
      inspectionDiagnostics: protectedHost,
      model: { provider: "qualification-test", id: "qualification-test" },
      policy: {
        ...childStartupPolicy,
        sessionDirectory: children,
        extensions,
        nodeImports: imports,
        environmentAllowlist: ["HOME", "PATH", "PASA_QUALIFICATION_DIR"],
        credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
        limits: {
          maxConcurrent: 3,
          maxDepth: 2,
          maxTurns: 16,
          timeoutSeconds: childRunTimeoutSeconds(30),
        },
      },
    }),
  );
  const environment = {
    HOME: root,
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PASA_QUALIFICATION_DIR: root,
    PASA_TEST_STDERR: join(root, "stderr.log"),
  };
  const args = [
    "-c",
    'exec "$@" 2>"$PASA_TEST_STDERR"',
    "pasa-qualification",
    process.execPath,
    ...imports.flatMap((path) => ["--import", path]),
    fileURLToPath(new URL("../../src/process-host.ts", import.meta.url)),
    config,
    interactive ? "interactive" : "rpc",
  ];
  let client: ProcessRpc | undefined;
  let terminal: ReturnType<typeof TuiTest.ephemeral> | undefined;
  const jsonl = async (path: string): Promise<any[]> =>
    (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    if (interactive) {
      terminal = TuiTest.ephemeral("qualification", {
        timeouts: { text: childDoneTimeoutMs, ready: parentStartupTimeoutMs },
      });
      await terminal.run(
        "env",
        [
          "-i",
          ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
          "/bin/sh",
          ...args,
        ],
        { cwd, cols: 150, rows: 42, retries: 0 },
      );
      await terminal.getByText("qualification-test").expect({ timeout: parentStartupTimeoutMs });
      await terminal.type("editor-ready-marker");
      await terminal.getByText("editor-ready-marker").expect();
      await terminal.press("Home", "Ctrl+K");
      await terminal.write("\x1b[200~QUALIFY_ROOT\x1b[201~");
      await terminal.press("Enter");
      await terminal
        .getByText("QUALIFICATION_ROOT_FINISHED")
        .expect({ timeout: childDoneTimeoutMs });
    } else {
      client = await startProtectionParent({
        executable: "/bin/sh",
        args,
        cwd,
        environment,
        onSpawn: async (spawned) => {
          await writeFile(
            join(root, "parent-process.json"),
            JSON.stringify({
              pid: spawned.pid,
              expectedNode: process.execPath,
              stage: "spawn-before-readiness",
              proc: Object.fromEntries(
                await Promise.all(
                  ["stat", "status", "cmdline", "maps"].map(async (field) => [
                    field,
                    await readFile(`/proc/${spawned.pid}/${field}`, "utf8").catch(() => null),
                  ]),
                ),
              ),
            }),
          );
        },
        verifyReady: async (state: any) => assert.equal(state.model.provider, "qualification-test"),
      });
      await client.prompt("QUALIFY_ROOT", { maxTurns: 16, timeoutMs: childPromptTimeoutMs });
    }
    const records = await Promise.all(
      (await readdir(join(children, "lifecycle")))
        .filter((name) => name.endsWith(".json") && !name.startsWith("current-"))
        .map(async (name) => JSON.parse(await readFile(join(children, "lifecycle", name), "utf8"))),
    );
    assert.equal(records.length, 3, "exhausted group refused a fourth process");
    assert.equal(new Set(records.map((record) => record.pid)).size, 3);
    for (const record of records) {
      assert.equal(record.phase, "completed");
      assert.equal(record.delivery.ingested, true);
      assert.equal(record.delivery.identity.childProcessId, record.processId);
      assert.equal((await jsonl(record.sessionFile))[0].id, record.sessionId);
      assert.equal(
        JSON.parse(
          await readFile(join(children, "lifecycle", `current-${record.agentId}.json`), "utf8"),
        ).processId,
        record.processId,
      );
      assert.equal(
        await readFile(join(record.cwd, "review.txt"), "utf8"),
        "fixed input for independent review\n",
      );
    }
    const task = records.find(
      (record) =>
        records.filter((child) => child.parentSessionId === record.sessionId).length === 2,
    )!;
    assert.ok(task);
    const taskEntries = await jsonl(task.sessionFile);
    const taskTurnEnded = JSON.parse(await readFile(join(root, "task-turn-ended.json"), "utf8"));
    assert.equal(taskTurnEnded.pid, task.pid);
    assert.equal(taskTurnEnded.sessionId, task.sessionId);
    const results = taskEntries.filter((entry) => entry.customType === "pasa:result");
    assert.equal(results.length, 2);
    const tool = (name: string) => taskEntries.filter((entry) => entry.message?.toolName === name);
    const group = JSON.parse(tool("list_agent_group")[0].message.content[0].text);
    assert.equal(
      group.members.filter((member: any) => member.parentId !== null && member.active).length,
      3,
    );
    assert.equal(group.help.length, 0, "the exact help was answered before the budget attempt");
    const beforeReply = JSON.parse(await readFile(join(root, "group-before-reply.json"), "utf8"));
    assert.equal(
      beforeReply.members.filter((member: any) => member.parentId !== null && member.active).length,
      3,
    );
    assert.equal(beforeReply.help.length, 1);
    assert.equal(beforeReply.requestId, beforeReply.help[0].id);
    assert.equal(beforeReply.self, task.agentId);
    const refusedTaskId = tool("Agent").at(-1).message.details.agentId;
    assert.ok(
      taskEntries.some(
        (entry) =>
          entry.message?.role === "user" &&
          JSON.stringify(entry).includes(`<task-id>${refusedTaskId}</task-id>`) &&
          JSON.stringify(entry).includes("Error: CONCURRENCY_LIMIT"),
      ),
      "refused launch has a persisted failure notification",
    );
    assert.equal(tool("reply_agent_message").length, 1);
    assert.match(JSON.stringify(tool("reply_agent_message")), /Correlated reply received/);
    const notifications = taskEntries.filter(
      (entry) =>
        entry.message?.role === "user" && JSON.stringify(entry).includes("<task-notification>"),
    );
    assert.ok(notifications.length >= 1, `${mode} wakes the existing task after its model turn`);
    const collectedEntries = tool("get_subagent_result");
    assert.equal(
      collectedEntries.length,
      2,
      "one collection per delivered notification, no polling",
    );
    for (const entry of collectedEntries) {
      assert.match(JSON.stringify(entry), /Status: completed/);
      assert.ok(JSON.stringify(entry).includes('\\"ingested\\":true'));
    }
    assert.equal(await readFile(join(task.cwd, "work.txt"), "utf8"), "task work before review\n");
    assert.equal(
      await readFile(join(task.cwd, "corrected.txt"), "utf8"),
      "correction after both persisted findings\n",
    );
    const correctionIndex = taskEntries.findIndex(
      (entry) =>
        entry.message?.role === "assistant" &&
        entry.message.content.some(
          (part: any) =>
            part.type === "toolCall" &&
            part.name === "write" &&
            part.arguments.path === "corrected.txt",
        ),
    );
    assert.ok(correctionIndex >= 0);
    for (const result of results) {
      assert.equal(result.data.parentSessionId, task.sessionId);
      assert.ok(taskEntries.indexOf(result) < correctionIndex);
      const child = records.find((record) => record.processId === result.data.childProcessId)!;
      assert.equal(child.sessionId, result.data.childSessionId);
      assert.equal(child.agentId, result.data.childAgentId);
      const entries = await jsonl(child.sessionFile);
      if (JSON.stringify(entries).includes("QUALIFY_REVIEWER")) {
        assert.match(result.data.findings, /QUALIFICATION_REVIEW_FINDING/);
        assert.equal(
          entries.find((entry) => entry.message?.toolName === "write").message.isError,
          true,
        );
        await assert.rejects(readFile(join(child.cwd, "forbidden.txt")), { code: "ENOENT" });
      } else {
        assert.match(JSON.stringify(entries), /Parent responded: qualification-direct-answer/);
      }
    }
    const trace = await jsonl(join(root, "trace.jsonl"));
    const taskCalls = trace.filter(
      (entry) => entry.kind === "invocation" && entry.pid === task.pid,
    );
    const helpIndex = taskCalls.findIndex((entry) => entry.prompt.startsWith("Agent message: "));
    assert.ok(helpIndex > 0);
    assert.equal(
      taskCalls[helpIndex - 1].calls.length,
      0,
      "task model turn ended before help-driven continuation",
    );
    assert.ok(!trace.some((entry) => entry.prompt === "Task:\nMUST_NOT_RUN"));
    const parent = JSON.parse(
      await readFile(
        join(root, `${interactive ? trace[0].pid : client!.pid}-session.json`),
        "utf8",
      ),
    );
    const parentEntries = await jsonl(parent.sessionFile);
    const rootResult = parentEntries.filter((entry) => entry.customType === "pasa:result");
    assert.equal(rootResult.length, 1);
    assert.equal(rootResult[0].data.childProcessId, task.processId);
    assert.equal(rootResult[0].data.parentSessionId, parent.sessionId);
    assert.equal(rootResult[0].data.childSessionId, task.sessionId);
    if (protectedHost) assert.ok((await inspectionJournal(join(root, "stderr.log"))).length > 0);
    await writeFile(
      join(root, "qualification-proof.json"),
      JSON.stringify(
        {
          mode,
          interactive,
          protectedHost,
          parent,
          records,
          resultIds: results.map((entry) => entry.data.resultId),
          rootResult: rootResult[0].data,
          findingsCollectedBeforeCorrection: true,
          modelPolling: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(await readFile(join(root, "stderr.log"), "utf8").catch(() => ""));
    throw error;
  } finally {
    await client?.close();
    await terminal?.close();
    console.log(`Qualification fixture retained at ${root}`);
  }
}
