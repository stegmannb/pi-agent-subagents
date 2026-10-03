import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProcessRpc, type ProcessRpcOptions } from "../../src/process-rpc.ts";
import { protectionVM, protectionCaseTimeoutMs, childRunTimeoutSeconds } from "./parent-startup.ts";

const fixture = fileURLToPath(new URL("./fixtures/lifecycle-pi.mjs", import.meta.url));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function options(mode: string, extra: Partial<ProcessRpcOptions> = {}): ProcessRpcOptions {
  return {
    executable: process.execPath,
    args: [fixture, mode],
    cwd: "/tmp",
    environment: {},
    requestTimeoutMs: protectionVM ? 120000 : 1000,
    startupTimeoutMs: protectionVM ? 120000 : 2000,
    verifyReady: async () => {},
    ...extra,
  };
}
test(
  "expired dialog cancels its human channel and refuses a late correlated approval",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const expired = deferred<void>();
    const response = deferred<import("../../src/process-dialog.ts").ProcessDialogResponse>();
    let replies = 0;
    const rpc = await ProcessRpc.start(
      options("dialog-expire", {
        onDialog: async (request, signal) => {
          assert.equal(request.id, "question");
          signal.addEventListener("abort", () => expired.resolve(), { once: true });
          return response.promise;
        },
        onEvent: (event) => {
          if (event.type === "dialog_answer") replies++;
        },
      }),
    );
    const abort = new AbortController();
    const run = rpc.prompt("held", {
      maxTurns: 4,
      timeoutMs: childRunTimeoutSeconds(5) * 1000,
      signal: abort.signal,
    });
    void run.catch(() => {});
    try {
      await expired.promise;
      response.resolve({ type: "extension_ui_response", id: "question", confirmed: true });
      await rpc.getState();
      assert.equal(replies, 0);
      assert.equal(rpc.alive, true);
      abort.abort();
      await assert.rejects(run, { code: "ABORTED" });
    } finally {
      await rpc.close();
    }
  },
);
test(
  "wrong dialog correlation refuses the response; explicit cancellation reaches only its request",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    for (const valid of [false, true]) {
      const answered = deferred<unknown>();
      const rpc = await ProcessRpc.start(
        options("dialog-confirm", {
          onDialog: async () => ({
            type: "extension_ui_response",
            id: valid ? "question" : "other-run",
            cancelled: true,
          }),
          onEvent: (event) => {
            if (event.type === "dialog_answer") answered.resolve(event.response);
          },
        }),
      );
      const abort = new AbortController();
      const run = rpc.prompt("held", {
        maxTurns: 4,
        timeoutMs: childRunTimeoutSeconds(5) * 1000,
        signal: abort.signal,
      });
      void run.catch(() => {});
      try {
        if (valid) {
          assert.deepEqual(await answered.promise, {
            type: "extension_ui_response",
            id: "question",
            cancelled: true,
          });
          abort.abort();
        }
        await assert.rejects(run, { code: valid ? "ABORTED" : "DIALOG_RESPONSE_INVALID" });
      } finally {
        await rpc.close();
      }
    }
  },
);
for (const stop of ["abort", "timeout", "SIGTERM"] as const)
  test(
    `own actual process ${stop} keeps cooperative abort before TERM and bounded KILL`,
    { timeout: protectionCaseTimeoutMs },
    async () => {
      const ready = deferred<void>();
      const directory = mkdtempSync("/tmp/pasa-stop-");
      const rpc = await ProcessRpc.start(
        options("ignore-term", {
          environment: { PASA_LIFE_TRACE: join(directory, "trace") },
          onEvent: (e) => {
            if (e.type === "tool_execution_start") ready.resolve();
          },
        }),
      );
      const abort = new AbortController();
      const result = rpc.prompt("held", {
        maxTurns: 4,
        timeoutMs: childRunTimeoutSeconds(stop === "timeout" ? 0.2 : 5) * 1000,
        signal: abort.signal,
      });
      void result.catch(() => {});
      await ready.promise;
      assert.notEqual(rpc.pid, process.pid);
      if (stop === "abort") abort.abort();
      if (stop === "SIGTERM") process.kill(rpc.pid, "SIGTERM");
      if (stop === "SIGTERM") abort.abort();
      await assert.rejects(result, { code: stop === "timeout" ? "TIME_LIMIT" : "ABORTED" });
      await rpc.close();
      assert.equal(rpc.alive, false);
      const events = readFileSync(join(directory, "trace"), "utf8").trim().split("\n");
      assert.ok(events.includes("abort_observed"));
      assert.ok(events.includes("term_observed"));
      assert.ok(events.indexOf("abort_observed") < events.lastIndexOf("term_observed"));
      rmSync(directory, { recursive: true });
    },
  );
test(
  "ownership changes at the TERM boundary refuse later signals to a still live own process",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const ready = deferred<void>(),
      refused = deferred<void>();
    let managed = true;
    const rpc = await ProcessRpc.start(
      options("ignore-term", {
        onEvent: (e) => {
          if (e.type === "tool_execution_start") ready.resolve();
        },
        beforeMutation: (action) => {
          if (action === "signal") {
            managed = false;
            refused.resolve();
          }
          if (!managed) throw new Error("ownership changed");
        },
      }),
    );
    const abort = new AbortController();
    const result = rpc.prompt("held", {
      maxTurns: 4,
      timeoutMs: childRunTimeoutSeconds(5) * 1000,
      signal: abort.signal,
    });
    void result.catch(() => {});
    try {
      await ready.promise;
      abort.abort();
      await assert.rejects(result, { code: "ABORTED" });
      await refused.promise;
      await rpc.close();
      assert.equal(rpc.alive, true);
    } finally {
      process.kill(rpc.pid, "SIGKILL");
    }
  },
);
for (const method of ["select", "confirm", "input"] as const)
  test(
    `correlated ${method} uses a human response and never interrupts the held tool`,
    { timeout: protectionCaseTimeoutMs },
    async () => {
      const answer = deferred<unknown>();
      const rpc = await ProcessRpc.start(
        options(`dialog-${method}`, {
          onDialog: async (request) => ({
            type: "extension_ui_response",
            id: request.id,
            ...(method === "confirm"
              ? { confirmed: false }
              : { value: method === "select" ? "two" : "human text" }),
          }),
          onEvent: (e) => {
            if (e.type === "dialog_answer") answer.resolve(e.response);
          },
        }),
      );
      const abort = new AbortController();
      const result = rpc.prompt("held", {
        maxTurns: 4,
        timeoutMs: childRunTimeoutSeconds(5) * 1000,
        signal: abort.signal,
      });
      void result.catch(() => {});
      try {
        const response = await answer.promise;
        assert.deepEqual(response, {
          type: "extension_ui_response",
          id: "question",
          ...(method === "confirm"
            ? { confirmed: false }
            : { value: method === "select" ? "two" : "human text" }),
        });
        assert.equal(rpc.alive, true);
        abort.abort();
        await assert.rejects(result, { code: "ABORTED" });
      } finally {
        await rpc.close();
      }
    },
  );
test(
  "headless dialog stays blocked until cancellation and custom TUI is explicitly unsupported",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    for (const method of ["confirm", "custom"] as const) {
      const pending = deferred<void>();
      let replies = 0;
      const rpc = await ProcessRpc.start(
        options(`dialog-${method}`, {
          onEvent: (e) => {
            if (e.type === "process_dialog_pending") {
              assert.equal(e.blocked, true);
              pending.resolve();
            }
            if (e.type === "dialog_answer") replies++;
          },
        }),
      );
      const abort = new AbortController();
      const result = rpc.prompt("held", {
        maxTurns: 4,
        timeoutMs: childRunTimeoutSeconds(5) * 1000,
        signal: abort.signal,
      });
      void result.catch(() => {});
      try {
        if (method === "confirm") {
          await pending.promise;
          assert.equal(replies, 0);
          abort.abort();
        }
        await assert.rejects(result, {
          code: method === "confirm" ? "ABORTED" : "CUSTOM_TUI_UNSUPPORTED",
        });
        assert.equal(replies, 0);
      } finally {
        await rpc.close();
      }
    }
  },
);
