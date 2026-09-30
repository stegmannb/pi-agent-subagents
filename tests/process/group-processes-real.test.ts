import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { LocalMessageBroker } from "../../src/messaging-broker.ts";
import { LocalMessageClient } from "../../src/messaging-client.ts";
import type { GroupBinding } from "../../src/delegation-group.ts";
import type { ParticipantCredential } from "../../src/messaging-broker.ts";
type Grant = { binding: GroupBinding; credential: ParticipantCredential };
test(
  "separate sibling OS processes share the root budget and authenticated addresses",
  { timeout: 20_000 },
  async () => {
    const broker = await LocalMessageBroker.start();
    const registration = broker.registerRoot(
      "root-session",
      { name: "root", readOnly: false, allowedTools: ["Agent", "read"] },
      { maxConcurrent: 4, maxDepth: 2 },
    );
    const root = await LocalMessageClient.connect(registration.credential);
    const children: ChildProcess[] = [];
    const input = {
      taskId: "test-task",
      role: { name: "task", readOnly: false, allowedTools: ["Agent", "read"] },
    };
    const start = async (grant: Grant) => {
      const child = fork(new URL("./fixtures/group-member.ts", import.meta.url), [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      children.push(child);
      let id = 0;
      const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
      child.on("message", (m: any) => {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.error }));
        else p.resolve(m.value);
      });
      child.on("exit", () => {
        for (const p of pending.values()) p.reject(new Error("member exited"));
        pending.clear();
      });
      const call = (operation: string, input?: unknown) =>
        new Promise<any>((resolve, reject) => {
          const requestId = ++id;
          pending.set(requestId, { resolve, reject });
          child.send({ id: requestId, operation, input });
        });
      const ready = await call("connect", grant.credential);
      assert.equal(ready.pid, child.pid);
      assert.notEqual(ready.pid, process.pid);
      return { call, pid: ready.pid, grant };
    };
    try {
      const a = await start(await root.control<Grant>("reserve", input));
      const b = await start(await root.control<Grant>("reserve", input));
      assert.notEqual(a.pid, b.pid);
      const receiving = b.call("receive");
      await a.call("event", {
        to: b.grant.binding.agentId,
        payload: { message: "sibling steering" },
      });
      const message = await receiving;
      assert.equal(message.from, a.grant.binding.agentId);
      assert.equal(message.to, b.grant.binding.agentId);
      assert.equal(message.payload.message, "sibling steering");
      const raced = await Promise.allSettled([
        a.call("reserve", input),
        b.call("reserve", input),
        a.call("reserve", input),
        b.call("reserve", input),
      ]);
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 2);
      assert.equal(
        raced.filter((r) => r.status === "rejected" && r.reason.code === "CONCURRENCY_LIMIT")
          .length,
        2,
      );
      const index = raced.findIndex((r) => r.status === "fulfilled");
      const grant = (raced[index] as PromiseFulfilledResult<Grant>).value;
      const owner = index % 2 === 0 ? a : b;
      const nested = await start(grant);
      await assert.rejects(nested.call("reserve", input), { code: "DEPTH_EXCEEDED" });
      await assert.rejects(
        root.control("release", {
          agentId: grant.binding.agentId,
          processId: grant.binding.processId,
        }),
        { code: "FORBIDDEN" },
      );
      await owner.call("release", {
        agentId: grant.binding.agentId,
        processId: grant.binding.processId,
      });
      await assert.rejects(owner.call("reserve", { ...input, maxConcurrent: 5 }), {
        code: "INVALID_GROUP_LIMIT",
      });
      const replacement: Grant = await owner.call("reserve", {
        ...input,
        role: { name: "reviewer", readOnly: true, allowedTools: ["read"] },
      });
      const readonly = await start(replacement);
      await assert.rejects(readonly.call("reserve", input), { code: "FORBIDDEN" });
      const members = await root.control<GroupBinding[]>("members");
      assert.equal(members.filter((m) => m.active && m.parentId !== null).length, 4);
      assert.equal(new Set(members.map((m) => m.groupId)).size, 1);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null) return;
          const exited = once(child, "exit");
          child.disconnect();
          await exited;
        }),
      );
      root.close();
      await broker.close();
    }
  },
);
