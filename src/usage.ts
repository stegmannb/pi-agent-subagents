/**
 * usage.ts — Token usage helpers.
 */

import type { LifetimeUsage } from "./types.ts";

export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
}

export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};

export type SessionLike = { getSessionStats(): SessionStatsLike };

export function getSessionContextPercent(
  session: SessionLike | undefined,
): number | null {
  if (!session) return null;
  try {
    return session.getSessionStats().contextUsage?.percent ?? null;
  } catch {
    return null;
  }
}
