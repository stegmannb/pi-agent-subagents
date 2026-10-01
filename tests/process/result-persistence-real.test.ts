import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { LocalMessageBroker } from "../../src/messaging-broker.ts";
import { LocalMessageClient } from "../../src/messaging-client.ts";
import { ProcessCommunication } from "../../src/process-communication.ts";
import type { AgentResult } from "../../src/process-results.ts";

test("actual Pi session file proves ingestion; delayed persistence and memory-first append failure remain idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pasa-result-disk-"));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(root, root);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    resourceLoader,
    settingsManager,
    sessionManager,
    tools: [],
  });
  const broker = await LocalMessageBroker.start();
  const registration = broker.registerRoot(
    session.sessionId,
    { name: "root", readOnly: false, allowedTools: [] },
    { maxConcurrent: 4, maxDepth: 2 },
  );
  const client = await LocalMessageClient.connect(registration.credential);
  const channel = new ProcessCommunication(client, registration.binding, session, createEventBus());
  const result: AgentResult = {
    resultId: "run:result",
    taskId: "task",
    childAgentId: "child",
    childSessionId: "child-session",
    childProcessId: "run",
    parentSessionId: session.sessionId,
    goal: "review",
    basis: "fixed source",
    findings: "finding",
    evidence: ["test"],
    blockers: [],
  };
  const identity = (value: AgentResult) => {
    const { goal: _g, basis: _b, findings: _f, evidence: _e, blockers: _k, ...binding } = value;
    return binding;
  };
  const disk = () =>
    readFileSync(session.sessionFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const entries = (id: string) =>
    disk().filter(
      (e) => e.type === "custom" && e.customType === "pasa:result" && e.data.resultId === id,
    );
  try {
    channel.results.expect(identity(result));
    const pending = channel.results.receive("child", result);
    assert.equal(pending.ingested, false);
    assert.equal(pending.error, "PARENT_SESSION_WRITE_FAILED");
    assert.equal(sessionManager.getEntries().filter((e) => e.type === "custom").length, 0);
    // Public SDK API: its first assistant entry makes the session file durable.
    sessionManager.appendMessage({
      role: "assistant",
      api: "test",
      provider: "test",
      model: "test",
      content: [{ type: "text", text: "parent turn" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    channel.results.receive("child", result);
    assert.equal(pending.ingested, true);
    const saved = entries(result.resultId);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].data, result);
    assert.equal(disk()[0].id, session.sessionId);
    const entryId = saved[0].id;
    for (let i = 0; i < 3; i++) channel.results.receive("child", result);
    assert.equal(entries(result.resultId).length, 1);
    assert.equal(entries(result.resultId)[0].id, entryId);
    assert.throws(
      () => channel.results.receive("child", { ...result, parentSessionId: "wrong" }),
      /STALE_OR_INVALID_RESULT/,
    );
    assert.throws(
      () => channel.results.receive("child", { ...result, childProcessId: "old" }),
      /STALE_OR_INVALID_RESULT/,
    );
    assert.throws(
      () => channel.results.receive("child", { ...result, findings: "conflicting" }),
      /CONFLICTING_RESULT/,
    );

    const failed = { ...result, resultId: "second:result", childProcessId: "second" };
    channel.results.expect(identity(failed));
    const collecting = channel.waitResult(identity(failed));
    chmodSync(session.sessionFile!, 0o400);
    const failure = channel.results.receive("child", failed);
    channel.results.stage("child", failed.resultId, "accepted");
    channel.results.stage("child", failed.resultId, "received");
    const collected = await collecting;
    assert.deepEqual(
      collected.result,
      failed,
      "collection preserves the complete result and identity",
    );
    assert.equal(collected.delivery, failure);
    assert.equal(collected.delivery.produced, true);
    assert.equal(collected.delivery.accepted, true);
    assert.equal(collected.delivery.received, true);
    assert.equal(collected.delivery.ingested, false);
    assert.equal(collected.delivery.error, "PARENT_SESSION_WRITE_FAILED");
    assert.equal(collected.result.parentSessionId, session.sessionId);
    assert.equal(disk()[0].id, session.sessionId, "the original parent session remains on disk");
    assert.equal(failure.received, true);
    assert.equal(failure.ingested, false);
    const memory = () =>
      sessionManager
        .getEntries()
        .filter(
          (e) =>
            e.type === "custom" &&
            e.customType === "pasa:result" &&
            (e.data as AgentResult).resultId === failed.resultId,
        );
    assert.equal(
      memory().length,
      1,
      "actual SDK mutated its memory before the failing disk append",
    );
    assert.equal(entries(failed.resultId).length, 0);
    chmodSync(session.sessionFile!, 0o600);
    for (let i = 0; i < 3; i++) channel.results.receive("child", failed);
    const collectedAgain = await channel.waitResult(identity(failed));
    assert.deepEqual(
      collectedAgain,
      collected,
      "a later collector receives the same pending result",
    );
    const retained = memory()[0];
    assert.ok(retained.type === "custom");
    assert.deepEqual(retained.data, failed, "the one retained memory entry keeps the result");
    assert.equal(memory().length, 1, "redelivery must never append another SDK entry");
    assert.equal(entries(failed.resultId).length, 0);
    assert.equal(
      failure.ingested,
      false,
      "no invented persistence acknowledgement after memory-only append",
    );
    assert.equal(failure.error, "PARENT_SESSION_WRITE_FAILED");
  } finally {
    channel.close();
    client.close();
    await broker.close();
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "failure evidence is published whole and retains the first real failed append",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pasa-failure-publication-"));
    const marker = join(root, "failed-result.json");
    const release = new Int32Array(new SharedArrayBuffer(4));
    const observed = Promise.withResolvers<void>();
    const partial = Promise.withResolvers<void>();
    const published = Promise.withResolvers<string>();
    const done = Promise.withResolvers<{ first: unknown; sessionFile: string }>();
    let finalEvents = 0;
    // Capture parse/read failures without an unhandled rejection before the gate opens.
    void published.promise.catch(() => {});
    const watcher = watch(root, (_event, name) => {
      if (name === "failed-result.json" || name === "failed-result.json.tmp") observed.resolve();
      if (name !== "failed-result.json") return;
      finalEvents++;
      try {
        const text = readFileSync(marker, "utf8");
        JSON.parse(text);
        published.resolve(text);
      } catch (error) {
        published.reject(error);
      }
    });
    const worker = new Worker(
      new URL("./fixtures/result-write-failure-probe.mjs", import.meta.url),
      {
        workerData: { root, marker, release: release.buffer },
      },
    );
    worker.on("message", (message) => {
      if (message.type === "partial") partial.resolve();
      if (message.type === "done") done.resolve(message);
    });
    const exited = once(worker, "exit").then(([code]) => {
      assert.equal(code, 0);
    });
    void exited.catch(() => {});
    try {
      await Promise.race([
        Promise.all([partial.promise, observed.promise]),
        exited.then(() => {
          throw new Error("writer exited before the partial-write barrier");
        }),
      ]);
      assert.equal(finalEvents, 0, "the real watcher has no final signal during a partial write");
      assert.equal(existsSync(marker), false);
      assert.throws(() => JSON.parse(readFileSync(`${marker}.tmp`, "utf8")), SyntaxError);
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      const [text, result] = await Promise.all([published.promise, done.promise, exited]);
      const evidence = JSON.parse(text);
      assert.equal(evidence.sessionFile, result.sessionFile);
      assert.deepEqual(evidence.data, result.first);
      assert.equal(evidence.entries.length, 1);
      assert.deepEqual(evidence.entries[0].data, result.first);
      assert.equal(existsSync(`${marker}.tmp`), false);
      assert.equal(
        readFileSync(marker, "utf8"),
        text,
        "a later append preserves the first evidence",
      );
    } finally {
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await worker.terminate();
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
