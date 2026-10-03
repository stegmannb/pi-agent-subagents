import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { saveAndEmitChanged, saveSettings, type SubagentsSettings } from "./settings.ts";

const oldSettings: SubagentsSettings = { maxConcurrent: 2, defaultJoinMode: "async" };
const newSettings: SubagentsSettings = {
  maxConcurrent: 3,
  defaultMaxTurns: 12,
  defaultTimeoutSeconds: 45,
  graceTurns: 4,
  defaultJoinMode: "group",
  cmuxIntegration: false,
  cmuxLingerMs: 100,
};
function fixture(t: TestContext) {
  const cwd = fs.mkdtempSync(join(tmpdir(), "pasa-settings-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(join(cwd, ".pi"));
  return { cwd, path: join(cwd, ".pi", "subagents.json") };
}
function fault(
  t: TestContext,
  method: "writeFileSync" | "renameSync" | "chmodSync",
  implementation: any,
) {
  t.mock.method(fs, method, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

for (const existing of [true, false]) {
  test(
    `parallel reader sees complete settings during ${existing ? "replacement" : "first save"}`,
    { timeout: 10_000 },
    async (t) => {
      const { cwd, path } = fixture(t);
      if (existing) fs.writeFileSync(path, JSON.stringify(oldSettings));
      const gate = join(cwd, "release");
      execFileSync("mkfifo", [gate]);
      const release = fs.openSync(gate, "r+");
      const child = spawn(
        process.execPath,
        [
          new URL("../tests/fixtures/settings-writer.mjs", import.meta.url).pathname,
          cwd,
          JSON.stringify(newSettings),
          gate,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closed = once(child, "close");
      const lines = createInterface({ input: child.stdout });
      const messages = lines[Symbol.asyncIterator]();
      try {
        for (const phase of ["opened", "partial", "written"]) {
          const message = await messages.next();
          assert.equal(message.done, false, stderr);
          assert.equal(JSON.parse(message.value!).phase, phase);
          if (existing)
            assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), oldSettings, phase);
          else assert.equal(fs.existsSync(path), false, phase);
          fs.writeSync(release, "+");
        }
        assert.equal(JSON.parse((await messages.next()).value!).persisted, true);
        assert.deepEqual(await closed, [0, null], stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), newSettings);
        assert.deepEqual(fs.readdirSync(join(cwd, ".pi")), ["subagents.json"]);
      } finally {
        lines.close();
        child.kill("SIGKILL");
        await closed;
        fs.closeSync(release);
      }
    },
  );
}

test("failed partial write preserves the published settings and removes staging files", (t) => {
  const { cwd, path } = fixture(t);
  fs.writeFileSync(path, JSON.stringify(oldSettings));
  const originalWrite = fs.writeFileSync;
  fault(t, "writeFileSync", (target: string, _data: string, options: any) => {
    originalWrite(target, "{", options);
    throw new Error("injected partial write failure");
  });
  assert.equal(saveSettings(newSettings, cwd), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), oldSettings);
  assert.deepEqual(fs.readdirSync(join(cwd, ".pi")), ["subagents.json"]);
});

test("failed rename retains the previous file and reports session-only persistence", (t) => {
  const { cwd, path } = fixture(t);
  fs.writeFileSync(path, JSON.stringify(oldSettings));
  fault(t, "renameSync", () => {
    throw new Error("injected publication failure");
  });
  const events: unknown[] = [];
  assert.deepEqual(
    saveAndEmitChanged(
      newSettings,
      "Updated settings",
      (event, payload) => events.push({ event, payload }),
      cwd,
    ),
    {
      message: "Updated settings (session only; failed to persist)",
      level: "warning",
    },
  );
  assert.deepEqual(events, [
    { event: "subagents:settings_changed", payload: { settings: newSettings, persisted: false } },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), oldSettings);
  assert.deepEqual(fs.readdirSync(join(cwd, ".pi")), ["subagents.json"]);
});

test("successful publication preserves file permissions and success events", (t) => {
  const { cwd, path } = fixture(t);
  fs.writeFileSync(path, JSON.stringify(oldSettings), { mode: 0o600 });
  const events: unknown[] = [];
  assert.deepEqual(
    saveAndEmitChanged(
      newSettings,
      "Updated settings",
      (event, payload) => events.push({ event, payload }),
      cwd,
    ),
    { message: "Updated settings", level: "info" },
  );
  assert.deepEqual(events, [
    { event: "subagents:settings_changed", payload: { settings: newSettings, persisted: true } },
  ]);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), newSettings);
});

test("replacement preserves existing mode despite restrictive umask", (t) => {
  const { cwd, path } = fixture(t);
  fs.writeFileSync(path, JSON.stringify(oldSettings));
  fs.chmodSync(path, 0o644);
  const previousMask = process.umask(0o077);
  try {
    assert.equal(saveSettings(newSettings, cwd), true);
    assert.equal(fs.statSync(path).mode & 0o777, 0o644);
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), newSettings);
  } finally {
    process.umask(previousMask);
  }
});

test("first save retains restrictive umask for new settings", (t) => {
  const { cwd, path } = fixture(t);
  const previousMask = process.umask(0o077);
  try {
    assert.equal(saveSettings(newSettings, cwd), true);
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  } finally {
    process.umask(previousMask);
  }
});

test("failed mode restoration retains old settings and removes staging file", (t) => {
  const { cwd, path } = fixture(t);
  fs.writeFileSync(path, JSON.stringify(oldSettings));
  fault(t, "chmodSync", () => {
    throw new Error("injected mode restoration failure");
  });
  assert.equal(saveSettings(newSettings, cwd), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), oldSettings);
  assert.deepEqual(fs.readdirSync(join(cwd, ".pi")), ["subagents.json"]);
});
