import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
/** Kernel birth identity supplements the private RPC incarnation and original ChildProcess handle. */
export function osProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return undefined;
      return JSON.stringify({ pid, parent: fields[1], start: fields[19] });
    }
    if (process.platform === "darwin") {
      const stamp = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat=,pid=,ppid=,lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
      const fields = /^(\S+)\s+(.+)$/.exec(stamp);
      if (!fields || /^[ZX]/.test(fields[1]!)) return undefined;
      return fields[2];
    }
  } catch {
    /* An unproven process is never a signal target. */
  }
  return undefined;
}
