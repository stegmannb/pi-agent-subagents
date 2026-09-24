import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Broker } from "./broker.mjs";

const herdr = process.argv.includes("--herdr");
const tui = process.argv.includes("--tui");
if ((herdr && tui) || process.argv.slice(2).some((arg) => !["--herdr", "--tui"].includes(arg))) {
  throw new Error("Usage: node run.mjs [--herdr | --tui]");
}
if (tui && process.platform !== "darwin")
  throw new Error("--tui currently uses macOS /usr/bin/script");
if (tui && !process.stdin.isTTY) throw new Error("--tui requires a terminal on stdin");
if (herdr && process.env.HERDR_ENV !== "1") {
  throw new Error(
    "Run --herdr from inside Herdr. No external or default session will be controlled.",
  );
}
const directory = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-proof-")));
const broker = new Broker(join(root, "mail.sock"), randomBytes(24).toString("hex"));
const children = [];
const smokeDirectory = herdr ? process.env.PI_PROOF_SMOKE_DIR : undefined;
let pane;
const report = {
  success: false,
  mode: herdr ? "rpc+herdr-tui" : tui ? "rpc+pty-tui" : "rpc+rpc",
  root,
  fixture: "deterministic model; no network inference; not a guard/sandbox integration test",
};

function launchOptions(peer) {
  const cwd = join(root, peer);
  mkdirSync(cwd, { mode: 0o700 });
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { mode: 0o700 });
  return {
    cwd,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROOF_SOCKET: broker.path,
      PI_PROOF_TOKEN: broker.token,
      PI_PROOF_PEER: peer,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
    args: [
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--tools",
      "proof_work,proof_send",
      "--extension",
      join(directory, "fixture-extension.mjs"),
      "--provider",
      "process-proof",
      "--model",
      "deterministic",
      "--thinking",
      "off",
      "--session-dir",
      join(cwd, "sessions"),
      "--system-prompt",
      "You are a deterministic process communication test.",
    ],
  };
}

function launchProcess(peer, interactive = false) {
  const options = launchOptions(peer);
  // Do not pass API credentials or the parent's Pi configuration to the fixture.
  const child = spawn(
    interactive ? "/usr/bin/script" : "pi",
    interactive ? ["-q", "/dev/null", "pi", ...options.args] : ["--mode", "rpc", ...options.args],
    {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH,
        TERM: interactive ? "xterm-256color" : "dumb",
        ...options.env,
      },
      detached: interactive,
      stdio: [interactive ? "inherit" : "pipe", "pipe", "pipe"],
    },
  );
  const entry = { peer, child, interactive, output: "", error: "" };
  children.push(entry);
  child.stdout.on("data", (chunk) => {
    entry.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    entry.error += chunk.toString();
  });
  child.on("error", (error) => {
    entry.error += error.message;
  });
  return child;
}

function launchPane() {
  const options = launchOptions("b");
  const args = [
    "pane",
    "split",
    "--current",
    "--direction",
    "right",
    "--no-focus",
    "--cwd",
    options.cwd,
  ];
  for (const [key, value] of Object.entries(options.env)) args.push("--env", `${key}=${value}`);
  const result = JSON.parse(execFileSync("herdr", args, { encoding: "utf8", timeout: 15_000 }));
  pane = result.result?.pane?.pane_id;
  if (!pane) throw new Error(`Herdr did not return a pane ID: ${JSON.stringify(result)}`);
  report.pane = pane;
  if (smokeDirectory) {
    report.herdrContext = {
      callerPane: process.env.HERDR_PANE_ID,
      socket: process.env.HERDR_SOCKET_PATH,
      panes: JSON.parse(
        execFileSync("herdr", ["pane", "list", "--workspace", process.env.HERDR_WORKSPACE_ID], {
          encoding: "utf8",
          timeout: 15_000,
        }),
      ),
    };
  }
  // Only the new, returned pane is touched. The user's original pane keeps focus.
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  execFileSync(
    "herdr",
    ["pane", "run", String(pane), ["pi", ...options.args].map(quote).join(" ")],
    { encoding: "utf8", timeout: 15_000 },
  );
}

async function smokeCheckpoint(phase) {
  if (!smokeDirectory) return;
  writeFileSync(join(smokeDirectory, `${phase}.json`), JSON.stringify({ root, pane, report }), {
    mode: 0o600,
  });
  const deadline = Date.now() + 45_000;
  while (!existsSync(join(smokeDirectory, `${phase}.continue`))) {
    if (Date.now() > deadline) throw new Error(`Smoke controller timed out at ${phase}`);
    await delay(100);
  }
}

async function stopChild({ child, interactive }) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise((resolve) => {
    const kill = (signal) => {
      try {
        if (interactive) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The owned process already exited. */
      }
    };
    const timer = setTimeout(() => kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    kill("SIGTERM");
  });
}

try {
  await broker.start();
  const a = launchProcess("a");
  if (herdr) launchPane();
  else launchProcess("b", tui);
  const registeredA = await broker.waitFor(
    (event) => event.type === "registered" && event.peer === "a",
  );
  const registeredB = await broker.waitFor(
    (event) => event.type === "registered" && event.peer === "b",
  );
  assert.notEqual(registeredA.metadata.pid, registeredB.metadata.pid);
  assert.notEqual(registeredA.metadata.sessionId, registeredB.metadata.sessionId);
  assert.equal(registeredA.metadata.cwd, join(root, "a"));
  assert.equal(registeredB.metadata.cwd, join(root, "b"));
  assert.equal(registeredA.metadata.mode, "rpc");
  assert.equal(registeredB.metadata.mode, herdr || tui ? "tui" : "rpc");
  assert.deepEqual(registeredB.metadata.tools.sort(), ["proof_send", "proof_work"]);

  if (smokeDirectory) {
    execFileSync("herdr", ["pane", "focus", "--current", "--direction", "right"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    report.herdrFocusedForInput = JSON.parse(
      execFileSync("herdr", ["pane", "list", "--workspace", process.env.HERDR_WORKSPACE_ID], {
        encoding: "utf8",
        timeout: 15_000,
      }),
    );
  }
  await smokeCheckpoint("ready");
  if (smokeDirectory) {
    await broker.waitFor((event) => event.peer === "b" && event.name === "keyboard-observed");
  }

  broker.command("b", { type: "prompt", text: "PROOF_WORK" });
  const working = await broker.waitFor(
    (event) => event.peer === "b" && event.name === "work-started",
  );
  a.stdin.write(`${JSON.stringify({ id: "ask", type: "prompt", message: "PROOF_ASK" })}\n`);
  const received = await broker.waitFor((event) => event.peer === "b" && event.name === "received");
  assert.equal(received.data.busy, true, "question must arrive during the active tool call");
  const finished = await broker.waitFor(
    (event) => event.peer === "b" && event.name === "work-finished",
  );
  const seenQuestion = await broker.waitFor(
    (event) => event.peer === "b" && event.name === "model-observed",
  );
  const seenReply = await broker.waitFor(
    (event) => event.peer === "a" && event.name === "model-observed",
  );
  assert.ok(
    working.seq < received.seq && received.seq < finished.seq && finished.seq < seenQuestion.seq,
  );
  assert.equal(seenReply.data.envelope.kind, "reply");
  assert.equal(seenReply.data.envelope.replyTo, seenQuestion.data.envelope.id);
  assert.equal(seenReply.data.envelope.text, "42");
  await broker.waitFor(
    (event) => event.peer === "a" && event.name === "agent-settled" && event.seq > seenReply.seq,
  );
  await broker.waitFor(
    (event) => event.peer === "b" && event.name === "agent-settled" && event.seq > seenQuestion.seq,
  );
  assert.equal(
    broker.events.some((event) => event.type === "rejected" || event.name === "failure"),
    false,
  );
  for (const registration of [registeredA, registeredB]) {
    const entries = readFileSync(registration.metadata.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const expected =
      registration.peer === "a" ? seenReply.data.envelope : seenQuestion.data.envelope;
    assert.ok(
      entries.some((entry) => entry.type === "custom_message" && entry.details?.id === expected.id),
      "mail must be persisted in the actual Pi session",
    );
  }
  report.success = true;
  report.assertions = [
    "distinct Pi PIDs and sessions",
    "isolated working directories and tool allowlist",
    "question received while tool is active",
    "steering observed after tool boundary",
    "correlated reply observed in other Pi model context",
    "both agents settled",
    "mail persisted in both Pi sessions",
  ];
  await smokeCheckpoint("completed");
} catch (error) {
  report.success = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  const shutdownStart = broker.events.length;
  for (const peer of broker.peers.keys()) broker.command(peer, { type: "shutdown" });
  if (herdr && broker.peers.has("b")) {
    try {
      await broker.waitFor(
        (event) =>
          event.type === "disconnected" && event.peer === "b" && event.seq >= shutdownStart,
        3000,
      );
      report.paneShutdown = "bridge disconnected after shutdown request; pane retained";
    } catch {
      report.paneShutdown = "unconfirmed; inspect the retained pane";
      report.success = false;
      process.exitCode = 1;
    }
  }
  await Promise.all(children.map(stopChild));
  await broker.close();
  for (const entry of children) {
    writeFileSync(
      join(root, `${entry.peer}.${entry.interactive ? "terminal.log" : "rpc.jsonl"}`),
      entry.output,
      { mode: 0o600 },
    );
    writeFileSync(join(root, `${entry.peer}.stderr.log`), entry.error, { mode: 0o600 });
  }
  report.events = broker.events;
  writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`${report.success ? "PASS" : "FAIL"}: ${join(root, "report.json")}`);
  if (report.error) console.error(report.error);
  if (pane)
    console.log(
      `Owned Herdr pane ${pane} retained. Pi was asked to shut down; inspect/close the pane yourself.`,
    );
}
