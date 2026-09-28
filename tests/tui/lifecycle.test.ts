import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withPi, type PiFixture } from "./harness.ts";

type LifecycleEvent = {
  event: string;
  data?: {
    id?: string;
    status?: string;
    result?: string;
    error?: string;
    message?: string;
  };
};

function events(app: PiFixture): LifecycleEvent[] {
  return app.readEvents() as LifecycleEvent[];
}

async function event(
  app: PiFixture,
  name: string,
  predicate: (item: LifecycleEvent) => boolean = () => true,
  timeout = 10_000,
): Promise<LifecycleEvent> {
  await app.waitFor(
    () => events(app).some((item) => item.event === name && predicate(item)),
    `${name} event`,
    timeout,
  );
  const found = events(app).find((item) => item.event === name && predicate(item));
  assert.ok(found, `${name} event must exist`);
  return found;
}

async function prompt(app: PiFixture, text: string): Promise<void> {
  await app.editorReady();
  await app.terminal.submit(text);
}

function release(app: PiFixture, gate: string): void {
  writeFileSync(join(app.controlDir, `release-${gate}`), "release\n");
}

test(
  "foreground Agent completes and displays the real child result",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await prompt(app, "TUI:agent:CHILD:complete");
      const started = await event(app, "started");
      assert.ok(started.data?.id);
      await app.expect("Scripted child completed");
      await prompt(app, `TUI:get:${started.data.id}`);
      await app.expect("Status: completed");
      await app.expect("Scripted child completed");
      await app.openAgents();
      await app.choose("Running agents (");
      await app.expect("completed");
    });
  },
);

test(
  "background Agent remains visible as running, then completes after its gate opens",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await prompt(app, "TUI:background:CHILD:wait:background");
      const created = await event(app, "created");
      const id = created.data?.id;
      assert.ok(id);
      await app.waitFor(
        () => app.readEvents("events.ndjson").some((entry) => entry.event === "waiting"),
        "child waiting",
      );
      await app.openAgents();
      await app.choose("Running agents (");
      await app.expect("running");
      await app.escape();
      await app.escape();
      await prompt(app, `TUI:get:${id}`);
      await app.expect("Agent is still running");
      release(app, "background");
      const completed = await event(app, "completed", (entry) => entry.data?.id === id);
      assert.equal(completed.data?.status, "completed");
      assert.match(completed.data?.result ?? "", /Child released from background/);
      await prompt(app, `TUI:get:${id}`);
      await app.expect("Child released from background");
    });
  },
);

test("child provider failure is reported with an error status", { timeout: 60_000 }, async (t) => {
  await withPi(t, {}, async (app) => {
    await prompt(app, "TUI:agent:CHILD:error");
    const started = await event(app, "started");
    assert.ok(started.data?.id);
    await app.expect("Agent failed");
    await prompt(app, `TUI:get:${started.data.id}`);
    await app.expect("Status: error");
    await app.expect("Scripted child failure");
  });
});

test(
  "background provider failure emits the real failed lifecycle event",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await prompt(app, "TUI:background:CHILD:error");
      const created = await event(app, "created");
      const failed = await event(app, "failed", (entry) => entry.data?.id === created.data?.id);
      assert.equal(failed.data?.status, "error");
      assert.match(failed.data?.error ?? "", /Scripted child failure/);
      await prompt(app, `TUI:get:${created.data?.id}`);
      await app.expect("Scripted child failure");
    });
  },
);

test(
  "get_subagent_result reports an unknown agent ID without creating an agent",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await prompt(app, "TUI:get:missing-id");
      await app.expect('Agent not found: "missing-id"');
      assert.equal(
        events(app).some((entry) => entry.event === "started"),
        false,
      );
    });
  },
);

test(
  "steering reaches a running child and rejects a completed child",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await prompt(app, "TUI:background:CHILD:wait:steering");
      const created = await event(app, "created");
      const id = created.data?.id;
      assert.ok(id);
      await app.waitFor(
        () => app.readEvents("events.ndjson").some((entry) => entry.event === "waiting"),
        "child waiting",
      );
      await prompt(app, `TUI:steer:${id}:change direction`);
      const steered = await event(app, "steered", (entry) => entry.data?.id === id);
      assert.equal(steered.data?.message, "change direction");
      release(app, "steering");
      await app.waitFor(
        () =>
          app
            .readEvents("events.ndjson")
            .some((entry) => entry.event === "request" && entry.prompt === "change direction"),
        "steering reaches child provider",
      );
      const completed = await event(app, "completed", (entry) => entry.data?.id === id);
      assert.match(completed.data?.result ?? "", /Scripted response: change direction/);
      const priorSteers = events(app).filter((entry) => entry.event === "steered").length;
      await prompt(app, `TUI:steer:${id}:too late`);
      await app.expect("is not running");
      assert.equal(events(app).filter((entry) => entry.event === "steered").length, priorSteers);
    });
  },
);

test(
  "Escape cancels a foreground child that is waiting on a gate",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await prompt(app, "TUI:agent:CHILD:wait:cancel");
      const started = await event(app, "started");
      assert.ok(started.data?.id);
      await app.waitFor(
        () => app.readEvents("events.ndjson").some((entry) => entry.event === "waiting"),
        "child waiting",
      );
      await app.escape();
      await prompt(app, `TUI:get:${started.data.id}`);
      await app.expect("Status: stopped");
      assert.equal(
        app.readEvents("events.ndjson").some((entry) => entry.event === "released"),
        false,
      );
    });
  },
);

test("Agent timeout aborts a child independently of its gate", { timeout: 60_000 }, async (t) => {
  await withPi(t, {}, async (app) => {
    await prompt(app, "TUI:timeout-background:1:CHILD:wait:timeout");
    await app.waitFor(
      () => app.readEvents("events.ndjson").some((entry) => entry.event === "waiting"),
      "child waiting",
    );
    const failed = await event(app, "failed", () => true, 10_000);
    assert.match(failed.data?.status ?? "", /aborted|stopped/);
    await app.expect("aborted (timeout)");
  });
});

test(
  "two background agents have distinct IDs and independent completion",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await prompt(app, "TUI:background:CHILD:wait:first");
      await event(app, "created");
      await prompt(app, "TUI:background:CHILD:wait:second");
      await app.waitFor(
        () => events(app).filter((entry) => entry.event === "created").length === 2,
        "two created agents",
      );
      const [first, second] = events(app).filter((entry) => entry.event === "created");
      assert.ok(first.data?.id);
      assert.ok(second.data?.id);
      assert.notEqual(first.data.id, second.data.id);
      await app.waitFor(
        () =>
          app.readEvents("events.ndjson").filter((entry) => entry.event === "waiting").length === 2,
        "two running children",
      );
      release(app, "first");
      await event(app, "completed", (entry) => entry.data?.id === first.data?.id);
      assert.equal(
        events(app).some(
          (entry) => entry.event === "completed" && entry.data?.id === second.data?.id,
        ),
        false,
      );
      release(app, "second");
      await event(app, "completed", (entry) => entry.data?.id === second.data?.id);
    });
  },
);

test(
  "a queued background agent starts only after the running agent releases its slot",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, { settings: { maxConcurrent: 1 } }, async (app) => {
      await prompt(app, "TUI:background:CHILD:wait:queue-first");
      const first = await event(app, "created");
      assert.ok(first.data?.id);
      await app.waitFor(
        () =>
          app
            .readEvents("events.ndjson")
            .some((entry) => entry.event === "waiting" && entry.gate === "queue-first"),
        "first child waiting",
      );

      await prompt(app, "TUI:background:CHILD:wait:queue-second");
      await app.waitFor(
        () => events(app).filter((entry) => entry.event === "created").length === 2,
        "second agent created",
      );
      const second = events(app).filter((entry) => entry.event === "created")[1];
      assert.ok(second.data?.id);
      assert.notEqual(first.data.id, second.data.id);
      assert.equal(events(app).filter((entry) => entry.event === "started").length, 1);
      assert.equal(
        app
          .readEvents("events.ndjson")
          .some((entry) => entry.event === "request" && entry.prompt === "CHILD:wait:queue-second"),
        false,
      );
      await app.openAgents();
      await app.choose("Running agents (");
      await app.expect("queued");
      await app.escape();
      await app.escape();

      release(app, "queue-first");
      await event(app, "completed", (entry) => entry.data?.id === first.data?.id);
      await event(app, "started", (entry) => entry.data?.id === second.data?.id);
      await app.waitFor(
        () =>
          app
            .readEvents("events.ndjson")
            .some((entry) => entry.event === "waiting" && entry.gate === "queue-second"),
        "queued child starts after slot opens",
      );
      release(app, "queue-second");
      const completed = await event(
        app,
        "completed",
        (entry) => entry.data?.id === second.data?.id,
      );
      assert.match(completed.data?.result ?? "", /Child released from queue-second/);
    });
  },
);

test(
  "long child output survives while /agents remains navigable in a small terminal",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, { cols: 64, rows: 20 }, async (app) => {
      await prompt(app, "TUI:agent:CHILD:long:5000");
      const started = await event(app, "started");
      assert.ok(started.data?.id);
      await prompt(app, `TUI:get:${started.data.id}`);
      await app.expect("end marker");
      // The marker may still be visible from the previous response.
      await app.editorReady();
      await app.openAgents();
      await app.expect("Create new agent");
      await app.choose("Running agents (");
      await app.expect("completed");
      await app.escape();
      await app.escape();
      await app.editorReady();
    });
  },
);
