import { qualificationTiming, type QualificationPreset } from "./process-qualification.ts";
/** Trusted in-process protection snapshots; not a model tool or a completeness oracle. */
import { randomUUID } from "node:crypto";
import type { EventBus } from "@mariozechner/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import {
  ProcessProfileError,
  type FileReference,
  type EnvironmentReference,
} from "./process-profile.ts";

export const PROTECTION_SNAPSHOT_EVENT = "pasa:protection:snapshot:v1";
export type ProtectionId = "pi-agent-guard" | "pi-agent-sandbox";
export interface ProtectionSnapshotRequest {
  version: 1;
  requestId: string;
  protectionId: ProtectionId;
  expectedSessionId: string;
  targetCwd: string;
  respond: (response: ProtectionSnapshotResponse) => void;
}
export interface ReadyProtectionSnapshot {
  version: 1;
  requestId: string;
  protectionId: ProtectionId;
  status: "ready";
  binding: { cwd: string; sessionId: string; generation: number };
  enabled: true;
  initialized: true;
  stateDigest: string;
  codeFiles: FileReference[];
  configurationFiles: FileReference[];
  environment: EnvironmentReference[];
  replay: { kind: "file-backed"; verifiedCwd: string; stateDigest: string };
}
export type ProtectionSnapshotResponse =
  | ReadyProtectionSnapshot
  | {
      version: 1;
      requestId: string;
      protectionId: ProtectionId;
      status: "unsupported";
      reason:
        | "NOT_INITIALIZED"
        | "DISABLED"
        | "SESSION_MISMATCH"
        | "RUNTIME_MUTATION"
        | "CONFIG_DRIFT"
        | "CWD_UNREPRODUCIBLE"
        | "INITIALIZATION_FAILED"
        | "UNBACKED_CONFIGURATION";
    };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function files(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 4096 &&
    value.every(
      (ref) =>
        record(ref) && typeof ref.path === "string" && isAbsolute(ref.path) && digest(ref.sha256),
    )
  );
}
function parseReady(value: unknown, request: ProtectionSnapshotRequest): ReadyProtectionSnapshot {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.requestId !== request.requestId ||
    value.protectionId !== request.protectionId
  )
    throw new ProcessProfileError("PROTECTION_RESPONSE_MISMATCH");
  if (value.status === "unsupported") throw new ProcessProfileError("NON_REPRODUCIBLE_PROTECTION");
  if (
    value.status !== "ready" ||
    value.enabled !== true ||
    value.initialized !== true ||
    !record(value.binding) ||
    typeof value.binding.cwd !== "string" ||
    !isAbsolute(value.binding.cwd) ||
    value.binding.sessionId !== request.expectedSessionId ||
    !Number.isSafeInteger(value.binding.generation) ||
    (value.binding.generation as number) < 0 ||
    !digest(value.stateDigest) ||
    !files(value.codeFiles) ||
    (value.codeFiles as unknown[]).length === 0 ||
    !files(value.configurationFiles) ||
    !Array.isArray(value.environment) ||
    value.environment.length > 256 ||
    !value.environment.every(
      (ref) =>
        record(ref) &&
        typeof ref.name === "string" &&
        /^[A-Z_][A-Z0-9_]*$/.test(ref.name) &&
        digest(ref.sha256),
    ) ||
    !record(value.replay) ||
    value.replay.kind !== "file-backed" ||
    value.replay.verifiedCwd !== request.targetCwd ||
    !digest(value.replay.stateDigest)
  )
    throw new ProcessProfileError("PROTECTION_RESPONSE_INVALID");
  // Copy data now: a producer cannot silently mutate an accepted response later.
  const copyFiles = (refs: unknown) =>
    (refs as FileReference[]).map((ref) => ({ path: ref.path, sha256: ref.sha256 }));
  return {
    version: 1,
    requestId: request.requestId,
    protectionId: request.protectionId,
    status: "ready",
    binding: {
      cwd: value.binding.cwd,
      sessionId: request.expectedSessionId,
      generation: value.binding.generation as number,
    },
    enabled: true,
    initialized: true,
    stateDigest: value.stateDigest,
    codeFiles: copyFiles(value.codeFiles),
    configurationFiles: copyFiles(value.configurationFiles),
    environment: (value.environment as EnvironmentReference[]).map((ref) => ({
      name: ref.name,
      sha256: ref.sha256,
    })),
    replay: {
      kind: "file-backed",
      verifiedCwd: request.targetCwd,
      stateDigest: value.replay.stateDigest,
    },
  };
}

export interface ProtectionSnapshotLease {
  /** Throws after duplicate responses; recheck immediately before using the snapshot. */
  read(): ReadyProtectionSnapshot;
}
/** A missing producer is an error. Absence never means protection is unnecessary. */
export async function requestProtectionSnapshot(
  bus: EventBus,
  input: { protectionId: ProtectionId; expectedSessionId: string; targetCwd: string },
  timeoutMs = 5000,
): Promise<ProtectionSnapshotLease> {
  return captureProtectionSnapshot(bus, input, timeoutMs, 5000);
}

/** Explicit trusted qualification call. Generic callers retain their five-second hard cap. */
export async function requestQualifiedProtectionSnapshot(
  bus: EventBus,
  input: { protectionId: ProtectionId; expectedSessionId: string; targetCwd: string },
  preset: QualificationPreset | undefined,
): Promise<ProtectionSnapshotLease> {
  const limit = qualificationTiming(preset)?.snapshotMs ?? 5000;
  return captureProtectionSnapshot(bus, input, limit, limit);
}

async function captureProtectionSnapshot(
  bus: EventBus,
  input: { protectionId: ProtectionId; expectedSessionId: string; targetCwd: string },
  timeoutMs: number,
  maximumMs: number,
): Promise<ProtectionSnapshotLease> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > maximumMs ||
    !input.expectedSessionId ||
    !isAbsolute(input.targetCwd)
  )
    throw new ProcessProfileError("INVALID_PROTECTION_REQUEST");
  let responded = false;
  let invalid = false;
  let snapshot: ReadyProtectionSnapshot | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = performance.now() + timeoutMs;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        invalid = true;
        reject(new ProcessProfileError("PROTECTION_RESPONSE_TIMEOUT"));
      }, timeoutMs);
      const request: ProtectionSnapshotRequest = {
        version: 1,
        requestId: randomUUID(),
        ...input,
        respond: (response) => {
          // A synchronous producer may block the event loop past the timer deadline.
          if (performance.now() >= deadline) {
            invalid = true;
            reject(new ProcessProfileError("PROTECTION_RESPONSE_TIMEOUT"));
            return;
          }
          if (responded) {
            invalid = true;
            reject(new ProcessProfileError("PROTECTION_RESPONSE_DUPLICATE"));
            return;
          }
          responded = true;
          try {
            snapshot = parseReady(response, request);
            resolve();
          } catch (error) {
            invalid = true;
            reject(error);
          }
        },
      };
      try {
        bus.emit(PROTECTION_SNAPSHOT_EVENT, request);
      } catch {
        invalid = true;
        reject(new ProcessProfileError("PROTECTION_ADAPTER_FAILED"));
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  const lease = {
    read: () => {
      if (invalid || !snapshot) throw new ProcessProfileError("PROTECTION_RESPONSE_INVALIDATED");
      return structuredClone(snapshot);
    },
  };
  lease.read();
  return lease;
}

/** Compare independent child computation with the parent's replay proof. */
export function verifyChildProtection(
  parent: ReadyProtectionSnapshot,
  child: ReadyProtectionSnapshot,
  expected: { cwd: string; sessionId: string },
): void {
  const refs = (values: FileReference[]) =>
    JSON.stringify([...values].sort((a, b) => a.path.localeCompare(b.path)));
  const env = (values: EnvironmentReference[]) =>
    JSON.stringify([...values].sort((a, b) => a.name.localeCompare(b.name)));
  const projectFile = {
    "pi-agent-guard": "settings.json",
    "pi-agent-sandbox": "sandbox.json",
  }[parent.protectionId];
  if (
    parent.status !== "ready" ||
    child.status !== "ready" ||
    parent.version !== 1 ||
    child.version !== 1 ||
    !parent.enabled ||
    !child.enabled ||
    !parent.initialized ||
    !child.initialized ||
    parent.protectionId !== child.protectionId ||
    child.binding.cwd !== expected.cwd ||
    child.binding.sessionId !== expected.sessionId ||
    parent.replay.verifiedCwd !== expected.cwd ||
    child.replay.verifiedCwd !== expected.cwd ||
    parent.replay.stateDigest !== child.stateDigest ||
    child.stateDigest !== child.replay.stateDigest ||
    refs(parent.codeFiles) !== refs(child.codeFiles) ||
    refs(
      parent.configurationFiles.map((ref) => {
        return projectFile && ref.path === join(parent.binding.cwd, ".pi", projectFile)
          ? { ...ref, path: join(expected.cwd, ".pi", projectFile) }
          : ref;
      }),
    ) !== refs(child.configurationFiles) ||
    env(parent.environment) !== env(child.environment)
  )
    throw new ProcessProfileError("CHILD_PROTECTION_MISMATCH");
}
