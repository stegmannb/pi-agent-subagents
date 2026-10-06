import type { AgentDetails } from "./ui/agent-widget.ts";

/**
 * Text for a rejected call that failed before any run existed, and therefore carries no details.
 * Failures that do have details keep their status rendering, so usage, worktree and process
 * information stay visible.
 */
export function plainAgentErrorText(
  content: readonly { type: string; text?: string }[],
  details: AgentDetails | undefined,
  isError: boolean | undefined,
): string | undefined {
  if (!isError || details?.status !== undefined) return undefined;
  const first = content[0];
  const text = first?.type === "text" ? (first.text ?? "") : "";
  return text || "Agent call failed.";
}
