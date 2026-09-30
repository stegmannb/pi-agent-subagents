import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultLedger, type AgentResult } from "./process-results.ts";

const result: AgentResult = {
  resultId: "run:result",
  taskId: "task",
  childAgentId: "child",
  childSessionId: "child-session",
  childProcessId: "run",
  parentSessionId: "parent-session",
  goal: "review",
  basis: "fixed commit",
  findings: "one finding",
  evidence: ["test evidence"],
  blockers: [],
};
test("result production, transport stages and persisted ingestion remain distinct and duplicate delivery is idempotent", () => {
  const saved: AgentResult[] = [];
  const ledger = new ResultLedger((value) => saved.push(value));
  const {
    goal: _goal,
    basis: _basis,
    findings: _findings,
    evidence: _evidence,
    blockers: _blockers,
    ...identity
  } = result;
  ledger.expect(identity);
  const state = ledger.receive("child", result);
  assert.equal(state.produced, true);
  assert.equal(state.ingested, true);
  assert.equal(state.accepted, false);
  assert.equal(state.received, false);
  ledger.stage("child", result.resultId, "accepted");
  ledger.stage("child", result.resultId, "received");
  assert.equal(state.accepted, true);
  assert.equal(state.received, true);
  ledger.receive("child", result);
  ledger.receive("child", result);
  assert.equal(saved.length, 1);
  assert.throws(
    () => ledger.receive("child", { ...result, findings: "different" }),
    /CONFLICTING_RESULT/,
  );
  assert.throws(() => ledger.receive("sibling", result), /STALE_OR_INVALID_RESULT/);
  assert.throws(
    () => ledger.receive("child", { ...result, parentSessionId: "other-session" }),
    /STALE_OR_INVALID_RESULT/,
  );
  assert.throws(
    () => ledger.receive("child", { ...result, childProcessId: "old-run" }),
    /STALE_OR_INVALID_RESULT/,
  );
});
test("receipt cannot hide a failed parent session write and retry never starts another task", () => {
  let writes = 0;
  const ledger = new ResultLedger(() => {
    writes++;
    throw new Error("disk unavailable");
  });
  const {
    goal: _goal,
    basis: _basis,
    findings: _findings,
    evidence: _evidence,
    blockers: _blockers,
    ...identity
  } = result;
  ledger.expect(identity);
  const state = ledger.receive("child", result);
  ledger.stage("child", result.resultId, "accepted");
  ledger.stage("child", result.resultId, "received");
  assert.equal(state.ingested, false);
  assert.equal(state.error, "PARENT_SESSION_WRITE_FAILED");
  assert.equal(state.received, true);
  ledger.receive("child", result);
  assert.equal(writes, 2);
  assert.deepEqual(ledger.get(result.resultId)?.result, result);
  const newer = { ...identity, resultId: "new:result", childProcessId: "new" };
  ledger.expect(newer);
  ledger.receive("child", result);
  assert.equal(ledger.get(newer.resultId)?.status.produced, false);
});
