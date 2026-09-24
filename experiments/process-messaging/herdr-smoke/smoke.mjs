import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TuiTest } from "@microsoft/tui-test";

const directory = dirname(fileURLToPath(import.meta.url));
// macOS TMPDIR is too long for Herdr's nested Unix socket path (sun_path).
const root = realpathSync(mkdtempSync("/tmp/pasa-"));
const session = `pasa-test-${randomUUID().slice(0, 12)}`;
const config = join(root, "herdr", "config.toml");
mkdirSync(dirname(config), { mode: 0o700 });
writeFileSync(
  config,
  `onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\nnew_cwd = "current"\n[update]\nversion_check = false\nmanifest_check = false\n[ui.sound]\nenabled = false\n[session]\nresume_agents_on_restore = false\n`,
  { mode: 0o600 },
);
const env = {
  PATH: process.env.PATH,
  TERM: "xterm-256color",
  SHELL: "/bin/sh",
  PS1: "PASA_SHELL> ",
  HERDR_CONFIG_PATH: config,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  PI_PROOF_SMOKE_DIR: root,
};
const terminal = TuiTest.ephemeral("pasa", {
  trace: { mode: "on", directory: join(root, "traces") },
  artifacts: { dir: join(root, "failures"), onFailure: "all" },
  timeouts: { text: 15_000 },
});
const report = { success: false, session, root, tuiTest: "0.1.0-beta.5", assertions: [] };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function waitJson(name, timeout = 45_000) {
  const file = join(root, name);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        /* Writer may still be flushing. */
      }
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

try {
  console.log(`Herdr smoke evidence: ${root}`);
  // env -i prevents inherited API credentials, shell hooks and Herdr context.
  await terminal.run(
    "/usr/bin/env",
    ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "herdr", "--session", session],
    { cwd: root, cols: 180, rows: 50, waitReady: false },
  );
  await terminal.getByText("PASA_SHELL>").expect();
  report.assertions.push("isolated Herdr TUI started");
  await terminal.submit(
    `${quote(process.execPath)} ${quote(resolve(directory, "../run.mjs"))} --herdr > ${quote(join(root, "controller.log"))} 2>&1; printf '\\nPASA_CONTROLLER_EXIT_%s\\n' "$?"`,
  );
  const ready = await waitJson("ready.json");
  report.proofRoot = ready.root;
  report.herdrContext = ready.report.herdrContext;
  const panes = report.herdrContext.panes.result.panes;
  assert.equal(panes.length, 2);
  assert.equal(panes.find((pane) => pane.focused)?.pane_id, report.herdrContext.callerPane);
  assert.equal(panes.find((pane) => pane.pane_id === ready.pane)?.focused, false);
  report.assertions.push("sibling pane created without stealing focus");
  assert.equal(
    ready.report.herdrFocusedForInput.result.panes.find((pane) => pane.focused)?.pane_id,
    ready.pane,
  );
  await terminal.getByText("deterministic").last().expect();
  await terminal.screenshot(join(root, "pi-ready.svg"));
  writeFileSync(join(root, "pi-ready.txt"), await terminal.text());
  await terminal.submit("PASA_KEYBOARD_TEST");
  await terminal.getByText("Keyboard input observed.").expect();
  report.assertions.push("keyboard input reached interactive Pi in sibling pane");
  await terminal.screenshot(join(root, "keyboard.svg"));
  writeFileSync(join(root, "ready.continue"), "continue\n");
  await waitJson("completed.json");
  await terminal.getByText("Proof turn complete.").expect();
  await terminal.screenshot(join(root, "completed.svg"));
  writeFileSync(join(root, "completed.continue"), "continue\n");
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(ready.root, "report.json"))) {
    assert.ok(Date.now() < deadline, "proof report deadline");
    await delay(100);
  }
  const proof = JSON.parse(readFileSync(join(ready.root, "report.json"), "utf8"));
  assert.equal(proof.success, true, proof.error);
  assert.equal(proof.mode, "rpc+herdr-tui");
  report.assertions.push(...proof.assertions);
  await terminal.getByText("PASA_CONTROLLER_EXIT_0").expect();
  report.success = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  try {
    writeFileSync(join(root, "failure.txt"), await terminal.text());
    await terminal.screenshot(join(root, "failure.svg"));
  } catch {
    /* Terminal startup itself may have failed. */
  }
} finally {
  // Stop only the unique session owned by this run, including its pane processes.
  // Closing tui-test alone would leave Herdr's persistent server running.
  try {
    report.cleanup = JSON.parse(
      execFileSync("herdr", ["session", "stop", session, "--json"], {
        env,
        encoding: "utf8",
        timeout: 15_000,
      }),
    );
    assert.equal(report.cleanup.stopped, true);
    assert.equal(report.cleanup.session.running, false);
    assert.equal(report.cleanup.session.name, session);
    report.assertions.push("owned named Herdr session stopped");
  } catch (error) {
    report.cleanupError = error.message;
    report.success = false;
    process.exitCode = 1;
  }
  await terminal.closeQuiet();
  writeFileSync(join(root, "smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`${report.success ? "PASS" : "FAIL"}: ${join(root, "smoke-report.json")}`);
  if (report.error) console.error(report.error);
}
