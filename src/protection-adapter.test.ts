import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@mariozechner/pi-coding-agent";
import {
  PROTECTION_SNAPSHOT_EVENT,
  requestProtectionSnapshot,
  verifyChildProtection,
  type ProtectionSnapshotRequest,
  type ReadyProtectionSnapshot,
} from "./protection-adapter.ts";

const input = {
  protectionId: "pi-agent-guard" as const,
  expectedSessionId: "parent",
  targetCwd: "/child",
};
function response(request: ProtectionSnapshotRequest): ReadyProtectionSnapshot {
  return {
    version: 1,
    requestId: request.requestId,
    protectionId: request.protectionId,
    status: "ready",
    binding: { cwd: "/parent", sessionId: request.expectedSessionId, generation: 0 },
    enabled: true,
    initialized: true,
    stateDigest: "a".repeat(64),
    codeFiles: [{ path: "/extension.ts", sha256: "b".repeat(64) }],
    configurationFiles: [],
    environment: [],
    replay: { kind: "file-backed", verifiedCwd: request.targetCwd, stateDigest: "a".repeat(64) },
  };
}
test("missing protection adapter times out instead of attesting an empty inventory", async () => {
  await assert.rejects(requestProtectionSnapshot(createEventBus(), input, 10), {
    code: "PROTECTION_RESPONSE_TIMEOUT",
  });
});
test("a synchronous producer cannot return ready after the snapshot deadline", async () => {
  const bus = createEventBus();
  bus.on(PROTECTION_SNAPSHOT_EVENT, (data) => {
    const request = data as ProtectionSnapshotRequest;
    const end = performance.now() + 15;
    while (performance.now() < end) {
      /* simulate synchronous producer file hashing */
    }
    request.respond(response(request));
  });
  await assert.rejects(requestProtectionSnapshot(bus, input, 5), {
    code: "PROTECTION_RESPONSE_TIMEOUT",
  });
});
test("protection responses bind request, session and exact target cwd", async () => {
  for (const mutate of [
    (r: ReadyProtectionSnapshot) => {
      r.requestId = "wrong";
    },
    (r: ReadyProtectionSnapshot) => {
      r.binding.sessionId = "wrong";
    },
    (r: ReadyProtectionSnapshot) => {
      r.replay.verifiedCwd = "/different";
    },
  ]) {
    const bus = createEventBus();
    bus.on(PROTECTION_SNAPSHOT_EVENT, (data) => {
      const request = data as ProtectionSnapshotRequest;
      const r = response(request);
      mutate(r);
      request.respond(r);
    });
    await assert.rejects(requestProtectionSnapshot(bus, input));
  }
});
test("unsupported runtime mutation is a refusal", async () => {
  const bus = createEventBus();
  bus.on(PROTECTION_SNAPSHOT_EVENT, (data) => {
    const request = data as ProtectionSnapshotRequest;
    request.respond({
      version: 1,
      requestId: request.requestId,
      protectionId: request.protectionId,
      status: "unsupported",
      reason: "RUNTIME_MUTATION",
    });
  });
  await assert.rejects(requestProtectionSnapshot(bus, input), {
    code: "NON_REPRODUCIBLE_PROTECTION",
  });
});
test("duplicate producer responses revoke the captured snapshot", async () => {
  const bus = createEventBus();
  let request!: ProtectionSnapshotRequest;
  bus.on(PROTECTION_SNAPSHOT_EVENT, (data) => {
    request = data as ProtectionSnapshotRequest;
    request.respond(response(request));
  });
  const lease = await requestProtectionSnapshot(bus, input);
  request.respond(response(request));
  assert.throws(() => lease.read(), { code: "PROTECTION_RESPONSE_INVALIDATED" });
});
test("child must independently match effective protection and loaded source", async () => {
  const bus = createEventBus();
  bus.on(PROTECTION_SNAPSHOT_EVENT, (data) => {
    const request = data as ProtectionSnapshotRequest;
    request.respond(response(request));
  });
  const parent = (await requestProtectionSnapshot(bus, input)).read();
  const child = structuredClone(parent);
  child.binding = { cwd: "/child", sessionId: "child", generation: 1 };
  verifyChildProtection(parent, child, { cwd: "/child", sessionId: "child" });
  child.stateDigest = "c".repeat(64);
  assert.throws(() => verifyChildProtection(parent, child, { cwd: "/child", sessionId: "child" }), {
    code: "CHILD_PROTECTION_MISMATCH",
  });
});

test("verified target cwd maps only project config paths, never loaded code", async () => {
  const bus = createEventBus();
  bus.on(PROTECTION_SNAPSHOT_EVENT, (data) => {
    const request = data as ProtectionSnapshotRequest;
    const result = response(request);
    result.configurationFiles = [{ path: "/parent/.pi/settings.json", sha256: "d".repeat(64) }];
    request.respond(result);
  });
  const parent = (await requestProtectionSnapshot(bus, input)).read();
  const child = structuredClone(parent);
  child.binding = { cwd: "/child", sessionId: "child", generation: 1 };
  child.configurationFiles[0].path = "/child/.pi/settings.json";
  verifyChildProtection(parent, child, { cwd: "/child", sessionId: "child" });
  child.codeFiles[0].path = "/child/extension.ts";
  assert.throws(() => verifyChildProtection(parent, child, { cwd: "/child", sessionId: "child" }), {
    code: "CHILD_PROTECTION_MISMATCH",
  });
});

for (const [protectionId, projectFile, otherProjectFile] of [
  ["pi-agent-guard", "settings.json", "sandbox.json"],
  ["pi-agent-sandbox", "sandbox.json", "settings.json"],
] as const) {
  test(`${protectionId} remaps only its exact project file, keeping shared config inside parent cwd`, async () => {
    const bus = createEventBus();
    bus.on(PROTECTION_SNAPSHOT_EVENT, (data) => {
      const request = data as ProtectionSnapshotRequest;
      const result = response(request);
      result.configurationFiles = [
        { path: `/parent/.pi/${projectFile}`, sha256: "d".repeat(64) },
        { path: `/parent/shared-agent/${projectFile}`, sha256: "e".repeat(64) },
        { path: "/parent/policy.json", sha256: "f".repeat(64) },
        { path: `/parent/.pi/${otherProjectFile}`, sha256: "1".repeat(64) },
      ];
      request.respond(result);
    });
    const parent = (await requestProtectionSnapshot(bus, { ...input, protectionId })).read();
    const child = structuredClone(parent);
    child.binding = { cwd: "/child", sessionId: "child", generation: 1 };
    child.configurationFiles[0].path = `/child/.pi/${projectFile}`;
    verifyChildProtection(parent, child, { cwd: "/child", sessionId: "child" });
    for (let i = 1; i < child.configurationFiles.length; i++) {
      const changed = structuredClone(child);
      changed.configurationFiles[i].path = changed.configurationFiles[i].path.replace(
        "/parent/",
        "/child/",
      );
      assert.throws(
        () => verifyChildProtection(parent, changed, { cwd: "/child", sessionId: "child" }),
        {
          code: "CHILD_PROTECTION_MISMATCH",
        },
      );
    }
  });
}
