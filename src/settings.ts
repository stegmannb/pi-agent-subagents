/**
 * settings.ts — Persistence for operational settings.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { JoinMode } from "./types.ts";

export interface SubagentsSettings {
  maxConcurrent?: number;
  defaultMaxTurns?: number;
  defaultTimeoutSeconds?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  cmuxIntegration?: boolean;
  cmuxLingerMs?: number;
}

export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setDefaultTimeoutSeconds: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setCmuxIntegration: (enabled: boolean) => void;
  setCmuxLingerMs: (ms: number) => void;
}

export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);

function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= 1024
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= 10_000
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.defaultTimeoutSeconds) &&
    (r.defaultTimeoutSeconds as number) >= 0 &&
    (r.defaultTimeoutSeconds as number) <= 86_400
  ) {
    out.defaultTimeoutSeconds = r.defaultTimeoutSeconds as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= 1_000
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
    out.defaultJoinMode = r.defaultJoinMode as JoinMode;
  }
  if (typeof r.cmuxIntegration === "boolean") {
    out.cmuxIntegration = r.cmuxIntegration;
  }
  if (
    Number.isInteger(r.cmuxLingerMs) &&
    (r.cmuxLingerMs as number) >= 0 &&
    (r.cmuxLingerMs as number) <= 300_000
  ) {
    out.cmuxLingerMs = r.cmuxLingerMs as number;
  }
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return {
    ...readSettingsFile(globalPath()),
    ...readSettingsFile(projectPath(cwd)),
  };
}

export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  let temporary: string | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    let mode: number | undefined;
    try {
      mode = statSync(path).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    temporary = join(dirname(path), `.subagents-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(s, null, 2), { encoding: "utf-8", flag: "wx", mode });
    // Creation applies umask; restore the existing file's mode before publication.
    if (mode !== undefined) chmodSync(temporary, mode);
    // Readers can open either complete version, including while the next save writes.
    renameSync(temporary, path);
    temporary = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best effort after a failed save; the published file is still intact.
      }
    }
  }
}

export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.defaultTimeoutSeconds === "number")
    appliers.setDefaultTimeoutSeconds(s.defaultTimeoutSeconds);
  if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (typeof s.cmuxIntegration === "boolean") appliers.setCmuxIntegration(s.cmuxIntegration);
  if (typeof s.cmuxLingerMs === "number") appliers.setCmuxLingerMs(s.cmuxLingerMs);
}

export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persisted
    ? { message: successMsg, level: "info" }
    : {
        message: `${successMsg} (session only; failed to persist)`,
        level: "warning",
      };
}
