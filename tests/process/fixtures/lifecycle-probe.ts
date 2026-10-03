import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { requireProcessRunner } from "../../../src/process-runner.ts";
import { findCommunication } from "../../../src/process-communication.ts";
import type { ProcessHandle, ProcessRegistration } from "../../../src/process-lifecycle.ts";

/** An owned side channel observes OS lifetime independently of the parent RPC connection. */
export default function (pi: ExtensionAPI): void {
  pi.registerCommand("life-control", {
    description: "Test-only explicit takeover of the displayed run",
    handler: async (args) => {
      const { handle, ownership, action } = JSON.parse(args) as {
        handle: ProcessHandle;
        ownership: "manual" | "external";
        action?: "cleanup" | "abort" | "assert-reserved" | "assert-released";
      };
      const runner = requireProcessRunner(pi.events);
      if (action === "assert-reserved" || action === "assert-released") {
        const member = (await findCommunication(pi.events)!.members()).find(
          (value) => value.agentId === handle.agentId,
        );
        if (
          !member ||
          member.processId !== handle.processId ||
          member.active !== (action === "assert-reserved")
        )
          throw new Error("TEST_GROUP_RESERVATION_MISMATCH");
      } else if (action === "cleanup") await runner.cleanup!(handle);
      else if (action === "abort") await runner.abort!(handle);
      else await runner.takeover!(handle, ownership);
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || event.input.command !== "echo lifecycle") return;
    const directory = process.env.PASA_LIFE_REGISTRY!;
    const record = readdirSync(directory)
      .filter((name) => !name.startsWith("current-") && name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as ProcessRegistration)
      .find(
        (entry) =>
          entry.pid === process.pid && entry.sessionId === ctx.sessionManager.getSessionId(),
      );
    if (!record) throw new Error("TEST_RUN_IDENTITY_MISSING");
    const socket = createConnection(process.env.PASA_LIFE_SOCKET!);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(JSON.stringify(record) + "\n");
    const scenario = process.env.PASA_LIFE_SCENARIO;
    if (scenario === "dialogs") {
      const selected = await ctx.ui.select("Choose", ["one", "two"]);
      const input = await ctx.ui.input("Explain", "text");
      const confirmed = await ctx.ui.confirm("Approval", "Allow this test operation?");
      socket.write(JSON.stringify({ selected, input, confirmed }) + "\n");
      if (!confirmed) return { block: true, reason: "HUMAN_APPROVAL_DENIED" };
    } else if (scenario === "cleanup" || scenario === "loss") {
      return { block: true, reason: "TEST_PERSISTED_RESULT" };
    } else if (scenario === "cancel") {
      const controller = new AbortController();
      socket.once("data", () => controller.abort());
      const confirmed = await ctx.ui.confirm(
        "Cancelled approval",
        "Wait for controlled cancellation",
        { signal: controller.signal },
      );
      socket.write(JSON.stringify({ confirmed }) + "\n");
      if (confirmed) throw new Error("CANCELLED_APPROVAL_MUST_NOT_CONTINUE");
      return { block: true, reason: "HUMAN_APPROVAL_CANCELLED" };
    } else if (scenario === "question") {
      await ctx.ui.confirm("Blocked approval", "No human channel exists");
      throw new Error("HEADLESS_APPROVAL_MUST_NOT_CONTINUE");
    } else {
      // Only a test-controlled event can release this hook. Abort deliberately cannot.
      await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    }
    return undefined;
  });
}
