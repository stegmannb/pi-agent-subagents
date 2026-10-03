import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProcessRpc } from "../../../src/process-rpc.ts";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { osProcessIdentity } from "../../../src/process-os-identity.ts";

// Inject exactly one close failure after actual parent ingestion. No result/RPC behavior is mocked.
const failed = new Set();
const close = ProcessRpc.prototype.close;
const append = SessionManager.prototype.appendCustomEntry;
if (process.env.PASA_LIFE_SCENARIO === "loss")
  SessionManager.prototype.appendCustomEntry = function (type, data) {
    if (type === "pasa:result") {
      const run = JSON.parse(
        readFileSync(join(process.env.PASA_LIFE_REGISTRY, `${data.childProcessId}.json`), "utf8"),
      );
      if (
        data.parentSessionId !== this.getSessionId() ||
        run.parentSessionId !== data.parentSessionId ||
        run.processId !== data.childProcessId ||
        run.pid === process.pid ||
        run.ownership !== "managed" ||
        osProcessIdentity(run.pid) !== run.osIdentity
      )
        throw new Error("TEST_TARGET_IDENTITY_UNPROVEN");
      process.kill(run.pid, "SIGKILL");
      throw new Error("TEST_PROCESS_LOSS_BEFORE_INGESTION");
    }
    return append.call(this, type, data);
  };
ProcessRpc.prototype.close = async function () {
  const file = join(process.env.PASA_LIFE_REGISTRY, `${this.processId}.json`);
  const run = JSON.parse(readFileSync(file, "utf8"));
  if (
    process.env.PASA_LIFE_SCENARIO === "cleanup" &&
    run.phase === "cleanup-pending" &&
    run.delivery.ingested &&
    !failed.has(this.processId)
  ) {
    failed.add(this.processId);
    throw new Error("TEST_CLEANUP_FAILURE");
  }
  return close.call(this);
};
