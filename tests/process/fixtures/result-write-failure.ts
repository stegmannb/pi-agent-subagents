import { chmodSync, existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, SessionManager } from "@mariozechner/pi-coding-agent";
/** Force a real EACCES inside Pi's public append, after its memory mutation. */
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_, ctx) => {
    const marker = process.env.PASA_RESULT_WRITE_FAILURE;
    const file = ctx.sessionManager.getSessionFile();
    if (!marker || !file || existsSync(file.replace(/\.jsonl$/, "-role.md"))) return;
    const manager = ctx.sessionManager as SessionManager;
    const append = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = (type, data) => {
      if (type !== "pasa:result") return append(type, data);
      chmodSync(file, 0o400);
      try {
        return append(type, data);
      } finally {
        chmodSync(file, 0o600);
        writeFileSync(
          marker,
          JSON.stringify({
            sessionFile: file,
            sessionId: manager.getSessionId(),
            data,
            entries: manager
              .getEntries()
              .filter((e) => e.type === "custom" && e.customType === "pasa:result"),
          }),
        );
      }
    };
  });
}
