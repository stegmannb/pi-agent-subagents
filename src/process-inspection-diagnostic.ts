/** Bounded observations, never readiness evidence. No error objects or resource values. */
export const inspectionPhases = [
  "request",
  "inspection",
  "resources",
  "nodeBinary",
  "session",
  "extensions",
  "guard",
  "sandbox",
  "return",
] as const;
export type InspectionPhase = (typeof inspectionPhases)[number];
export type InspectionStage = "startup" | "preprompt";
export interface InspectionDiagnostic {
  stage: InspectionStage;
  phase: InspectionPhase;
  event: "start" | "end" | "error";
  durationMs: number;
}
export type InspectionSink = (record: Readonly<InspectionDiagnostic>) => void;
export const diagnosticFrameBytes = 512;
export const diagnosticInspectionLimit = 32;
export const diagnosticProcessLimit = 128;
export const diagnosticHistoryLimit = 64;

export function isInspectionDiagnostic(value: unknown): value is InspectionDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 4 &&
    (v.stage === "startup" || v.stage === "preprompt") &&
    inspectionPhases.includes(v.phase as InspectionPhase) &&
    (v.event === "start" || v.event === "end" || v.event === "error") &&
    typeof v.durationMs === "number" &&
    Number.isFinite(v.durationMs) &&
    v.durationMs >= 0 &&
    v.durationMs <= Number.MAX_SAFE_INTEGER
  );
}

/** Sink exceptions cannot skip, replace, or authorize the measured operation. */
export class InspectionTrace {
  private count = 0;
  private readonly stage: InspectionStage;
  private readonly sink: InspectionSink;
  constructor(stage: InspectionStage, sink: InspectionSink) {
    this.stage = stage;
    this.sink = sink;
  }
  emit(phase: InspectionPhase, event: InspectionDiagnostic["event"], durationMs = 0): void {
    if (this.count++ >= diagnosticInspectionLimit) return;
    try {
      this.sink(
        Object.freeze({ stage: this.stage, phase, event, durationMs: Math.max(0, durationMs) }),
      );
    } catch {
      /* Observability must not alter the verification result. */
    }
  }
  sync<T>(phase: InspectionPhase, operation: () => T): T {
    this.emit(phase, "start");
    const start = performance.now();
    try {
      const value = operation();
      this.emit(phase, "end", performance.now() - start);
      return value;
    } catch (error) {
      this.emit(phase, "error", performance.now() - start);
      throw error;
    }
  }
  async async<T>(phase: InspectionPhase, operation: () => Promise<T>): Promise<T> {
    this.emit(phase, "start");
    const start = performance.now();
    try {
      const value = await operation();
      this.emit(phase, "end", performance.now() - start);
      return value;
    } catch (error) {
      this.emit(phase, "error", performance.now() - start);
      throw error;
    }
  }
}
