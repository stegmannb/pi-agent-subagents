import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@mariozechner/pi-coding-agent";
import { validateQualificationPreset, qualificationTiming } from "./process-qualification.ts";
import { attachProcessRunner } from "./process-runner.ts";
import type { ProcessHostPolicy } from "./process-contract.ts";
import {
  PROTECTION_SNAPSHOT_EVENT,
  requestProtectionSnapshot,
  requestQualifiedProtectionSnapshot,
  verifyChildProtection,
  type ProtectionSnapshotRequest,
  type ReadyProtectionSnapshot,
} from "./protection-adapter.ts";

const input = {
  protectionId: "pi-agent-guard" as const,
  expectedSessionId: "parent",
  targetCwd: "/child",
};
function proof(request: ProtectionSnapshotRequest): ReadyProtectionSnapshot {
  return {
    version: 1,
    requestId: request.requestId,
    protectionId: "pi-agent-guard",
    status: "ready",
    binding: { cwd: "/parent", sessionId: "parent", generation: 0 },
    enabled: true,
    initialized: true,
    stateDigest: "a".repeat(64),
    codeFiles: [{ path: "/extension.ts", sha256: "b".repeat(64) }],
    configurationFiles: [],
    environment: [],
    replay: { kind: "file-backed", verifiedCwd: "/child", stateDigest: "a".repeat(64) },
  };
}
test("qualification preset is exact, immutable and rejected before Parent capture", async () => {
  assert.equal(validateQualificationPreset(undefined), undefined);
  assert.equal(qualificationTiming(undefined), undefined);
  assert.deepEqual(qualificationTiming("qemu-functional"), {
    snapshotMs: 20000,
    inspectionMs: 40000,
    readinessMs: 80000,
  });
  assert.ok(Object.isFrozen(qualificationTiming("qemu-functional")));
  for (const value of [
    null,
    false,
    true,
    0,
    20000,
    -1,
    1.5,
    NaN,
    Infinity,
    "",
    "qemu",
    [],
    {},
    { snapshotMs: 20000 },
    new String("qemu-functional"),
  ]) {
    assert.throws(() => validateQualificationPreset(value), {
      code: "INVALID_QUALIFICATION_PRESET",
    });
    await assert.rejects(
      attachProcessRunner(
        () => {
          throw new Error("must not capture Parent");
        },
        { qualificationPreset: value } as ProcessHostPolicy,
      ),
      { code: "INVALID_QUALIFICATION_PRESET" },
    );
  }
});
test("generic snapshot callers retain their five-second hard cap", async () => {
  const bus = createEventBus();
  let invoked = false;
  bus.on(PROTECTION_SNAPSHOT_EVENT, () => {
    invoked = true;
  });
  for (const value of [5001, 20000, null, NaN, Infinity, -1, 0, 1.5])
    await assert.rejects(requestProtectionSnapshot(bus, input, value as number), {
      code: "INVALID_PROTECTION_REQUEST",
    });
  assert.equal(invoked, false);
});
test(
  "explicit qualification accepts a complete later response while default refuses it",
  { timeout: 15000 },
  async () => {
    const bus = createEventBus();
    bus.on(PROTECTION_SNAPSHOT_EVENT, (value) => {
      const request = value as ProtectionSnapshotRequest;
      setTimeout(() => request.respond(proof(request)), 6000);
    });
    const defaultRefusal = assert.rejects(
      requestQualifiedProtectionSnapshot(bus, input, undefined),
      { code: "PROTECTION_RESPONSE_TIMEOUT" },
    );
    const accepted = requestQualifiedProtectionSnapshot(bus, input, "qemu-functional");
    await defaultRefusal;
    const parent = (await accepted).read();
    const child = structuredClone(parent);
    child.binding = { cwd: "/child", sessionId: "child", generation: 1 };
    verifyChildProtection(parent, child, { cwd: "/child", sessionId: "child" });
    child.codeFiles[0].sha256 = "c".repeat(64);
    assert.throws(
      () => verifyChildProtection(parent, child, { cwd: "/child", sessionId: "child" }),
      { code: "CHILD_PROTECTION_MISMATCH" },
    );
  },
);
test("qualification still rejects incomplete, unbound and unsupported proof", async () => {
  for (const mutate of [
    (p: any) => {
      p.codeFiles = [];
    },
    (p: any) => {
      p.binding.sessionId = "wrong";
    },
    (p: any) => {
      p.replay.verifiedCwd = "/wrong";
    },
    (p: any) => {
      p.status = "unsupported";
    },
  ]) {
    const bus = createEventBus();
    bus.on(PROTECTION_SNAPSHOT_EVENT, (value) => {
      const request = value as ProtectionSnapshotRequest;
      const p = proof(request);
      mutate(p);
      request.respond(p);
    });
    await assert.rejects(requestQualifiedProtectionSnapshot(bus, input, "qemu-functional"));
  }
});
test("qualification missing response still expires at exactly twenty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const pending = requestQualifiedProtectionSnapshot(createEventBus(), input, "qemu-functional");
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const refused = assert.rejects(pending, { code: "PROTECTION_RESPONSE_TIMEOUT" });
  t.mock.timers.tick(19999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await refused;
});
test(
  "a synchronous producer cannot authorize after the qualification deadline",
  { timeout: 30000 },
  async () => {
    const bus = createEventBus();
    bus.on(PROTECTION_SNAPSHOT_EVENT, (value) => {
      // Block this test worker's event loop, without spinning CPU, so only the
      // real elapsed-time response check can reject before queued timers run.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20050);
      const request = value as ProtectionSnapshotRequest;
      request.respond(proof(request));
    });
    await assert.rejects(requestQualifiedProtectionSnapshot(bus, input, "qemu-functional"), {
      code: "PROTECTION_RESPONSE_TIMEOUT",
    });
  },
);
