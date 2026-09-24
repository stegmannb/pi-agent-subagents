import { resolve } from "node:path";

export function resolveAgentCwd(parentCwd: string, requestedCwd?: string): string {
  const normalizedCwd = requestedCwd?.replace(/^@/, "");
  return normalizedCwd ? resolve(parentCwd, normalizedCwd) : parentCwd;
}
