import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ProcessStartProfile } from "./process-profile.ts";
/** Reproduce Pi's one-level settings merge from the actual inherited file sources. */
export function inheritedSettings(cwd: string, agentDir: string): Record<string, unknown> {
  const source = SettingsManager.create(cwd, agentDir);
  const merged: Record<string, unknown> = { ...source.getGlobalSettings() };
  for (const [key, value] of Object.entries(source.getProjectSettings())) {
    const prior = merged[key];
    merged[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      prior &&
      typeof prior === "object" &&
      !Array.isArray(prior)
        ? { ...prior, ...value }
        : value;
  }
  merged.retry = { ...(merged.retry as object), enabled: false };
  return merged;
}
/** These three defaults come from the private resolved bootstrap, not a backing file. */
export function childSettings(
  cwd: string,
  agentDir: string,
  profile: Pick<ProcessStartProfile, "model" | "thinking">,
): Record<string, unknown> {
  return {
    ...inheritedSettings(cwd, agentDir),
    defaultProvider: profile.model.provider,
    defaultModel: profile.model.id,
    defaultThinkingLevel: profile.thinking,
  };
}
