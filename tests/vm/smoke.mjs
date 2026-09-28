import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 1000, "test must run as the ordinary guest user");
assert.equal(process.getgid(), 100, "test must run in the ordinary users group");

if (process.argv[2] === "child") {
  assert.notEqual(process.pid, Number(process.argv[3]));
  assert.equal(process.ppid, Number(process.argv[3]));
  const cwd = process.cwd();
  mkdirSync("allowed");
  mkdirSync("denied");
  // Both are writable by this same user before entering Bubblewrap. A later
  // denial must therefore come from the sandbox mount, not Unix ownership.
  writeFileSync("denied/sentinel", "unchanged");
  const script = `
    const fs = require("node:fs");
    const assert = require("node:assert/strict");
    assert.equal(process.getuid(), 1000);
    fs.writeFileSync("allowed/result", "allowed");
    assert.throws(() => fs.writeFileSync("denied/sentinel", "escaped"),
      error => error.code === "EROFS");
    assert.equal(fs.readFileSync("denied/sentinel", "utf8"), "unchanged");
    console.log("bubblewrap: allowed write succeeded; denied write returned EROFS");
  `;
  const sandbox = spawnSync(
    "bwrap",
    [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--bind",
      `${cwd}/allowed`,
      `${cwd}/allowed`,
      "--chdir",
      cwd,
      process.execPath,
      "-e",
      script,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  process.stdout.write(sandbox.stdout ?? "");
  process.stderr.write(sandbox.stderr ?? "");
  assert.ifError(sandbox.error);
  assert.equal(sandbox.signal, null);
  assert.equal(sandbox.status, 0, "Bubblewrap enforcement is mandatory");
  assert.equal(readFileSync("allowed/result", "utf8"), "allowed");
  assert.equal(readFileSync("denied/sentinel", "utf8"), "unchanged");
  console.log(`node-child: pid=${process.pid} parent=${process.ppid} uid=${process.getuid()}`);
} else {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "child", String(process.pid)],
    { encoding: "utf8", timeout: 90_000 },
  );
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, "separate Node child must pass the real sandbox checks");
  console.log(`vm-smoke: passed parent=${process.pid} uid=${process.getuid()}`);
}
