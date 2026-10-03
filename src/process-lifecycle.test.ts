import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ProcessRegistry, registrationFile, type ProcessHandle } from "./process-lifecycle.ts";
import { LocalMessageBroker, type ParticipantCredential } from "./messaging-broker.ts";
import { LocalMessageClient } from "./messaging-client.ts";
import type { GroupBinding } from "./delegation-group.ts";

function fixture() {
  const cwd = realpathSync(mkdtempSync("/tmp/pasa-life-"));
  const sessionFile = join(cwd, "session.jsonl");
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: "session", version: 3, id: "session", cwd }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(join(cwd, "work.txt"), "retained work");
  const registry = new ProcessRegistry(join(cwd, "lifecycle"));
  const registered = registry.register({
    taskId: "task",
    agentId: "agent",
    sessionId: "session",
    processId: "first",
    sessionFile,
    cwd,
    parentAgentId: "parent",
    parentSessionId: "parent-session",
  });
  const handle = registry.bindPid(registered, process.pid);
  return { cwd, registry, handle, close: () => rmSync(cwd, { recursive: true }) };
}
test("takeover atomically revokes parent steering and stale help replies at the actual broker", async () => {
  const f = fixture();
  const broker = await LocalMessageBroker.start();
  const clients: LocalMessageClient[] = [];
  try {
    const root = broker.registerRoot(
      "parent-session",
      { name: "root", readOnly: false, allowedTools: ["Agent", "read"] },
      { maxConcurrent: 4, maxDepth: 2 },
      f.registry.directory,
    );
    const parent = await LocalMessageClient.connect(root.credential);
    const grant = await parent.control<{
      binding: GroupBinding;
      credential: ParticipantCredential;
    }>("reserve", {
      taskId: "owned-task",
      role: { name: "task", readOnly: false, allowedTools: ["read"] },
    });
    const child = await LocalMessageClient.connect(grant.credential);
    clients.push(parent, child);
    const sessionFile = join(f.cwd, "owned.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({ type: "session", id: grant.binding.sessionId, cwd: f.cwd }) + "\n",
      { mode: 0o600 },
    );
    const registered = await parent.control<ProcessHandle>("register-process", {
      taskId: "owned-task",
      agentId: grant.binding.agentId,
      sessionId: grant.binding.sessionId,
      processId: grant.binding.processId,
      sessionFile,
      cwd: f.cwd,
      parentAgentId: root.binding.agentId,
      parentSessionId: root.binding.sessionId,
    });
    const handle = await parent.control<ProcessHandle>("bind-process", {
      handle: registered,
      pid: process.pid,
    });
    const help = child.request(root.binding.agentId, { type: "help", message: "Approve?" });
    void help.catch(() => {});
    const request = await parent.nextMessage();
    const transferred = await parent.control<ProcessHandle>("takeover-process", {
      handle,
      ownership: "external",
    });
    assert.equal(transferred.routeParentId, null);
    await assert.rejects(parent.reply(request, { message: "stale approval" }).accepted, {
      code: "FORBIDDEN",
    });
    await assert.rejects(
      parent.event(grant.binding.agentId, {
        type: "steer",
        message: "stale steering",
        processId: handle.processId,
      }).accepted,
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      child.request(root.binding.agentId, { type: "help", message: "old route" }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(parent.control("takeover-process", { handle, ownership: "manual" }), {
      code: "FORBIDDEN",
    });
    assert.equal(f.registry.read(transferred).ownership, "external");
    assert.equal(readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).length, 1);
  } finally {
    for (const client of clients) client.close();
    await broker.close();
    f.close();
  }
});
test("atomic manual/external ownership revokes all displayed managed handles and parent routing", () => {
  for (const ownership of ["manual", "external"] as const) {
    const f = fixture();
    try {
      const stale = structuredClone(f.handle);
      const taken = f.registry.takeover(stale, ownership);
      assert.equal(taken.ownership, ownership);
      assert.equal(taken.routeParentId, null);
      assert.equal(taken.revision, stale.revision + 1);
      assert.throws(() => f.registry.update(stale, { phase: "stopped" }), {
        code: "PROCESS_IDENTITY_UNPROVEN",
      });
      assert.throws(() => f.registry.takeover(stale, "manual"), {
        code: "PROCESS_IDENTITY_UNPROVEN",
      });
      assert.deepEqual(f.registry.read(taken), taken);
      assert.equal(readFileSync(join(f.cwd, "work.txt"), "utf8"), "retained work");
      assert.ok(readFileSync(taken.sessionFile, "utf8").includes('"session"'));
    } finally {
      f.close();
    }
  }
});
test("old cleanup cannot mutate a newer incarnation of the same session, even with reused PID", () => {
  const f = fixture();
  try {
    f.registry.update(f.handle, { phase: "cleanup-error", error: "PROCESS_CLEANUP_FAILED" });
    const newer = f.registry.register({ ...f.handle, processId: "second", pid: undefined });
    const bound = f.registry.bindPid(newer, process.pid);
    assert.throws(() => f.registry.update(f.handle, { phase: "completed" }), {
      code: "PROCESS_IDENTITY_UNPROVEN",
    });
    assert.deepEqual(f.registry.read(bound), bound);
    assert.equal(
      JSON.parse(readFileSync(registrationFile(f.registry.directory, "first"), "utf8")).phase,
      "cleanup-error",
    );
    assert.equal(readFileSync(join(f.cwd, "work.txt"), "utf8"), "retained work");
  } finally {
    f.close();
  }
});
test("missing or contradictory run/session/PID/routing identity refuses mutation and preserves bytes", () => {
  const f = fixture();
  try {
    const file = registrationFile(f.registry.directory, f.handle.processId);
    const original = readFileSync(file, "utf8");
    for (const change of [
      { pid: process.pid + 1 },
      { taskId: "other" },
      { sessionId: "other" },
      { parentSessionId: "other" },
      { cwd: "/tmp" },
      { routeParentId: "other" },
      { paneId: "reused-pane", paneProcessId: process.pid },
      { resultId: "other-run:result" },
      { phase: "invalid" },
    ]) {
      writeFileSync(file, JSON.stringify({ ...f.handle, ...change }));
      const altered = readFileSync(file, "utf8");
      assert.throws(() => f.registry.update(f.handle, { phase: "stopped" }), {
        code: "PROCESS_IDENTITY_UNPROVEN",
      });
      assert.equal(readFileSync(file, "utf8"), altered);
      writeFileSync(file, original);
    }
    const badHandle = { ...f.handle, pid: undefined } as ProcessHandle;
    assert.throws(() => f.registry.takeover(badHandle, "manual"), {
      code: "PROCESS_IDENTITY_UNPROVEN",
    });
    assert.equal(readFileSync(join(f.cwd, "work.txt"), "utf8"), "retained work");
  } finally {
    f.close();
  }
});
