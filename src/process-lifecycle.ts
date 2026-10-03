import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProcessObservation } from "./process-contract.ts";
import { osProcessIdentity } from "./process-os-identity.ts";

export type ProcessOwnership = "managed" | "manual" | "external";
export type ProcessPhase =
  | "starting"
  | "running"
  | "question"
  | "result-pending"
  | "cleanup-pending"
  | "cleanup-error"
  | "completed"
  | "stopped"
  | "lost"
  | "uncertain"
  | "detached";
export interface ProcessHandle extends ProcessObservation {
  parentSessionId: string;
  parentAgentId: string;
  ownership: ProcessOwnership;
  revision: number;
  routeParentId: string | null;
}
export interface ProcessRegistration extends ProcessHandle {
  version: 1;
  phase: ProcessPhase;
  parentState: "connected" | "parent_exiting" | "disconnected";
  resultId: string;
  osIdentity?: string;
  delivery?: import("./process-results.ts").ResultDelivery;
  error?: string;
}
export class ProcessIdentityError extends Error {
  readonly code = "PROCESS_IDENTITY_UNPROVEN";
  constructor() {
    super("PROCESS_IDENTITY_UNPROVEN");
  }
}
function atomicallySave(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}
function readPrivate(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 262144 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new ProcessIdentityError();
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
export function registrationFile(directory: string, processId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(processId)) throw new ProcessIdentityError();
  return join(directory, `${processId}.json`);
}
const identityKeys = [
  "taskId",
  "agentId",
  "sessionId",
  "processId",
  "parentAgentId",
  "parentSessionId",
  "sessionFile",
  "cwd",
  "pid",
  "paneId",
  "paneProcessId",
] as const;
/** One broker lifetime. Persistent records are evidence, never automatic recovery instructions. */
export class ProcessRegistry {
  readonly directory: string;
  private mutate<T>(handle: ProcessHandle, operation: () => T): T {
    const lock = registrationFile(this.directory, handle.processId) + ".lock";
    let fd: number;
    try {
      fd = openSync(
        lock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new ProcessIdentityError();
    }
    try {
      return operation();
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new ProcessIdentityError();
  }
  register(
    identity: Omit<ProcessHandle, "ownership" | "revision" | "routeParentId">,
  ): ProcessRegistration {
    registrationFile(this.directory, identity.agentId);
    const file = registrationFile(this.directory, identity.processId);
    // Exclusive reservation prevents a previously retained run from being overwritten.
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    const value: ProcessRegistration = {
      ...identity,
      version: 1,
      ownership: "managed",
      revision: 0,
      routeParentId: identity.parentAgentId,
      phase: "starting",
      parentState: "connected",
      resultId: `${identity.processId}:result`,
    };
    atomicallySave(file, value);
    atomicallySave(join(this.directory, `current-${identity.agentId}.json`), {
      processId: identity.processId,
      sessionId: identity.sessionId,
    });
    return value;
  }
  read(handle: ProcessHandle, exactOwnership = true): ProcessRegistration {
    try {
      registrationFile(this.directory, handle.agentId);
      const value = readPrivate(
        registrationFile(this.directory, handle.processId),
      ) as ProcessRegistration;
      const current = readPrivate(join(this.directory, `current-${handle.agentId}.json`)) as {
        processId: string;
        sessionId: string;
      };
      if (
        value.version !== 1 ||
        ![
          "starting",
          "running",
          "question",
          "result-pending",
          "cleanup-pending",
          "cleanup-error",
          "completed",
          "stopped",
          "lost",
          "uncertain",
          "detached",
        ].includes(value.phase) ||
        !["connected", "parent_exiting", "disconnected"].includes(value.parentState) ||
        value.resultId !== `${handle.processId}:result` ||
        (value.pid !== undefined && (typeof value.osIdentity !== "string" || !value.osIdentity)) ||
        current.processId !== handle.processId ||
        current.sessionId !== handle.sessionId ||
        identityKeys.some((key) => value[key] !== handle[key]) ||
        !["managed", "manual", "external"].includes(value.ownership) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        (exactOwnership &&
          (value.ownership !== handle.ownership ||
            value.revision !== handle.revision ||
            value.routeParentId !== handle.routeParentId))
      )
        throw new ProcessIdentityError();
      if (
        value.routeParentId !== (value.ownership === "managed" ? value.parentAgentId : null) ||
        realpathSync(value.cwd) !== value.cwd
      )
        throw new ProcessIdentityError();
      const fd = openSync(value.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new ProcessIdentityError();
        const buffer = Buffer.alloc(8192);
        const count = readSync(fd, buffer, 0, buffer.length, 0);
        const newline = buffer.subarray(0, count).indexOf(10);
        if (newline < 0) throw new ProcessIdentityError();
        const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (header.type !== "session" || header.id !== value.sessionId || header.cwd !== value.cwd)
          throw new ProcessIdentityError();
      } finally {
        closeSync(fd);
      }
      return value;
    } catch {
      throw new ProcessIdentityError();
    }
  }
  update(
    handle: ProcessHandle,
    change: Partial<Pick<ProcessRegistration, "phase" | "delivery" | "error" | "parentState">>,
  ): ProcessRegistration {
    return this.mutate(handle, () => {
      const current = this.read(handle);
      const value = { ...current, ...change };
      atomicallySave(registrationFile(this.directory, handle.processId), value);
      return value;
    });
  }
  bindPid(handle: ProcessHandle, pid: number): ProcessRegistration {
    return this.mutate(handle, () => {
      const current = this.read(handle);
      if (current.pid !== undefined || !Number.isSafeInteger(pid) || pid < 1)
        throw new ProcessIdentityError();
      const osIdentity = osProcessIdentity(pid);
      if (!osIdentity) throw new ProcessIdentityError();
      const value = { ...current, pid, osIdentity };
      atomicallySave(registrationFile(this.directory, handle.processId), value);
      return value;
    });
  }
  takeover(handle: ProcessHandle, ownership: "manual" | "external"): ProcessRegistration {
    return this.mutate(handle, () => {
      const current = this.read(handle);
      if (
        current.ownership !== "managed" ||
        !current.pid ||
        current.osIdentity !== osProcessIdentity(current.pid) ||
        !["manual", "external"].includes(ownership)
      )
        throw new ProcessIdentityError();
      const value: ProcessRegistration = {
        ...current,
        ownership,
        routeParentId: null,
        revision: current.revision + 1,
        phase: "detached",
      };
      // Ownership and routing share one atomic file replacement, before the broker replies.
      atomicallySave(registrationFile(this.directory, handle.processId), value);
      return value;
    });
  }
}
