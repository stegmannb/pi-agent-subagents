/** Private Child exit-status protocol. Diagnostic only; never a readiness proof. */
const phases = [
  "child:boot",
  "child:input",
  "child:model",
  "child:compaction",
  "child:disconnect",
] as const;
export type ChildFailurePhase = (typeof phases)[number];

// Fixed 32-value slots per phase, starting at 64. Keep ordering stable and total
// below 256: Unix exit statuses carry only one byte. Unassigned values stay opaque.
const codes = [
  "CHILD_FAILURE",
  "RESOURCE_CHANGED",
  "RESOURCE_UNAVAILABLE",
  "UNSUPPORTED_PROFILE_VERSION",
  "PRIVATE_SESSION_DIRECTORY_REQUIRED",
  "SESSION_UNAVAILABLE",
  "SESSION_OWNERSHIP_MISMATCH",
  "SESSION_INVALID",
  "SESSION_IDENTITY_MISMATCH",
  "CHILD_CWD_MISMATCH",
  "CHILD_POLICY_UNAVAILABLE",
  "CHILD_EXTENSION_FAILED",
  "UNKNOWN_MODEL",
  "BROKER_IDENTITY_MISMATCH",
  "CHILD_RESOURCE_MISMATCH",
  "CHILD_TOOL_MISMATCH",
  "CHILD_PROTECTION_MISMATCH",
  "PROTECTION_RESPONSE_TIMEOUT",
  "PROTECTION_RESPONSE_DUPLICATE",
  "PROTECTION_RESPONSE_MISMATCH",
  "PROTECTION_RESPONSE_INVALID",
  "PROTECTION_RESPONSE_INVALIDATED",
  "PROTECTION_ADAPTER_FAILED",
  "NON_REPRODUCIBLE_PROTECTION",
  "INVALID_PROTECTION_REQUEST",
  "CHILD_SESSION_REPLACEMENT_FORBIDDEN",
  "PRIVATE_BOOTSTRAP_REQUIRED",
  "CHILD_IPC_DISCONNECTED",
  "INVALID_QUALIFICATION_PRESET",
] as const;

export function childFailureExitStatus(phase: ChildFailurePhase, error: unknown): number {
  let index = 0;
  try {
    // Do not read message/stack/cause, invoke code getters, or coerce objects.
    const code =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
    if (typeof code === "string")
      index = Math.max(0, codes.indexOf(code as (typeof codes)[number]));
  } catch {
    // Even an object that refuses inspection produces the fixed generic code.
  }
  return 64 + Math.max(0, phases.indexOf(phase)) * 32 + index;
}

export function readChildFailureExitStatus(
  status: number | null,
): { phase: ChildFailurePhase; code: (typeof codes)[number] } | undefined {
  if (status === null || !Number.isInteger(status) || status < 64 || status >= 224)
    return undefined;
  const offset = status - 64;
  const phase = phases[Math.floor(offset / 32)];
  const code = codes[offset % 32];
  return phase && code ? { phase, code } : undefined;
}
