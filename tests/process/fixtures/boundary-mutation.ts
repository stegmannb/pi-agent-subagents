import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const secretFailure =
  "SENSITIVE_BOUNDARY_DIAGNOSTIC /private/credential token=hidden\nRESOURCE_CHANGED";

/** Mutate a captured file at a real public SDK hook, only in the private child. */
export default function (pi: ExtensionAPI): void {
  const mutate = (hook: string, ctx: ExtensionContext) => {
    if (process.cwd() === process.env.PASA_BOUNDARY_PARENT_CWD) return;
    if (process.env.PASA_BOUNDARY_MUTATION !== hook) return;
    if (process.env.PASA_BOUNDARY_FAILURE === "unknown") {
      // Deliberate fault injection through the actual SDK object. The productive
      // verifier and termination capability remain installed and run unchanged.
      ctx.sessionManager.getSessionId = () => {
        throw Object.assign(new Error(secretFailure), { code: secretFailure });
      };
      process.stderr.write(secretFailure);
    } else {
      appendFileSync(process.env.PASA_BOUNDARY_CONFIG!, "\n");
    }
    appendFileSync(
      process.env.PASA_BOUNDARY_TRACE!,
      JSON.stringify({ hook, pid: process.pid }) + "\n",
    );
  };
  pi.on("session_start", async (_event, ctx) => {
    mutate("session_start", ctx);
  });
  pi.on("input", async (_event, ctx) => {
    mutate("input", ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    mutate("before_agent_start", ctx);
  });
  pi.on("session_before_compact", async (_event, ctx) => {
    mutate("session_before_compact", ctx);
  });
}
