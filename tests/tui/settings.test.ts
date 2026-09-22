import assert from "node:assert/strict";
import { test } from "node:test";
import { withPi, type PiFixture } from "./harness.ts";

async function settings(app: PiFixture) {
  await app.openAgents();
  await app.choose("Settings");
  await app.expect("Max concurrency");
}
async function setNumber(app: PiFixture, label: string, value: string) {
  await settings(app);
  await app.choose(label);
  await app.input(value);
}

test("all editable numeric settings persist and reload", { timeout: 60_000 }, async (t) => {
  await withPi(t, {}, async (app) => {
    for (const [label, value, key] of [
      ["Max concurrency", "3", "maxConcurrent"],
      ["Default max turns", "12", "defaultMaxTurns"],
      ["Default timeout", "45", "defaultTimeoutSeconds"],
      ["Grace turns", "4", "graceTurns"],
    ] as const) {
      await setNumber(app, label, value);
      await app.waitFor(() => app.readSettings()?.[key] === Number(value), `${key} persisted`);
    }
    await app.restart();
    await settings(app);
    for (const current of [
      "Max concurrency (current: 3)",
      "Default max turns (current: 12)",
      "Default timeout (current: 45s)",
      "Grace turns (current: 4)",
    ])
      await app.expect(current);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(app.readSettings()).filter(([key]) =>
          ["maxConcurrent", "defaultMaxTurns", "defaultTimeoutSeconds", "graceTurns"].includes(key),
        ),
      ),
      {
        maxConcurrent: 3,
        defaultMaxTurns: 12,
        defaultTimeoutSeconds: 45,
        graceTurns: 4,
      },
    );
  });
});

test("zero restores unlimited turns and timeout", { timeout: 60_000 }, async (t) => {
  await withPi(t, { settings: { defaultMaxTurns: 8, defaultTimeoutSeconds: 22 } }, async (app) => {
    await setNumber(app, "Default max turns", "0");
    await setNumber(app, "Default timeout", "0");
    await settings(app);
    await app.expect("Default max turns (current: unlimited)");
    await app.expect("Default timeout (current: unlimited)");
    assert.equal(app.readSettings().defaultMaxTurns, 0);
    assert.equal(app.readSettings().defaultTimeoutSeconds, 0);
    await app.restart();
    await settings(app);
    await app.expect("Default max turns (current: unlimited)");
    await app.expect("Default timeout (current: unlimited)");
  });
});

for (const mode of ["smart", "async", "group"] as const) {
  test(`join mode ${mode} persists across restart`, { timeout: 60_000 }, async (t) => {
    await withPi(t, {}, async (app) => {
      await settings(app);
      await app.choose("Join mode");
      await app.choose(`${mode} —`);
      await app.waitFor(() => app.readSettings().defaultJoinMode === mode, `${mode} persisted`);
      await app.restart();
      await settings(app);
      await app.expect(`Join mode (current: ${mode})`);
    });
  });
}

test("invalid numeric entries leave settings unchanged", { timeout: 60_000 }, async (t) => {
  await withPi(
    t,
    {
      settings: { maxConcurrent: 5, defaultMaxTurns: 9, defaultTimeoutSeconds: 60, graceTurns: 3 },
    },
    async (app) => {
      for (const [label, value, key, original] of [
        ["Max concurrency", "0", "maxConcurrent", 5],
        ["Default max turns", "-2", "defaultMaxTurns", 9],
        ["Default timeout", "-1", "defaultTimeoutSeconds", 60],
        ["Grace turns", "0", "graceTurns", 3],
      ] as const) {
        await setNumber(app, label, value);
        await app.expect("Must be");
        assert.equal(app.readSettings()[key], original);
      }
    },
  );
});

test(
  "cancel settings input and join mode leaves persisted values unchanged",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, { settings: { maxConcurrent: 6, defaultJoinMode: "group" } }, async (app) => {
      await settings(app);
      await app.choose("Max concurrency");
      await app.escape();
      await settings(app);
      await app.choose("Join mode");
      await app.escape();
      assert.equal(app.readSettings().maxConcurrent, 6);
      assert.equal(app.readSettings().defaultJoinMode, "group");
    });
  },
);

test(
  "unavailable cmux integration reports why it cannot be enabled",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      await settings(app);
      await app.expect("cmux integration (unavailable");
      await app.choose("cmux integration");
      await app.expect("cmux is not available");
      assert.equal(app.readSettings().cmuxIntegration ?? false, false);
    });
  },
);
