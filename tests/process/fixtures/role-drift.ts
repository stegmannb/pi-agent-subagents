import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
/** Real hook fault injection. No verifier is replaced and only the first child is changed. */
export default function (pi: ExtensionAPI): void {
  let contexts = 0;
  const change = (ctx: ExtensionContext) => {
    const marker = process.env.PASA_ROLE_DRIFT_MARKER;
    const file = ctx.sessionManager.getSessionFile()?.replace(/\.jsonl$/, "-role.md");
    if (!marker || !file || !existsSync(file) || existsSync(marker)) return;
    writeFileSync(marker, JSON.stringify({ pid: process.pid, roleFile: file }), { flag: "wx" });
    chmodSync(file, 0o600);
    appendFileSync(file, "\nUntrusted role drift.\n");
  };
  pi.on("session_start", async (_, ctx) => {
    if (process.env.PASA_ROLE_DRIFT_PHASE === "startup") change(ctx);
  });
  pi.on("context", async (_, ctx) => {
    if (process.env.PASA_ROLE_DRIFT_PHASE === "continuation" && ++contexts === 2) change(ctx);
  });
}
