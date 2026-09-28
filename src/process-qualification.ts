/** Trusted-host qualification only. Never inferred from environment or Agent arguments. */
import { ProcessProfileError } from "./process-profile.ts";
export type QualificationPreset = "qemu-functional";
const qemuFunctional = Object.freeze({
  snapshotMs: 20_000,
  inspectionMs: 40_000,
  readinessMs: 80_000,
});

export function validateQualificationPreset(value: unknown): QualificationPreset | undefined {
  if (value === undefined || value === "qemu-functional") return value;
  throw new ProcessProfileError("INVALID_QUALIFICATION_PRESET");
}
export function qualificationTiming(preset: QualificationPreset | undefined) {
  return validateQualificationPreset(preset) === "qemu-functional" ? qemuFunctional : undefined;
}
