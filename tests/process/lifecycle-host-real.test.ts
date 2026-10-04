import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
import { setup } from "./lifecycle-host-scenario.ts";

test(
  "actual companion/child routes select/input/denied approval and persists one result before cleanup",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("dialogs", true);
    try {
      assert.deepEqual(await f.answers.promise, {
        selected: "two",
        input: "human explanation",
        confirmed: false,
      });
      await f.prompt;
      await f.disconnected.promise;
      const value = await f.record();
      assert.equal(value.phase, "completed");
      assert.equal(value.delivery?.ingested, true);
      assert.deepEqual(f.questions, ["select", "input", "confirm"]);
      assert.equal(f.outcomes.length, 1);
      assert.equal(await readFile(join(f.run.cwd, "work.txt"), "utf8"), "retained work\n");
      assert.ok((await readFile(f.run.sessionFile, "utf8")).includes("HUMAN_APPROVAL_DENIED"));
    } finally {
      await f.close();
    }
  },
);
for (const stop of ["parent-exiting", "parent-kill", "question-disconnect"] as const)
  test(
    `actual ${stop} stops only the managed own child and retains unresolved evidence`,
    { timeout: protectionCaseTimeoutMs },
    async () => {
      const f = await setup(stop === "question-disconnect" ? "question" : "held");
      try {
        if (stop === "question-disconnect")
          await f.waitState((value) => value.phase === "question");
        if (stop === "parent-exiting") await f.parent.close();
        else process.kill(f.parent.pid, "SIGKILL");
        await f.disconnected.promise;
        await assert.rejects(f.prompt);
        const value = await f.record();
        assert.equal(
          value.parentState,
          stop === "parent-exiting" ? "parent_exiting" : "disconnected",
        );
        assert.notEqual(value.phase, "completed");
        assert.notEqual(value.delivery?.ingested, true);
        assert.equal(f.questions.length, 0);
        assert.equal(await readFile(join(f.run.cwd, "work.txt"), "utf8"), "retained work\n");
        assert.ok((await readFile(f.run.sessionFile, "utf8")).includes(f.run.sessionId));
      } finally {
        await f.close();
      }
    },
  );
for (const ownership of ["manual", "external"] as const)
  test(
    `actual ${ownership} takeover survives parent kill and revokes old routing/actions`,
    { timeout: protectionCaseTimeoutMs },
    async () => {
      const f = await setup("held");
      try {
        await f.parent.command(`/life-control ${JSON.stringify({ handle: f.run, ownership })}`);
        const taken = await f.record();
        assert.equal(taken.ownership, ownership);
        assert.equal(taken.routeParentId, null);
        assert.equal(taken.revision, 1);
        process.kill(f.parent.pid, "SIGKILL");
        await assert.rejects(f.prompt);
        await f.waitState((value) => value.parentState === "disconnected");
        assert.doesNotThrow(() => process.kill(f.run.pid!, 0));
        const value = await f.record();
        assert.equal(value.ownership, ownership);
        assert.notEqual(value.phase, "completed");
        assert.equal(await readFile(join(f.run.cwd, "work.txt"), "utf8"), "retained work\n");
      } finally {
        process.kill(f.run.pid!, "SIGKILL");
        await f.disconnected.promise;
        await f.close();
      }
    },
  );

test(
  "persisted result survives failed cleanup; retry closes the same run without another result or restart",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("cleanup");
    try {
      await f.prompt;
      const failed = await f.record();
      assert.equal(failed.phase, "cleanup-error");
      assert.equal(failed.delivery?.ingested, true);
      assert.doesNotThrow(() => process.kill(failed.pid!, 0));
      assert.ok(JSON.stringify(f.outcomes).includes("Process lifecycle pending"));
      await f.parent.command(
        `/life-control ${JSON.stringify({ handle: failed, action: "assert-reserved" })}`,
      );
      const state = await f.parent.getState();
      const countResults = async () =>
        (await readFile(state.sessionFile!, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (entry) =>
              entry.customType === "pasa:result" && entry.data.resultId === failed.resultId,
          );
      assert.equal((await countResults()).length, 1);
      await f.parent.command(
        `/life-control ${JSON.stringify({ handle: failed, action: "cleanup" })}`,
      );
      await f.disconnected.promise;
      const done = await f.record();
      assert.equal(done.phase, "completed");
      assert.equal(done.processId, failed.processId);
      assert.equal(done.pid, failed.pid);
      await f.parent.command(
        `/life-control ${JSON.stringify({ handle: done, action: "assert-released" })}`,
      );
      assert.equal((await countResults()).length, 1);
      assert.equal(await readFile(join(done.cwd, "work.txt"), "utf8"), "retained work\n");
      await f.parent.close();
      assert.equal((await f.record()).phase, "completed");
    } finally {
      await f.close();
    }
  },
);

test(
  "actual SDK AbortSignal cancels the correlated parent dialog without granting approval",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("cancel", true);
    try {
      await f.waitState((value) => value.phase === "question");
      f.cancelQuestion();
      assert.deepEqual(await f.answers.promise, { confirmed: false });
      await f.prompt;
      await f.disconnected.promise;
      const value = await f.record();
      assert.equal(value.phase, "completed");
      assert.equal(value.delivery?.ingested, true);
      assert.ok((await readFile(value.sessionFile, "utf8")).includes("HUMAN_APPROVAL_CANCELLED"));
    } finally {
      await f.close();
    }
  },
);

test(
  "explicit abort after persisted result and failed cleanup stops only that run and retains its result",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("cleanup");
    try {
      await f.prompt;
      const value = await f.record();
      assert.equal(value.phase, "cleanup-error");
      await f.parent.command(`/life-control ${JSON.stringify({ handle: value, action: "abort" })}`);
      await f.disconnected.promise;
      const stopped = await f.record();
      assert.equal(stopped.phase, "stopped");
      assert.equal(stopped.delivery?.ingested, true);
      assert.equal(stopped.processId, value.processId);
      assert.ok((await readFile(stopped.sessionFile, "utf8")).includes("TEST_PERSISTED_RESULT"));
    } finally {
      await f.close();
    }
  },
);

test(
  "actual process loss before confirmed parent ingestion retains unresolved result identity and refuses success cleanup",
  { timeout: protectionCaseTimeoutMs },
  async () => {
    const f = await setup("loss");
    try {
      await f.prompt;
      await f.disconnected.promise;
      const value = await f.record();
      assert.equal(value.phase, "lost");
      assert.equal(value.delivery?.produced, true);
      assert.equal(value.delivery?.ingested, false);
      assert.equal(value.delivery?.identity.childProcessId, value.processId);
      assert.ok(JSON.stringify(f.outcomes).includes("Agent failed"));
      const before = JSON.stringify(value);
      await assert.rejects(
        f.parent.command(`/life-control ${JSON.stringify({ handle: value, action: "cleanup" })}`),
      );
      assert.equal(JSON.stringify(await f.record()), before);
      assert.equal(await readFile(join(value.cwd, "work.txt"), "utf8"), "retained work\n");
      assert.ok((await readFile(value.sessionFile, "utf8")).includes("TEST_PERSISTED_RESULT"));
    } finally {
      await f.close();
    }
  },
);
