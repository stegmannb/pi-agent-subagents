/** Built-in child boundary loaded after the captured extensions, through Pi's public API. */
import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { CHILD_POLICY_EVENT } from "./process-contract.ts";
import type { ChildFailurePhase } from "./process-child-failure.ts";
export interface ChildPolicyBinding {
  tools: string[];
  verify: () => Promise<void>;
  /** Installed only by the private child entrypoint; never accepts a target PID. */
  terminate: (phase: ChildFailurePhase, error: unknown) => never;
  dialogs?: Pick<ExtensionUIContext, "select" | "confirm" | "input">;
}
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (binding?.dialogs) Object.assign(ctx.ui, binding.dialogs);
    ctx.ui.custom = async () => {
      throw new Error("CUSTOM_TUI_UNSUPPORTED");
    };
  });
  let binding: ChildPolicyBinding | undefined;
  pi.events.emit(CHILD_POLICY_EVENT, {
    bind: (value: ChildPolicyBinding) => {
      binding = value;
    },
  });
  pi.on("input", async () => {
    try {
      if (!binding) throw new Error("CHILD_POLICY_UNAVAILABLE");
      await binding.verify();
      return { action: "continue" };
    } catch (error) {
      binding?.terminate("child:input", error);
      return { action: "handled" };
    }
  });
  const verifyBeforeModel = async (phase: "child:model" | "child:compaction") => {
    try {
      if (!binding) throw new Error("CHILD_POLICY_UNAVAILABLE");
      await binding.verify();
      pi.setActiveTools(binding.tools);
    } catch (error) {
      // Pi catches extension exceptions and ctx.shutdown() is deferred in RPC mode.
      // Only the private entrypoint can supply termination of its own current process.
      binding?.terminate(phase, error);
      // An unbound module loaded outside that entrypoint must neither infer nor kill its host.
      return await new Promise<never>(() => {});
    }
  };
  pi.on("before_agent_start", () => verifyBeforeModel("child:model"));
  // Pi calls context before every model turn, including queued steering, follow-ups,
  // tool continuations and custom-message wakeups that do not emit before_agent_start.
  pi.on("context", () => verifyBeforeModel("child:model"));
  // A resumed session can compact before before_agent_start is emitted.
  pi.on("session_before_compact", () => verifyBeforeModel("child:compaction"));
  pi.on("tool_call", async (event) => {
    if (!binding || !binding.tools.includes(event.toolName))
      return { block: true, reason: "ROLE_TOOL_BOUNDARY" };
    // A protection change during a run cannot silently authorize further tools.
    try {
      await binding.verify();
    } catch {
      return { block: true, reason: "CHILD_PROTECTION_CHANGED" };
    }
    return undefined;
  });
}
