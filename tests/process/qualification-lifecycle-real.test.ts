import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./lifecycle-host-scenario.ts";
import { protectionCaseTimeoutMs, childPromptTimeoutMs } from "./parent-startup.ts";

test(
  "qualification: duplicate broker delivery, failed cleanup, same-run close and stale handle after resume",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("cleanup", false, true);
    const jsonl = async (path: string): Promise<any[]> =>
      (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    try {
      await f.prompt;
      const failed = await f.record();
      assert.equal(failed.phase, "cleanup-error");
      assert.equal(failed.delivery?.ingested, true);
      const published = await jsonl(
        join(f.root, "children", "lifecycle", "qualification-redelivery.jsonl"),
      );
      assert.equal(published.length, 2);
      assert.deepEqual(
        published.map((entry) => entry.delivery),
        [1, 2],
      );
      assert.deepEqual(published[0].result, published[1].result);
      assert.equal(published[0].pid, failed.pid);
      const parent = await f.parent.getState();
      const results = async () =>
        (await jsonl(parent.sessionFile!)).filter((entry) => entry.customType === "pasa:result");
      const initial = await results();
      assert.equal(initial.length, 1);
      assert.deepEqual(initial[0].data, published[0].result);
      const agentId = (f.outcomes[0] as any).details.agentId;
      await f.parent.prompt(
        `Task:\nCHILD:tool:${JSON.stringify({
          name: "control_subagent_process",
          arguments: {
            agent_id: agentId,
            process_id: failed.processId,
            ownership_revision: failed.revision,
            action: "cleanup",
          },
        })}`,
        { maxTurns: 4, timeoutMs: childPromptTimeoutMs },
      );
      await f.disconnected.promise;
      const completed = await f.record();
      assert.equal(completed.phase, "completed");
      assert.equal(completed.processId, failed.processId);
      assert.equal(completed.pid, failed.pid);
      assert.deepEqual(
        await results(),
        initial,
        "cleanup uses the first persisted result without another append",
      );
      await f.parent.prompt(
        `HOST:${JSON.stringify({
          resume: agentId,
          prompt: 'CHILD:tool:{"name":"bash","arguments":{"command":"echo lifecycle"}}',
        })}`,
        { maxTurns: 4, timeoutMs: childPromptTimeoutMs },
      );
      const resumed = (f.outcomes.at(-1) as any).details.process;
      assert.equal(resumed.sessionId, failed.sessionId);
      assert.equal(resumed.sessionFile, failed.sessionFile);
      assert.equal(resumed.cwd, failed.cwd);
      assert.notEqual(resumed.processId, failed.processId);
      assert.notEqual(resumed.pid, failed.pid);
      const recordPath = join(f.root, "children", "lifecycle", `${resumed.processId}.json`);
      const before = await readFile(recordPath, "utf8");
      const beforeResults = await results();
      assert.equal(JSON.parse(before).phase, "cleanup-error");
      await f.parent.prompt(
        `Task:\nCHILD:tool:${JSON.stringify({
          name: "control_subagent_process",
          arguments: {
            agent_id: agentId,
            process_id: failed.processId,
            ownership_revision: failed.revision,
            action: "cleanup",
          },
        })}`,
        { maxTurns: 4, timeoutMs: childPromptTimeoutMs },
      );
      const staleAction = (await jsonl(parent.sessionFile!)).findLast(
        (entry) => entry.message?.toolName === "control_subagent_process",
      );
      assert.match(
        JSON.stringify(staleAction),
        /Process action refused: PROCESS_IDENTITY_UNPROVEN/,
      );
      assert.equal(
        await readFile(recordPath, "utf8"),
        before,
        "stale cleanup cannot mutate the current incarnation",
      );
      assert.deepEqual(
        await results(),
        beforeResults,
        "stale cleanup cannot append or change either result",
      );
      assert.equal((await results()).length, 2);
      await f.parent.prompt(
        `Task:\nCHILD:tool:${JSON.stringify({
          name: "control_subagent_process",
          arguments: {
            agent_id: agentId,
            process_id: resumed.processId,
            ownership_revision: resumed.revision,
            action: "cleanup",
          },
        })}`,
        { maxTurns: 4, timeoutMs: childPromptTimeoutMs },
      );
      assert.equal(JSON.parse(await readFile(recordPath, "utf8")).phase, "completed");
      assert.equal((await results()).length, 2);
      assert.equal(await readFile(join(failed.cwd, "work.txt"), "utf8"), "retained work\n");
      await writeFile(
        join(f.root, "qualification-proof.json"),
        JSON.stringify(
          {
            failed,
            completed,
            resumed: JSON.parse(await readFile(recordPath, "utf8")),
            published: await jsonl(
              join(f.root, "children", "lifecycle", "qualification-redelivery.jsonl"),
            ),
            parent,
            results: await results(),
            staleHandleRefused: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await f.close();
    }
  },
);
