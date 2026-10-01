import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import failureFixture from "./result-write-failure.ts";

const { root, marker, release } = workerData;
const gate = new Int32Array(release);
const manager = SessionManager.create(root, root);
manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
process.env.PASA_RESULT_WRITE_FAILURE = marker;
let sessionStart;
failureFixture({ on: (_event, handler) => (sessionStart = handler) });
await sessionStart(undefined, { sessionManager: manager });

const write = fs.writeFileSync;
let interrupted = false;
fs.writeFileSync = (path, data, options) => {
  if (interrupted || (path !== marker && path !== `${marker}.tmp`))
    return write(path, data, options);
  interrupted = true;
  const split = Math.floor(data.length / 2);
  write(path, data.slice(0, split), options);
  parentPort.postMessage({ type: "partial" });
  Atomics.wait(gate, 0, 0);
  fs.appendFileSync(path, data.slice(split));
};
syncBuiltinESMExports();
try {
  const first = { resultId: "first:result", parentSessionId: manager.getSessionId() };
  const second = { ...first, resultId: "second:result" };
  assert.throws(() => manager.appendCustomEntry("pasa:result", first), { code: "EACCES" });
  const original = fs.readFileSync(marker, "utf8");
  assert.throws(() => manager.appendCustomEntry("pasa:result", second), { code: "EACCES" });
  assert.equal(fs.readFileSync(marker, "utf8"), original);
  const memory = manager.getEntries().filter((e) => e.type === "custom");
  assert.equal(memory.length, 2, "both real failed appends still mutate SDK memory");
  const disk = fs.readFileSync(manager.getSessionFile(), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(disk.filter((e) => e.type === "custom").length, 0);
  parentPort.postMessage({ type: "done", first, sessionFile: manager.getSessionFile() });
} finally {
  fs.writeFileSync = write;
  syncBuiltinESMExports();
}
