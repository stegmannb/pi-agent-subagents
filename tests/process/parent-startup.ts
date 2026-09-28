import { performance } from "node:perf_hooks";
import { ProcessRpc, type ProcessRpcOptions } from "../../src/process-rpc.ts";

export const protectionVM = process.env.PASA_PROTECTION_VM === "1";
export const protectionCaseTimeoutMs = protectionVM ? 690_000 : 90_000;
export const parentStartupTimeoutMs = protectionVM ? 120_000 : 20_000;
export const childStartupPolicy = protectionVM
  ? { childStartupTimeoutMs: 120_000, qualificationPreset: "qemu-functional" as const }
  : {};
// Explicit functional QEMU qualification; production/default timing remains unchanged.
export const childRunTimeoutSeconds = (native: number): number => (protectionVM ? 120 : native);
// Outer orchestration includes Parent startup and up to two Child startups/runs.
export const childPromptTimeoutMs = protectionVM ? 285_000 : 45_000;
export const childDoneTimeoutMs = protectionVM ? 260_000 : 20_000;

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
