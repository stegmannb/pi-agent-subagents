import {
  InspectionTrace,
  isInspectionDiagnostic,
  diagnosticHistoryLimit,
} from "./process-inspection-diagnostic.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProcessRpc, type ProcessRpcOptions } from "./process-rpc.ts";
import { childFailureExitStatus, readChildFailureExitStatus } from "./process-child-failure.ts";

const fake = fileURLToPath(new URL("../tests/process/fixtures/fake-pi.mjs", import.meta.url));
const limits = { maxTurns: 2, timeoutMs: 1000 };
function options(mode: string, extra: Partial<ProcessRpcOptions> = {}): ProcessRpcOptions {
  return {
    executable: process.execPath,
    args: [fake, mode],
    cwd: tmpdir(),
    environment: {},
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    verifyReady: async () => {},
    ...extra,
  };
}
test("Child failure status sanitizes unknown errors without invoking getters or coercion", () => {
  const secret = "private credential /secret/path";
  let getterReads = 0;
  let coercions = 0;
  const accessor = Object.defineProperty({}, "code", {
    get() {
      getterReads++;
      throw new Error("must never invoke code getter");
    },
  });
  const coercion = {
    code: {
      toString() {
        coercions++;
        throw new Error("must never coerce code");
      },
    },
  };
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    },
  );
  for (const error of [
    new Error(secret),
    { code: secret },
    accessor,
    coercion,
    proxy,
    null,
    secret,
    Object.create({ code: "RESOURCE_CHANGED" }),
  ]) {
    assert.equal(childFailureExitStatus("child:input", error), 96);
    assert.deepEqual(readChildFailureExitStatus(96), {
      phase: "child:input",
      code: "CHILD_FAILURE",
    });
  }
  assert.equal(getterReads, 0);
  assert.equal(coercions, 0);
  const known = Object.defineProperty({ code: "RESOURCE_CHANGED" }, "message", {
    get() {
      throw new Error("must never read message");
    },
  });
  assert.equal(childFailureExitStatus("child:input", known), 97);
  assert.deepEqual(readChildFailureExitStatus(97), {
    phase: "child:input",
    code: "RESOURCE_CHANGED",
  });
  for (const status of [null, 0, 1, 63, 93, 127, 224, 255, 256, -1, 97.5, NaN])
    assert.equal(readChildFailureExitStatus(status), undefined);
});
for (const privateChild of [false, true]) {
  test(`RPC decodes immediate failure only for a private bootstrapped Child: ${privateChild}`, async () => {
    await assert.rejects(
      ProcessRpc.start(
        options("exit-status-81", {
          ...(privateChild ? { bootstrapData: {} } : {}),
        }),
      ),
      {
        code: privateChild ? "PROTECTION_RESPONSE_TIMEOUT" : "PROCESS_EXITED",
        message: privateChild
          ? "Pi RPC failed: PROTECTION_RESPONSE_TIMEOUT [child:boot]"
          : "Pi RPC failed: PROCESS_EXITED",
      },
    );
  });
}
for (const status of [97, 128, 161, 1, 127]) {
  test(`RPC preserves only fixed diagnostics from an immediately exiting owned process: ${status}`, async () => {
    const events: unknown[] = [];
    const client = await ProcessRpc.start(
      options(`prompt-exit-status-${status}`, {
        bootstrapData: {},
        onEvent: (event) => events.push(event),
      }),
    );
    const diagnostic = readChildFailureExitStatus(status);
    try {
      await assert.rejects(client.prompt("test", limits), {
        code: diagnostic?.code ?? "PROCESS_EXITED",
        phase: diagnostic?.phase,
      });
    } finally {
      await client.close();
    }
    assert.deepEqual(events, []);
    assert.throws(() => process.kill(client.pid, 0), { code: "ESRCH" });
  });
}
for (const mode of ["managed-wake", "managed-followup"]) {
  for (const maxTurns of [1, 2]) {
    test(`RPC retains cumulative turn limit across ${mode}: ${maxTurns}`, async () => {
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let turns = 0;
      const client = await ProcessRpc.start(
        options(mode, {
          onEvent: (event) => {
            if (event.type === "turn_end") turns++;
            if (event.type === "agent_end" && turns === 2) complete();
          },
        }),
      );
      try {
        const result = client.prompt("test", { maxTurns, timeoutMs: 1000, completion });
        if (maxTurns === 1) await assert.rejects(result, { code: "TURN_LIMIT" });
        else assert.equal(await result, "continued");
      } finally {
        await client.close();
      }
    });
  }
}
for (const [mode, code] of [
  ["early-exit", "PROCESS_EXITED"],
  ["bad-json", "PROTOCOL_ERROR"],
  ["large-frame", "FRAME_TOO_LARGE"],
  ["mismatch", "RESPONSE_MISMATCH"],
  ["silent", "REQUEST_TIMEOUT"],
]) {
  test(`RPC start refuses ${mode} and terminates`, async () => {
    await assert.rejects(
      ProcessRpc.start(options(mode, { maxFrameBytes: 1024, requestTimeoutMs: 200 })),
      { code },
    );
  });
}
test("RPC missing executable fails without a phantom process", async () => {
  await assert.rejects(ProcessRpc.start(options("success", { executable: "/missing-pasa-node" })), {
    code: "SPAWN_FAILED",
  });
});
test("RPC rejects readiness before issuing any prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pasa-rpc-"));
  const trace = join(dir, "trace.jsonl");
  try {
    await assert.rejects(
      ProcessRpc.start(
        options("success", {
          startupTimeoutMs: 1000,
          args: [fake, "success", trace],
          verifyReady: async () => {
            throw new Error("secret config");
          },
        }),
      ),
      { code: "READINESS_REJECTED" },
    );
    const commands = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      commands.map((c) => c.type),
      ["get_state", "set_auto_retry"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("RPC bounds readiness verification", async () => {
  await assert.rejects(
    ProcessRpc.start(
      options("success", {
        startupTimeoutMs: 1000,
        requestTimeoutMs: 200,
        verifyReady: () => new Promise(() => {}),
      }),
    ),
    { code: "READINESS_TIMEOUT", phase: "verifyReady" },
  );
});

test("RPC startup override admits delayed first state but retains subsequent request deadline", async () => {
  const client = await ProcessRpc.start(
    options("delayed-followup", {
      startupTimeoutMs: 1000,
      requestTimeoutMs: 150,
    }),
  );
  try {
    await assert.rejects(client.getState(), { code: "REQUEST_TIMEOUT", phase: "get_state" });
  } finally {
    await client.close();
  }
});
test("RPC delayed initial state can complete a normal prompt", async () => {
  const client = await ProcessRpc.start(
    options("delayed", { startupTimeoutMs: 1000, requestTimeoutMs: 150 }),
  );
  try {
    assert.equal(await client.prompt("test", limits), "finished");
  } finally {
    await client.close();
  }
});
test("RPC startup override retains state validation", async () => {
  await assert.rejects(ProcessRpc.start(options("invalid-state", { startupTimeoutMs: 1000 })), {
    code: "STATE_MISMATCH",
  });
});
test("RPC initial state remains bounded independently", async () => {
  await assert.rejects(
    ProcessRpc.start(
      options("delayed", {
        startupTimeoutMs: 100,
        requestTimeoutMs: 1000,
      }),
    ),
    { code: "REQUEST_TIMEOUT", phase: "startup:get_state" },
  );
});
test("RPC startup override does not extend retry-disable acknowledgement", async () => {
  await assert.rejects(
    ProcessRpc.start(
      options("delayed-retry", {
        startupTimeoutMs: 1000,
        requestTimeoutMs: 150,
      }),
    ),
    { code: "REQUEST_TIMEOUT", phase: "set_auto_retry" },
  );
});
test("RPC startup override does not extend private readiness inspection", async () => {
  await assert.rejects(
    ProcessRpc.start(
      options("delayed-inspect", {
        startupTimeoutMs: 1000,
        requestTimeoutMs: 150,
        bootstrapData: {},
      }),
    ),
    { code: "CONTROL_TIMEOUT", phase: "inspect" },
  );
});
test("RPC startup override still requires explicit readiness verification", async () => {
  await assert.rejects(
    ProcessRpc.start(
      options("success", {
        startupTimeoutMs: 1000,
        verifyReady: undefined as any,
      }),
    ),
    { code: "READINESS_REQUIRED" },
  );
});
test("RPC rejects invalid startup budgets before spawning", async () => {
  for (const startupTimeoutMs of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    120001,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    "1000",
  ])
    await assert.rejects(
      ProcessRpc.start(
        options("success", {
          executable: "/must-not-spawn",
          startupTimeoutMs: startupTimeoutMs as number,
        }),
      ),
      { code: "INVALID_LIMIT" },
    );
});
test("RPC bounds private bootstrap and inspection payloads", async () => {
  await assert.rejects(
    ProcessRpc.start(options("success", { bootstrapData: "x".repeat(1025), maxFrameBytes: 1024 })),
    { code: "BOOTSTRAP_TOO_LARGE" },
  );
  await assert.rejects(
    ProcessRpc.start(options("large-control", { bootstrapData: {}, maxFrameBytes: 1024 })),
    { code: "CONTROL_FRAME_TOO_LARGE" },
  );
});
for (const mode of ["success", "late-ack"]) {
  test(`RPC requires structured completion with ${mode}`, async () => {
    const events: Array<Record<string, unknown>> = [];
    const client = await ProcessRpc.start(options(mode, { onEvent: (e) => events.push(e) }));
    try {
      assert.notEqual(client.pid, process.pid);
      assert.equal(await client.prompt("test", limits), "finished");
      assert.ok(events.some((e) => e.type === "tool_execution_end" && e.isError));
      assert.ok(events.some((e) => e.type === "compaction_end"));
      assert.ok(events.some((e) => e.type === "message_end"));
    } finally {
      await client.close();
    }
  });
}
for (const [mode, code] of [
  ["ack-only", "TIME_LIMIT"],
  ["delta-only", "INCOMPLETE_RESULT"],
  ["provider-error", "PROVIDER_FAILED"],
  ["exit-on-prompt", "PROCESS_EXITED"],
  ["turn-limit", "TURN_LIMIT"],
]) {
  test(`RPC prompt fails ${mode} without retry`, async () => {
    const client = await ProcessRpc.start(options(mode));
    try {
      await assert.rejects(client.prompt("test", { maxTurns: 1, timeoutMs: 200 }), { code });
    } finally {
      await client.close();
    }
  });
}
test("RPC cancellation terminates an accepted prompt", async () => {
  const client = await ProcessRpc.start(options("ack-only"));
  const controller = new AbortController();
  try {
    const result = client.prompt("test", { ...limits, signal: controller.signal });
    controller.abort();
    await assert.rejects(result, { code: "ABORTED" });
  } finally {
    await client.close();
  }
});

test("RPC prompt acknowledgement uses the run budget after the ordinary request deadline", async () => {
  const client = await ProcessRpc.start(options("slow-prompt-ack", { requestTimeoutMs: 150 }));
  try {
    assert.equal(await client.prompt("test", limits), "finished");
  } finally {
    await client.close();
  }
});
for (const mode of ["no-prompt-ack", "ack-only"]) {
  test(`RPC entire run budget bounds ${mode} and terminates its child`, async () => {
    const client = await ProcessRpc.start(options(mode, { requestTimeoutMs: 100 }));
    try {
      await assert.rejects(client.prompt("private task text", { ...limits, timeoutMs: 250 }), {
        code: "TIME_LIMIT",
        message: "Pi RPC failed: TIME_LIMIT",
      });
      await assert.rejects(client.getState(), { code: "TIME_LIMIT" });
    } finally {
      await client.close();
    }
    assert.throws(() => process.kill(client.pid, 0), { code: "ESRCH" });
  });
}
test("RPC readiness consumes the same total budget as prompt acknowledgement", async () => {
  let verifications = 0;
  const client = await ProcessRpc.start(
    options("slow-prompt-ack", {
      verifyReady: async () => {
        if (++verifications > 1) await new Promise((resolve) => setTimeout(resolve, 200));
      },
    }),
  );
  try {
    // 200ms readiness + 350ms acknowledgement cannot fit into the same 450ms run.
    await assert.rejects(client.prompt("test", { ...limits, timeoutMs: 450 }), {
      code: "TIME_LIMIT",
    });
  } finally {
    await client.close();
  }
});

test("diagnostic sink exceptions preserve the actual operation and original error", async () => {
  const trace = new InspectionTrace("startup", () => {
    throw new Error("sink secret");
  });
  const error = new Error("operation secret");
  let calls = 0;
  assert.equal(
    trace.sync("resources", () => ++calls),
    1,
  );
  await assert.rejects(
    trace.async("guard", async () => {
      ++calls;
      throw error;
    }),
    (caught) => caught === error,
  );
  assert.equal(calls, 2);
  for (const durationMs of [-1, NaN, Infinity, null, "0"]) {
    assert.equal(
      isInspectionDiagnostic({ stage: "startup", phase: "guard", event: "end", durationMs }),
      false,
    );
  }
});
for (const [mode, code] of [
  ["diagnostic-unsolicited", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-negative", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-extra", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-phase", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-null", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-large", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-stage", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-id", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-envelope", "CONTROL_DIAGNOSTIC_INVALID"],
  ["diagnostic-flood", "CONTROL_DIAGNOSTIC_LIMIT"],
  ["diagnostic-only", "CONTROL_TIMEOUT"],
]) {
  test(`private diagnostic refuses ${mode} without reaching readiness`, async () => {
    let verified = false;
    const records: unknown[] = [];
    await assert.rejects(
      ProcessRpc.start(
        options(mode, {
          bootstrapData: {},
          requestTimeoutMs: 200,
          ...(mode === "diagnostic-unsolicited"
            ? {}
            : {
                onInspectionDiagnostic: (record: unknown) => {
                  records.push(record);
                },
              }),
          verifyReady: async () => {
            verified = true;
          },
        }),
      ),
      { code },
    );
    assert.equal(verified, false);
    assert.ok(!JSON.stringify(records).includes("secret"));
  });
}
test("private diagnostics default off; enabled observations cannot authorize readiness", async () => {
  const disabled = await ProcessRpc.start(options("diagnostic", { bootstrapData: {} }));
  try {
    assert.deepEqual(disabled.getInspectionDiagnostics(), []);
  } finally {
    await disabled.close();
  }
  const records: unknown[] = [];
  await assert.rejects(
    ProcessRpc.start(
      options("diagnostic", {
        bootstrapData: {},
        onInspectionDiagnostic: (record) => {
          records.push(record);
        },
        verifyReady: async () => {
          throw new Error("reject actual proof");
        },
      }),
    ),
    { code: "READINESS_REJECTED" },
  );
  assert.ok(records.length > 0);
});
test("diagnostics distinguish startup/preprompt, bound history, and never consume stdout as private evidence", async () => {
  for (const mode of ["diagnostic", "diagnostic-stdout"]) {
    const client = await ProcessRpc.start(
      options(mode, {
        bootstrapData: {},
        onInspectionDiagnostic: () => {
          throw new Error("ignored sink");
        },
      }),
    );
    try {
      for (let i = 0; i < 36; i++) assert.equal(await client.prompt("test", limits), "finished");
      const history = client.getInspectionDiagnostics();
      assert.equal(history.length, diagnosticHistoryLimit);
      assert.ok(history.every(isInspectionDiagnostic));
      assert.ok(history.some((d) => d.stage === "preprompt"));
      assert.equal(
        history.some((d) => d.phase === "resources"),
        mode === "diagnostic",
      );
    } finally {
      await client.close();
    }
  }
});

test("per-process diagnostic limit remains bounded across individually valid inspections", async () => {
  const client = await ProcessRpc.start(
    options("diagnostic-process-flood", {
      bootstrapData: {},
      onInspectionDiagnostic: () => {},
    }),
  );
  try {
    for (let i = 0; i < 3; i++) assert.equal(await client.prompt("test", limits), "finished");
    await assert.rejects(client.prompt("test", limits), { code: "CONTROL_DIAGNOSTIC_LIMIT" });
    assert.equal(client.getInspectionDiagnostics().length, diagnosticHistoryLimit);
  } finally {
    await client.close();
  }
});

for (const qualificationPreset of [null, 20000, "unknown", {}, [], false]) {
  test(`RPC refuses invalid qualification preset before spawning: ${JSON.stringify(qualificationPreset)}`, async () => {
    await assert.rejects(
      ProcessRpc.start(
        options("silent", {
          executable: "/must-not-spawn",
          qualificationPreset: qualificationPreset as any,
        }),
      ),
      { code: "INVALID_QUALIFICATION_PRESET" },
    );
  });
}
test("qualification cannot be selected by environment or a nonprivate transport", async () => {
  await assert.rejects(
    ProcessRpc.start(options("normal", { qualificationPreset: "qemu-functional" })),
    { code: "PRIVATE_BOOTSTRAP_REQUIRED" },
  );
  await assert.rejects(
    ProcessRpc.start(
      options("delayed-inspect", {
        bootstrapData: {},
        requestTimeoutMs: 100,
        environment: {
          PASA_QUALIFICATION_PRESET: "qemu-functional",
          qualificationPreset: "qemu-functional",
        },
      }),
    ),
    { code: "CONTROL_TIMEOUT" },
  );
});
test("qualification accepts slower inspection and initial verification without changing ordinary requests", async () => {
  const client = await ProcessRpc.start(
    options("delayed-inspect", {
      bootstrapData: {},
      qualificationPreset: "qemu-functional",
      requestTimeoutMs: 100,
      verifyReady: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    }),
  );
  await client.close();
  for (const mode of ["delayed-retry", "delayed-followup"]) {
    const config = options(mode, {
      bootstrapData: {},
      qualificationPreset: "qemu-functional",
      requestTimeoutMs: 100,
    });
    if (mode === "delayed-retry")
      await assert.rejects(ProcessRpc.start(config), {
        code: "REQUEST_TIMEOUT",
        phase: "set_auto_retry",
      });
    else {
      const instance = await ProcessRpc.start(config);
      try {
        await assert.rejects(instance.getState(), { code: "REQUEST_TIMEOUT", phase: "get_state" });
      } finally {
        await instance.close();
      }
    }
  }
});
for (const qualificationPreset of [undefined, "qemu-functional"] as const) {
  test(`inspection/readiness timer race remains handled: ${qualificationPreset ?? "default"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let inspecting!: () => void;
    let requestErrors = 0;
    const entered = new Promise<void>((resolve) => {
      inspecting = resolve;
    });
    const started = ProcessRpc.start(
      options("diagnostic-only", {
        bootstrapData: {},
        qualificationPreset,
        requestTimeoutMs: 10000,
        onInspectionDiagnostic: (record) => {
          if (record.phase === "request" && record.event === "start") inspecting();
          if (record.phase === "request" && record.event === "error") requestErrors++;
        },
      }),
    );
    const refused = assert.rejects(started, { code: "CONTROL_TIMEOUT", phase: "inspect" });
    await entered;
    t.mock.timers.tick((qualificationPreset ? 40000 : 10000) - 1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requestErrors, 0);
    t.mock.timers.tick(1);
    await Promise.resolve();
    t.mock.timers.tick(100);
    await refused;
    assert.equal(requestErrors, 1);
    // node:test also fails this test for an unhandled deferred rejection. The
    // default case expires both initial-readiness and inspection in one tick.
  });
}
test("qualification initial readiness may complete just before its eighty-second bound", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let verifying!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    verifying = resolve;
  });
  const verification = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = ProcessRpc.start(
    options("normal", {
      bootstrapData: {},
      qualificationPreset: "qemu-functional",
      verifyReady: async () => {
        verifying();
        await verification;
      },
    }),
  );
  await entered;
  t.mock.timers.tick(79999);
  release();
  const client = await started;
  t.mock.timers.reset();
  const closing = client.close();
  await closing;
});
test("qualification initial readiness still expires at eighty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let verifying!: () => void;
  const entered = new Promise<void>((resolve) => {
    verifying = resolve;
  });
  const started = ProcessRpc.start(
    options("normal", {
      bootstrapData: {},
      qualificationPreset: "qemu-functional",
      verifyReady: async () => {
        verifying();
        await new Promise<void>(() => {});
      },
    }),
  );
  const refused = assert.rejects(started, { code: "READINESS_TIMEOUT", phase: "verifyReady" });
  await entered;
  t.mock.timers.tick(79999);
  t.mock.timers.tick(1);
  // The readiness rejection is consumed asynchronously; leave only OS cleanup on real time.
  t.mock.timers.reset();
  await refused;
});
