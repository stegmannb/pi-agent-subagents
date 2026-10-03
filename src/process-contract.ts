import type { QualificationPreset } from "./process-qualification.ts";
import type { AgentSession, EventBus } from "@mariozechner/pi-coding-agent";
import type { ParticipantCredential } from "./messaging-broker.ts";
import type {
  CredentialReferences,
  ProcessStartProfile,
  ProcessLimits,
  ProcessRole,
  ProcessModel,
} from "./process-profile.ts";
import type { ReadyProtectionSnapshot, ProtectionId } from "./protection-adapter.ts";
import type { ProcessRpcOptions } from "./process-rpc.ts";
import type { GroupBinding } from "./delegation-group.ts";
import type { LocalMessageClient } from "./messaging-client.ts";

export const PROCESS_RUNNER_EVENT = "pasa:process-runner:v1";
export const CHILD_POLICY_EVENT = "pasa:child-policy:v1";
export interface ProcessObservation {
  ownership?: import("./process-lifecycle.ts").ProcessOwnership;
  revision?: number;
  phase?: import("./process-lifecycle.ts").ProcessPhase;
  /** Optional transport binding. A pane label alone is never a process identity. */
  paneId?: string;
  paneProcessId?: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  processId: string;
  pid?: number;
  sessionFile: string;
  cwd: string;
}
export interface ProcessExecution {
  taskId: string;
  prompt: string;
  cwd: string;
  role: ProcessRole;
  roleInstructions?: string;
  model?: ProcessModel;
  thinking?: ProcessStartProfile["thinking"];
  limits?: Partial<ProcessLimits>;
  signal?: AbortSignal;
  onIdentity?: (identity: ProcessObservation) => void;
  onEvent?: ProcessRpcOptions["onEvent"];
}
export interface ProcessExecutionResult {
  responseText: string;
  /** A received result may still have ingested=false and PARENT_SESSION_WRITE_FAILED.
   * Only delivery?.ingested === true proves persistent parent-session ingestion.
   */
  delivery?: import("./process-results.ts").ResultDelivery;
  resume: (prompt: string, signal?: AbortSignal) => Promise<ProcessExecutionResult>;
}
export interface ProcessRunner {
  /** Collect the child result. Fulfillment (also on resume) does not imply successful ingestion.
   * Consumers must inspect delivery and preserve/report pending results after a save failure.
   */
  execute(input: ProcessExecution): Promise<ProcessExecutionResult>;
  abort?(handle: import("./process-lifecycle.ts").ProcessHandle): Promise<void>;
  inspect?(
    handle: import("./process-lifecycle.ts").ProcessHandle,
  ): import("./process-lifecycle.ts").ProcessRegistration;
  takeover?(
    handle: import("./process-lifecycle.ts").ProcessHandle,
    ownership: "manual" | "external",
  ): Promise<import("./process-lifecycle.ts").ProcessRegistration>;
  cleanup?(
    handle: import("./process-lifecycle.ts").ProcessHandle,
  ): Promise<import("./process-lifecycle.ts").ProcessRegistration>;
}
export interface ProcessHostPolicy {
  /** Trusted host declares an actual human answer channel. Absent leaves requests blocked. */
  humanAnswerChannel?: "interactive" | "rpc";
  /** Explicit trusted-host functional QEMU qualification; production default is absent. */
  qualificationPreset?: QualificationPreset;
  /** Trusted host code only. Never accepted from Agent arguments. Default off. */
  onInspectionDiagnostic?: ProcessRpcOptions["onInspectionDiagnostic"];
  sessionDirectory: string;
  /** First child get_state response only; default 10000ms, maximum 120000ms. */
  childStartupTimeoutMs?: number;
  /** Required protection loader preloads, also used before child SDK imports. */
  nodeImports?: string[];
  /** Exact loaded entrypoint classifications. Unknown extensions fail closed. */
  extensions: Array<{ path: string; protectionId: ProtectionId | null }>;
  environmentAllowlist: string[];
  credentials: CredentialReferences;
  limits: Pick<ProcessLimits, "maxTurns" | "timeoutSeconds"> &
    Partial<Pick<ProcessLimits, "maxConcurrent" | "maxDepth">>;
}
export interface NestedProcessHost {
  client: LocalMessageClient;
  binding: GroupBinding;
  profile: ProcessStartProfile;
  settingsSourceCwd: string;
}
export interface ProcessParent {
  session: AgentSession;
  cwd: string;
  agentDir: string;
  eventBus: EventBus;
}
export interface ProcessBootstrap {
  qualificationPreset?: QualificationPreset;
  profile: ProcessStartProfile;
  credentials: CredentialReferences;
  parentCwd: string;
  protections: ReadyProtectionSnapshot[];
  broker: ParticipantCredential;
  groupBinding?: GroupBinding;
  hostPolicy?: ProcessHostPolicy;
  settingsSourceCwd?: string;
  taskGoal?: string;
}
export interface ChildInspection {
  pid: number;
  cwd: string;
  sessionId: string;
  tools: string[];
  extensions: string[];
  protections: ReadyProtectionSnapshot[];
  brokerAgentId: string;
}
