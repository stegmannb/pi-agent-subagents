import { performance } from "node:perf_hooks";
import { ProcessRpc, type ProcessRpcOptions } from "../../src/process-rpc.ts";

export const protectionVM = process.env.PASA_PROTECTION_VM === "1";
// Parent startup, two sequential 900-s prompts, then assertions and cleanup.
export const protectionCaseTimeoutMs = protectionVM ? 2_100_000 : 90_000;
export const parentStartupTimeoutMs = protectionVM ? 120_000 : 20_000;
export const childStartupPolicy = protectionVM
  ? { childStartupTimeoutMs: 120_000, qualificationPreset: "qemu-functional" as const }
  : {};
// Explicit functional QEMU qualification; production/default timing remains unchanged.
export const childRunTimeoutSeconds = (native: number): number => (protectionVM ? 600 : native);
// Each outer prompt includes Child startup/readiness and one 600-s run.
// The reviewer runs within the Task budget; correction uses a second outer prompt.
export const childPromptTimeoutMs = protectionVM ? 900_000 : 45_000;
export const childDoneTimeoutMs = protectionVM ? 900_000 : 20_000;

/** Only the test's outer Parent handshake gets the TCG startup allowance. */
export async function startProtectionParent(options: ProcessRpcOptions): Promise<ProcessRpc> {
  const started = performance.now();
  const client = await ProcessRpc.start({
    ...options,
    startupTimeoutMs: protectionVM ? parentStartupTimeoutMs : undefined,
  });
  console.log(`protected Parent RPC startup: ${Math.round(performance.now() - started)} ms`);
  return client;
}
