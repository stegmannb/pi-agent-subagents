import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessRpc } from "../../src/process-rpc.ts";
import { verifyProtectionSources } from "./protection-sources.ts";
import {
  startProtectionParent,
  childStartupPolicy,
  childRunTimeoutSeconds,
  childPromptTimeoutMs,
  protectionVM,
} from "./parent-startup.ts";
import { inspectionJournal } from "./inspection-journal.ts";

/** Same real SDK/tool scenario is used for ordinary tests and the genuine protection VM. */
export async function nestedScenario(
  protectedHost: boolean,
  joinMode?: "async" | "group" | "smart",
  scenario?:
    | "help"
    | "help-background"
    | "pending-save"
    | "siblings"
    | "role-startup"
    | "role-continuation",
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-nested-")));
  const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent"),
    trace = join(root, "trace.jsonl");
  await mkdir(cwd);
  await mkdir(agentDir);
  if (scenario === "siblings") {
    execFileSync("mkfifo", [join(root, "sibling-ready"), join(root, "sibling-release")]);
  }
  if (joinMode)
    await writeFile(
      join(agentDir, "subagents.json"),
      JSON.stringify({ defaultJoinMode: joinMode }),
    );
  await writeFile(join(cwd, "review.txt"), "review this fixed input\n");
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
  const provider = fileURLToPath(new URL("./fixtures/role-provider.ts", import.meta.url));
  const extensions: Array<{ path: string; protectionId: string | null }> = [
    { path: provider, protectionId: null },
  ];
  if (scenario?.startsWith("role-"))
    extensions.push({
      path: fileURLToPath(new URL("./fixtures/role-drift.ts", import.meta.url)),
      protectionId: null,
    });
  if (scenario === "pending-save")
    extensions.push({
      path: fileURLToPath(new URL("./fixtures/result-write-failure.ts", import.meta.url)),
      protectionId: null,
    });
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
      model: { provider: "role-test", id: "role-test" },
      policy: {
        ...childStartupPolicy,
        sessionDirectory: join(root, "children"),
        extensions,
        nodeImports: imports,
        environmentAllowlist: [
          "HOME",
          "PATH",
          "PASA_ROLE_TRACE",
          "PASA_ROLE_DRIFT_MARKER",
          "PASA_ROLE_DRIFT_PHASE",
          "PASA_SIBLING_RELEASE",
          "PASA_RESULT_WRITE_FAILURE",
        ],
        credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
        limits: {
          maxConcurrent: 4,
          maxDepth: 2,
          maxTurns: 8,
          timeoutSeconds: childRunTimeoutSeconds(30),
        },
      },
    }),
  );
  const outcomes: any[] = [];
  const toolResults: any[] = [];
  let succeeded = false;
  let client: ProcessRpc | undefined;
  const replies: Promise<void>[] = [];
  const messages = async (path: string) =>
    (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  try {
    const options = {
      executable: "/bin/sh",
      args: [
        "-c",
        'exec "$@" 2>"$PASA_TEST_STDERR"',
        "pasa-nested",
        process.execPath,
        ...imports.flatMap((path) => ["--import", path]),
        fileURLToPath(new URL("../../src/process-host.ts", import.meta.url)),
        config,
        "rpc",
      ],
      cwd,
      environment: {
        HOME: root,
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: agentDir,
        PASA_ROLE_TRACE: trace,
        ...(scenario === "pending-save"
          ? { PASA_RESULT_WRITE_FAILURE: join(root, "failed-result.json") }
          : {}),
        ...(scenario === "siblings" ? { PASA_SIBLING_RELEASE: join(root, "sibling-release") } : {}),
        ...(scenario?.startsWith("role-")
          ? {
              PASA_ROLE_DRIFT_MARKER: join(root, "role-drift.json"),
              PASA_ROLE_DRIFT_PHASE: scenario.slice(5),
            }
          : {}),
        PASA_TEST_STDERR: join(root, "stderr.log"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      verifyReady: async (state: any) => {
        assert.equal(state.model.provider, "role-test");
      },
      onEvent: (event: any) => {
        if (event.type === "tool_execution_end") toolResults.push(event);
        if (event.type === "tool_execution_end" && event.toolName === "Agent")
          outcomes.push(event.result);
        if (
          scenario === "help" &&
          event.type === "extension_ui_request" &&
          event.method === "notify"
        ) {
          const match = String(event.message).match(/\/agent-reply ([a-zA-Z0-9_-]+) MESSAGE/);
          if (match)
            replies.push(client!.replyHelp(match[1], "direct answer while foreground Agent waits"));
        }
      },
    };
    client =
      protectedHost || protectionVM
        ? await startProtectionParent(options)
        : await ProcessRpc.start(options);
    const invoke = async (args: Record<string, unknown>, expectedStatus = "completed") => {
      const before = outcomes.length;
      await client!.prompt(
        `HOST:${JSON.stringify([{ name: "Agent", arguments: { description: "Task with independent reviewer", subagent_type: "general-purpose", runner: "rpc", ...args } }])}`,
        { maxTurns: 8, timeoutMs: childPromptTimeoutMs },
      );
      assert.equal(outcomes.length, before + 1);
      const result = outcomes.at(-1);
      assert.equal(result.details?.status, expectedStatus, JSON.stringify(result));
      if (expectedStatus === "completed")
        assert.equal(result.details.resultDelivery?.ingested, true, JSON.stringify(result));
      if (expectedStatus === "completed")
        for (const field of ["goal", "basis", "findings", "evidence", "blockers"])
          assert.ok(
            JSON.stringify(result.content).includes(`\\"${field}\\"`),
            `model-visible result contains ${field}`,
          );
      return result.details;
    };
    if (scenario === "pending-save") {
      let watcher: ReturnType<typeof watch> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const failedWrite = new Promise<void>((resolve, reject) => {
        watcher = watch(root, (_event, name) => {
          if (name === "failed-result.json") resolve();
        });
        timer = setTimeout(
          () => reject(new Error("actual parent write failure not observed")),
          childPromptTimeoutMs,
        );
      });
      try {
        await client.prompt(
          `HOST:${JSON.stringify([{ name: "Agent", arguments: { description: "result with failing parent write", subagent_type: "general-purpose", runner: "rpc", run_in_background: joinMode !== undefined, prompt: "Finish the assigned task" } }])}`,
          { maxTurns: 8, timeoutMs: childPromptTimeoutMs },
        );
        const id = outcomes[0].details.agentId;
        if (!joinMode) {
          assert.equal(outcomes[0].details.status, "waiting");
          assert.match(outcomes[0].content[0].text, /Result delivery pending/);
          assert.doesNotMatch(outcomes[0].content[0].text, /Agent completed/);
        }
        await failedWrite;
        const fault = JSON.parse(await readFile(join(root, "failed-result.json"), "utf8"));
        assert.equal(fault.entries.length, 1, "actual SDK entry remains in memory after EACCES");
        await client.prompt(
          `HOST:${JSON.stringify([{ name: "get_subagent_result", arguments: { agent_id: id, wait: true } }])}`,
          { maxTurns: 8, timeoutMs: childPromptTimeoutMs },
        );
        const result = toolResults.findLast((e) => e.toolName === "get_subagent_result");
        const text = result.result.content[0].text;
        assert.match(text, /Result delivery pending/);
        assert.match(text, /PARENT_SESSION_WRITE_FAILED/);
        assert.doesNotMatch(text, /Agent completed/);
        const disk = await messages(fault.sessionFile);
        assert.equal(
          disk.filter((e) => e.type === "custom" && e.customType === "pasa:result").length,
          0,
        );
        assert.equal(
          (await client.getState()).sessionId,
          fault.sessionId,
          "same owning host and session remain available",
        );
        assert.equal(fault.data.parentSessionId, fault.sessionId);
        assert.equal((await messages(fault.data.evidence[0]))[0].id, fault.data.childSessionId);
        succeeded = true;
        return;
      } finally {
        watcher?.close();
        clearTimeout(timer);
      }
    }
    if (scenario?.startsWith("role-")) {
      const failed = await invoke(
        {
          prompt: `CHILD:${JSON.stringify([{ name: "read", arguments: { path: "review.txt" } }])}`,
        },
        "error",
      );
      assert.match(failed.error, /RESOURCE|READINESS|CHILD/);
      const changed = JSON.parse(await readFile(join(root, "role-drift.json"), "utf8"));
      const before = (await messages(trace)).filter(
        (e) => e.kind === "invocation" && e.pid === changed.pid,
      );
      assert.equal(
        before.length,
        scenario === "role-startup" ? 0 : 1,
        "no provider call may follow the actual role file mutation",
      );
      await client.prompt(`HOST:${JSON.stringify([{ name: "list_agent_group", arguments: {} }])}`, {
        maxTurns: 8,
        timeoutMs: childPromptTimeoutMs,
      });
      const discovery = toolResults.findLast((e) => e.toolName === "list_agent_group");
      const group = JSON.parse(discovery.result.content[0].text);
      assert.equal(
        group.members.filter((m: any) => m.parentId !== null && m.active).length,
        0,
        "failed process released its root-broker reservation",
      );
      const next = await invoke({
        prompt: `CHILD:${JSON.stringify([{ name: "read", arguments: { path: "review.txt" } }])}`,
      });
      assert.notEqual(next.process.pid, changed.pid);
      succeeded = true;
      return;
    }
    if (scenario === "help-background") {
      const first = await invoke({
        prompt: `CHILD:${JSON.stringify([{ name: "Agent", arguments: { description: "background needing help", subagent_type: "general-purpose", run_in_background: true, prompt: `CHILD:${JSON.stringify([{ name: "request_help", arguments: { message: "nested-background-help" } }])}` } }])}`,
      });
      const entries = await messages(first.process.sessionFile);
      const results = entries.filter((e) => e.type === "custom" && e.customType === "pasa:result");
      assert.equal(results.length, 1);
      assert.ok(
        entries.some(
          (e) =>
            e.message?.toolName === "reply_agent_message" &&
            JSON.stringify(e).includes("Correlated reply received"),
        ),
      );
      const child = await messages(results[0].data.evidence[0]);
      assert.ok(
        child.some(
          (e) =>
            e.message?.toolName === "request_help" &&
            JSON.stringify(e).includes("Parent responded: model direct answer"),
        ),
      );
      succeeded = true;
      return;
    }
    if (scenario === "help") {
      const first = await invoke({
        prompt: `CHILD:${JSON.stringify([{ name: "request_help", arguments: { message: "Need an answer during foreground work" } }])}`,
      });
      await Promise.all(replies);
      assert.equal(replies.length, 1);
      const entries = await messages(first.process.sessionFile);
      const response = entries.find((e) => e.message?.toolName === "request_help");
      assert.match(
        JSON.stringify(response),
        /Parent responded: direct answer while foreground Agent waits/,
      );
      const rootSession = (await client.getState()).sessionFile!;
      const results = (await messages(rootSession)).filter(
        (e) => e.type === "custom" && e.customType === "pasa:result",
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].data.childProcessId, first.process.processId);
      succeeded = true;
      return;
    }
    if (scenario === "siblings") {
      const first = await invoke({
        isolation: "worktree",
        prompt: `CHILD:${JSON.stringify([
          {
            name: "Agent",
            arguments: {
              description: "receiver",
              subagent_type: "general-purpose",
              isolation: "worktree",
              run_in_background: true,
              prompt: `CHILD:${JSON.stringify([{ name: "bash", arguments: { command: `printf 'ready\\n' > ${shellQuote(join(root, "sibling-ready"))}; read -r release < ${shellQuote(join(root, "sibling-release"))}` } }])}`,
            },
          },
          {
            name: "Agent",
            arguments: {
              description: "sender",
              subagent_type: "general-purpose",
              isolation: "worktree",
              run_in_background: true,
              prompt: `CHILD:${JSON.stringify([
                {
                  name: "bash",
                  arguments: {
                    command: `read -r ready < ${shellQuote(join(root, "sibling-ready"))}`,
                  },
                },
                { name: "list_agent_group", arguments: {} },
              ])}`,
            },
          },
        ])}`,
      });
      const entries = await messages(first.process.sessionFile);
      const results = entries.filter((e) => e.type === "custom" && e.customType === "pasa:result");
      assert.equal(results.length, 2);
      const sessions = await Promise.all(results.map((e) => messages(e.data.evidence[0])));
      const recipient = sessions.findIndex((es) => es.some((e) => e.message?.toolName === "write"));
      assert.notEqual(
        recipient,
        -1,
        "addressed sibling message triggered the receiver model after its running tool",
      );
      const receiver = results[recipient].data,
        sender = results[1 - recipient].data;
      assert.match(JSON.stringify(sessions[recipient]), new RegExp(sender.childAgentId));
      assert.equal(
        await readFile(join(JSON.parse(receiver.basis).cwd, "steering.txt"), "utf8"),
        "sibling steering at safe model transition",
      );
      assert.ok(
        sessions[1 - recipient].some(
          (e) =>
            e.message?.toolName === "send_agent_message" &&
            JSON.stringify(e).includes("Transport received"),
        ),
      );
      succeeded = true;
      return;
    }
    const reviewerCalls = [
      { name: "read", arguments: { path: "review.txt" } },
      { name: "write", arguments: { path: "forbidden.txt", content: "must not write" } },
      {
        name: "Agent",
        arguments: {
          description: "escape",
          subagent_type: "general-purpose",
          runner: "rpc",
          prompt: "escape",
        },
      },
      { name: "integrate_subagent_worktree", arguments: { agent_id: "escape" } },
    ];
    const first = await invoke({
      isolation: "worktree",
      prompt: `CHILD:${JSON.stringify(
        Array.from({ length: joinMode ? 2 : 1 }, () => ({
          name: "Agent",
          arguments: {
            description: "Independent reviewer",
            subagent_type: "code-review",
            isolation: "worktree",
            ...(joinMode ? { run_in_background: true } : {}),
            prompt: `CHILD:${JSON.stringify(reviewerCalls)}`,
          },
        })),
      )}`,
    });
    const taskEntries = await messages(first.process.sessionFile);
    if (joinMode) {
      const results = taskEntries.filter(
        (e) => e.type === "custom" && e.customType === "pasa:result",
      );
      assert.equal(
        results.length,
        2,
        `${joinMode}: both results must be on the actual task disk before parent delivery`,
      );
      assert.equal(new Set(results.map((e) => e.data.childProcessId)).size, 2);
      assert.equal(new Set(results.map((e) => e.data.childSessionId)).size, 2);
      for (const entry of results) {
        assert.equal(entry.data.parentSessionId, first.process.sessionId);
        const childEntries = await messages(entry.data.evidence[0]);
        assert.equal(childEntries[0].id, entry.data.childSessionId);
        assert.ok(
          childEntries.some(
            (e) =>
              e.message?.toolName === "read" &&
              JSON.stringify(e).includes("review this fixed input"),
          ),
        );
      }
      const notifications = taskEntries.filter(
        (e) => e.message?.role === "user" && JSON.stringify(e).includes("<task-notification>"),
      );
      assert.ok(notifications.length >= 1, `${joinMode}: automatic wake after task turn ends`);
      assert.ok(
        taskEntries.some((e) => e.message?.toolName === "get_subagent_result"),
        `${joinMode}: resumed model ingests full results`,
      );
      const modelCalls = (await messages(trace)).filter(
        (e) => e.kind === "invocation" && e.pid === first.process.pid,
      );
      assert.ok(
        modelCalls.length >= 4,
        `${joinMode}: initial delegation plus automatic continuation`,
      );
      const rootSession = (await client.getState()).sessionFile!;
      const rootResults = (await messages(rootSession)).filter(
        (e) => e.type === "custom" && e.customType === "pasa:result",
      );
      assert.equal(rootResults.length, 1);
      assert.equal(rootResults[0].data.childSessionId, first.process.sessionId);
      assert.equal(rootResults[0].data.childProcessId, first.process.processId);
      succeeded = true;
      return;
    }
    const reviewerResult = taskEntries.find(
      (e) =>
        e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "Agent",
    ).message;
    assert.equal(reviewerResult.details.status, "completed", JSON.stringify(reviewerResult));
    assert.equal(reviewerResult.details.resultDelivery.ingested, true);
    const reviewer = reviewerResult.details.process;
    assert.notEqual(reviewer.pid, first.process.pid);
    assert.notEqual(reviewer.pid, client.pid);
    assert.notEqual(reviewer.sessionId, first.process.sessionId);
    assert.notEqual(reviewer.cwd, first.process.cwd);
    const reviewerEntries = await messages(reviewer.sessionFile);
    for (const name of ["write", "Agent", "integrate_subagent_worktree"])
      assert.equal(
        reviewerEntries.find((e) => e.message?.role === "toolResult" && e.message.toolName === name)
          ?.message.isError,
        true,
        name,
      );
    await assert.rejects(readFile(join(reviewer.cwd, "forbidden.txt")), { code: "ENOENT" });
    const read = reviewerEntries.find(
      (e) => e.message?.role === "toolResult" && e.message.toolName === "read",
    ).message;
    assert.notEqual(read.isError, true);
    assert.match(JSON.stringify(read), /review this fixed input/);
    const saved = taskEntries.filter((e) => e.type === "custom" && e.customType === "pasa:result");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data.childSessionId, reviewer.sessionId);
    assert.equal(saved[0].data.parentSessionId, first.process.sessionId);
    assert.equal(saved[0].data.childProcessId, reviewer.processId);
    const second = await invoke({
      resume: first.agentId,
      prompt: `CHILD:${JSON.stringify([{ name: "write", arguments: { path: "corrected.txt", content: "correction after reviewer findings\n" } }])}`,
    });
    assert.equal(second.process.sessionId, first.process.sessionId);
    assert.equal(second.process.cwd, first.process.cwd);
    assert.notEqual(second.process.pid, first.process.pid);
    assert.equal(
      await readFile(join(first.process.cwd, "corrected.txt"), "utf8"),
      "correction after reviewer findings\n",
    );
    const rootSession = (await client.getState()).sessionFile!;
    const rootResults = (await messages(rootSession)).filter(
      (e) => e.type === "custom" && e.customType === "pasa:result",
    );
    assert.equal(rootResults.length, 2);
    assert.notEqual(rootResults[0].data.resultId, rootResults[1].data.resultId);
    const invocations = (await messages(trace)).filter((e) => e.kind === "invocation");
    const firstReviewer = invocations.find((e) => e.pid === reviewer.pid);
    // Root's default built-ins offer read, bash, edit, write; descendants cannot add tools.
    assert.deepEqual([...firstReviewer.tools].sort(), ["read"]);
    assert.ok(invocations.some((e) => e.pid === first.process.pid && e.tools.includes("Agent")));
    succeeded = true;
  } catch (error) {
    console.error(await readFile(join(root, "stderr.log"), "utf8").catch(() => ""));
    console.error(`Nested fixture preserved at ${root}`);
    throw error;
  } finally {
    await client?.close();
    if (protectedHost) await inspectionJournal(join(root, "stderr.log"));
    // Preserve failures for diagnosis without changing the scenario or its budgets.
    if (succeeded) await rm(root, { recursive: true, force: true });
  }
}
