import type { InspectionTrace } from "./process-inspection-diagnostic.ts";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  ProcessProfileError,
  referenceProfileFile,
  type ProcessStartProfile,
} from "./process-profile.ts";

/** Verify the resolved files independently of fresh/resumed session reservation. */
export function verifyProcessResources(
  profile: ProcessStartProfile,
  trace?: InspectionTrace,
): void {
  if (profile.version !== 1 || profile.runtime.pi.version !== "0.73.0")
    throw new ProcessProfileError("UNSUPPORTED_PROFILE_VERSION");
  for (const ref of [
    profile.runtime.node,
    profile.runtime.pi,
    profile.runtime.pi.packageFile,
    ...profile.resources,
    ...profile.protections.flatMap((p) => [p.extension, ...p.configuration]),
    ...(profile.parent.context ? [profile.parent.context] : []),
  ]) {
    const verify = () => {
      if (referenceProfileFile(ref.path).sha256 !== ref.sha256)
        throw new ProcessProfileError("RESOURCE_CHANGED");
    };
    if (trace && ref === profile.runtime.node) trace.sync("nodeBinary", verify);
    else verify();
  }
}
function privateOwned(stat: import("node:fs").Stats): boolean {
  return (
    (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid())
  );
}
function verifySessionDirectory(file: string): void {
  try {
    const path = dirname(file);
    const directory = lstatSync(path);
    if (!directory.isDirectory() || !privateOwned(directory) || realpathSync(path) !== path)
      throw new Error();
  } catch {
    throw new ProcessProfileError("PRIVATE_SESSION_DIRECTORY_REQUIRED");
  }
}

/** The caller creates the private directory. Existing sessions are never overwritten. */
export function reserveProcessSession(profile: ProcessStartProfile): void {
  verifySessionDirectory(profile.session.file);
  let fd: number;
  try {
    fd = openSync(
      profile.session.file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new ProcessProfileError("SESSION_COLLISION");
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        type: "session",
        version: 3,
        id: profile.identity.sessionId,
        timestamp: new Date().toISOString(),
        cwd: profile.cwd,
      }) + "\n",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function verifyProcessSession(profile: ProcessStartProfile): void {
  verifySessionDirectory(profile.session.file);
  let fd: number;
  try {
    fd = openSync(profile.session.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ProcessProfileError("SESSION_UNAVAILABLE");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateOwned(stat) || stat.nlink !== 1)
      throw new ProcessProfileError("SESSION_OWNERSHIP_MISMATCH");
    // A retained local session may be large; read only the bounded header.
    const buffer = Buffer.alloc(8192);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, count).indexOf(10);
    if (newline < 0) throw new ProcessProfileError("SESSION_INVALID");
    const header = buffer.subarray(0, newline).toString("utf8");
    const value = JSON.parse(header);
    if (
      value.type !== "session" ||
      value.version !== 3 ||
      value.id !== profile.identity.sessionId ||
      value.cwd !== profile.cwd
    )
      throw new ProcessProfileError("SESSION_IDENTITY_MISMATCH");
  } catch (error) {
    throw error instanceof ProcessProfileError ? error : new ProcessProfileError("SESSION_INVALID");
  } finally {
    closeSync(fd);
  }
}
