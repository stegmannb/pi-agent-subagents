import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalMessageBroker } from "./messaging-broker.ts";
import { LocalMessageClient } from "./messaging-client.ts";
import type { GroupBinding } from "./delegation-group.ts";
import type { ParticipantCredential } from "./messaging-broker.ts";

test("authenticated root broker shares atomic concurrency and depth across parent and sibling clients", async () => {
  const broker = await LocalMessageBroker.start();
  const clients: LocalMessageClient[] = [];
  try {
    const root = broker.registerRoot(
      "root-session",
      { name: "root", readOnly: false, allowedTools: ["Agent", "read", "write"] },
      { maxConcurrent: 4, maxDepth: 2 },
    );
    const parent = await LocalMessageClient.connect(root.credential);
    clients.push(parent);
    const reserve = (client: LocalMessageClient, readOnly = false) =>
      client.control<{ binding: GroupBinding; credential: ParticipantCredential }>("reserve", {
        taskId: "task",
        role: {
          name: readOnly ? "reviewer" : "task",
          readOnly,
          allowedTools: readOnly ? ["read"] : ["Agent", "read", "write"],
        },
      });
    const task = await reserve(parent),
      sibling = await reserve(parent);
    const taskClient = await LocalMessageClient.connect(task.credential),
      siblingClient = await LocalMessageClient.connect(sibling.credential);
    clients.push(taskClient, siblingClient);
    const raced = await Promise.allSettled([
      reserve(taskClient),
      reserve(siblingClient),
      reserve(parent),
    ]);
    assert.equal(raced.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(
      raced.filter((r) => r.status === "rejected" && r.reason.code === "CONCURRENCY_LIMIT").length,
      1,
    );
    const nestedIndex = raced.slice(0, 2).findIndex((r) => r.status === "fulfilled");
    const owner = nestedIndex === 0 ? taskClient : siblingClient;
    const nested = raced[nestedIndex];
    assert.equal(nested.status, "fulfilled");
    if (nested.status !== "fulfilled") throw new Error();
    assert.equal(nested.value.binding.depth, 2);
    assert.equal(
      nested.value.binding.parentId,
      nestedIndex === 0 ? task.binding.agentId : sibling.binding.agentId,
    );
    const reviewer = await LocalMessageClient.connect(nested.value.credential);
    clients.push(reviewer);
    await assert.rejects(reserve(reviewer), { code: "DEPTH_EXCEEDED" });
    const release = {
      agentId: nested.value.binding.agentId,
      processId: nested.value.binding.processId,
    };
    await assert.rejects(parent.control("release", release), { code: "FORBIDDEN" });
    await owner.control("release", release);
    await owner.control("release", release);
    const readonly = await reserve(parent, true),
      readClient = await LocalMessageClient.connect(readonly.credential);
    clients.push(readClient);
    await assert.rejects(reserve(readClient), { code: "FORBIDDEN" });
    await assert.rejects(readClient.control("resume", { agentId: task.binding.agentId }), {
      code: "FORBIDDEN",
    });
    const members = await readClient.control<GroupBinding[]>("members");
    assert.equal(members.filter((m) => m.parentId !== null && m.active).length, 4);
    assert.equal(new Set(members.map((m) => m.groupId)).size, 1);
  } finally {
    for (const client of clients) client.close();
    await broker.close();
  }
});
test("group configuration refuses invalid finite-positive-integer limits", async () => {
  const broker = await LocalMessageBroker.start();
  try {
    for (const value of [0, -1, NaN, Infinity, 1.5, null, "4", 2_147_483_648]) {
      for (const field of ["maxDepth", "maxConcurrent"])
        assert.throws(
          () =>
            broker.registerRoot(
              "root-session",
              { name: "root", readOnly: false, allowedTools: [] },
              { maxConcurrent: 4, maxDepth: 2, [field]: value } as any,
            ),
          { code: "INVALID_GROUP_LIMIT" },
        );
    }
  } finally {
    await broker.close();
  }
});
test("resume retains task/session ownership but revokes the previous incarnation capability", async () => {
  const broker = await LocalMessageBroker.start();
  const registration = broker.registerRoot(
    "root-session",
    { name: "root", readOnly: false, allowedTools: ["read"] },
    { maxConcurrent: 4, maxDepth: 2 },
  );
  const root = await LocalMessageClient.connect(registration.credential);
  let resumed: LocalMessageClient | undefined;
  try {
    const first = await root.control<{ binding: GroupBinding; credential: ParticipantCredential }>(
      "reserve",
      { taskId: "task", role: { name: "reader", readOnly: true, allowedTools: ["read"] } },
    );
    await root.control("release", {
      agentId: first.binding.agentId,
      processId: first.binding.processId,
    });
    const next = await root.control<typeof first>("resume", { agentId: first.binding.agentId });
    assert.equal(next.binding.sessionId, first.binding.sessionId);
    assert.equal(next.binding.taskId, first.binding.taskId);
    assert.notEqual(next.binding.processId, first.binding.processId);
    assert.notEqual(next.credential.capability, first.credential.capability);
    await assert.rejects(LocalMessageClient.connect(first.credential), { code: "AUTH_FAILED" });
    resumed = await LocalMessageClient.connect(next.credential);
    await assert.rejects(
      root.control("release", {
        agentId: first.binding.agentId,
        processId: first.binding.processId,
      }),
      { code: "FORBIDDEN" },
    );
  } finally {
    resumed?.close();
    root.close();
    await broker.close();
  }
});
