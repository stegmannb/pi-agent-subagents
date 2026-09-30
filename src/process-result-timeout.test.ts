import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { LocalMessageBroker } from "./messaging-broker.ts";
import { LocalMessageClient } from "./messaging-client.ts";
import { ProcessCommunication } from "./process-communication.ts";
import { ResultDeliveryTimeoutError } from "./process-results.ts";
import { ProcessRpc } from "./process-rpc.ts";

test("actual result collection preserves run timeout and distinguishes channel failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pasa-result-timeout-"));
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
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(root, root),
    tools: [],
  });
  try {
    for (const mode of ["result-timeout", "rpc-timeout", "channel-close", "same-text-error"]) {
      const broker = await LocalMessageBroker.start();
      const registration = broker.registerRoot(
        session.sessionId,
        { name: "root", readOnly: false, allowedTools: [] },
        { maxConcurrent: 4, maxDepth: 2 },
      );
      const client = await LocalMessageClient.connect(registration.credential);
      const channel = new ProcessCommunication(
        client,
        registration.binding,
        session,
        createEventBus(),
      );
      const events: Array<Record<string, unknown>> = [];
      let rpc: ProcessRpc | undefined;
      try {
        rpc = await ProcessRpc.start({
          executable: process.execPath,
          args: [
            fileURLToPath(new URL("../tests/process/fixtures/fake-pi.mjs", import.meta.url)),
            "ack-only",
          ],
          cwd: root,
          environment: {},
          verifyReady: async () => {},
          onEvent: (event) => events.push(event),
        });
        const identity = {
          resultId: `${mode}:result`,
          taskId: mode,
          childAgentId: "child",
          childSessionId: "child-session",
          childProcessId: mode,
          parentSessionId: session.sessionId,
        };
        channel.results.expect(identity);
        const completion =
          mode === "same-text-error"
            ? Promise.reject(new Error("RESULT_DELIVERY_TIMEOUT"))
            : channel.waitResult(identity, mode === "result-timeout" ? 200 : 2000);
        let collectionError: unknown;
        void completion.catch((error) => {
          collectionError = error;
        });
        const timeout = mode === "result-timeout" || mode === "rpc-timeout";
        const running = rpc.prompt("bounded task", {
          maxTurns: 2,
          timeoutMs: timeout ? 200 : 2000,
          completion,
        });
        if (mode === "channel-close") channel.close();
        await assert.rejects(
          running,
          { code: timeout ? "TIME_LIMIT" : "RESULT_DELIVERY_FAILED" },
          mode,
        );
        if (mode === "result-timeout")
          assert.ok(collectionError instanceof ResultDeliveryTimeoutError);
        // Let the other pending result waiter reject after RPC termination too.
        channel.close();
        await completion.catch(() => {});
        await rpc.close();
        assert.deepEqual(
          events.filter((event) => event.type === "process_limit"),
          timeout ? [{ type: "process_limit", limit: "time" }] : [],
          mode,
        );
        assert.throws(() => process.kill(rpc!.pid, 0), { code: "ESRCH" });
        assert.deepEqual(channel.results.get(identity.resultId)?.status, {
          identity,
          produced: false,
          accepted: false,
          received: false,
          ingested: false,
        });
      } finally {
        channel.close();
        client.close();
        await rpc?.close();
        await broker.close();
      }
    }
  } finally {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
