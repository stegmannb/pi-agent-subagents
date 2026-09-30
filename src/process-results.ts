import { createHash } from "node:crypto";
import { isRecord } from "./messaging-protocol.ts";

/** Only the local result collector's deadline produces this failure. */
export class ResultDeliveryTimeoutError extends Error {
  constructor() {
    super("RESULT_DELIVERY_TIMEOUT");
    this.name = "ResultDeliveryTimeoutError";
  }
}

export interface ResultIdentity {
  resultId: string;
  taskId: string;
  childAgentId: string;
  childSessionId: string;
  childProcessId: string;
  parentSessionId: string;
}
export interface AgentResult extends ResultIdentity {
  goal: string;
  basis: string;
  findings: string;
  evidence: string[];
  blockers: string[];
}
export interface ResultDelivery {
  identity: ResultIdentity;
  produced: boolean;
  accepted: boolean;
  received: boolean;
  ingested: boolean;
  error?: "PARENT_SESSION_WRITE_FAILED";
}
/** One supported host lifetime; the session file is the persistent evidence, not a replay service. */
export class ResultLedger {
  private readonly entries = new Map<
    string,
    { status: ResultDelivery; result?: AgentResult; hash?: string }
  >();
  private readonly save: (result: AgentResult) => void;
  private readonly changed: () => void;
  constructor(save: (result: AgentResult) => void, changed: () => void = () => {}) {
    this.save = save;
    this.changed = changed;
  }
  expect(identity: ResultIdentity): void {
    if (this.entries.has(identity.resultId) || this.entries.size >= 128)
      throw new Error("RESULT_CAPACITY_OR_DUPLICATE");
    this.entries.set(identity.resultId, {
      status: { identity, produced: false, accepted: false, received: false, ingested: false },
    });
  }
  receive(from: string, input: unknown): ResultDelivery {
    if (!isRecord(input) || typeof input.resultId !== "string") throw new Error("INVALID_RESULT");
    const entry = this.entries.get(input.resultId);
    if (
      !entry ||
      from !== entry.status.identity.childAgentId ||
      Object.entries(entry.status.identity).some(([key, value]) => input[key] !== value) ||
      [input.goal, input.basis, input.findings].some((value) => typeof value !== "string") ||
      !Array.isArray(input.evidence) ||
      input.evidence.some((v) => typeof v !== "string") ||
      !Array.isArray(input.blockers) ||
      input.blockers.some((v) => typeof v !== "string")
    )
      throw new Error("STALE_OR_INVALID_RESULT");
    const result = input as unknown as AgentResult;
    const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    if (entry.hash && entry.hash !== hash) throw new Error("CONFLICTING_RESULT");
    entry.result = structuredClone(result);
    entry.hash = hash;
    entry.status.produced = true;
    this.ingest(result.resultId);
    return entry.status;
  }
  stage(from: string, resultId: string, stage: "accepted" | "received"): void {
    const entry = this.entries.get(resultId);
    if (!entry?.result || entry.status.identity.childAgentId !== from)
      throw new Error("STALE_OR_INVALID_RESULT");
    entry.status[stage] = true;
    this.changed();
  }
  ingest(id: string): ResultDelivery {
    const entry = this.entries.get(id);
    if (!entry?.result) throw new Error("RESULT_NOT_PRODUCED");
    if (!entry.status.ingested) {
      try {
        this.save(entry.result);
        entry.status.ingested = true;
        delete entry.status.error;
      } catch {
        entry.status.error = "PARENT_SESSION_WRITE_FAILED";
      }
    }
    this.changed();
    return entry.status;
  }
  get(id: string): { status: ResultDelivery; result?: AgentResult } | undefined {
    return this.entries.get(id);
  }
}
