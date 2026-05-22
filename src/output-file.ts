/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")
    .replace(/^[A-Za-z]:-/, "")
    .replace(/^-+/, "");
}

export function createOutputFilePath(
  cwd: string,
  agentId: string,
  sessionId: string,
): string {
  const encoded = encodeCwd(cwd);
  const uid = (() => {
    if (process.getuid) return String(process.getuid());
    try { return userInfo().username; } catch { return "user"; }
  })();
  const root = join(tmpdir(), `pi-subagents-${uid}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const dir = join(root, encoded, sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.output`);
}

export function writeInitialEntry(
  path: string,
  agentId: string,
  prompt: string,
  cwd: string,
): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
): () => void {
  let writtenCount = 1;

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type:
          msg.role === "assistant"
            ? "assistant"
            : msg.role === "user"
              ? "user"
              : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
      } catch {
        /* ignore */
      }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
  });

  return () => {
    flush();
    unsubscribe();
  };
}
