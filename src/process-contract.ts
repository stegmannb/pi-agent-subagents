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

export const PROCESS_RUNNER_EVENT = "pasa:process-runner:v1";
export const CHILD_POLICY_EVENT = "pasa:child-policy:v1";
export interface ProcessObservation {
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
  resume: (prompt: string, signal?: AbortSignal) => Promise<ProcessExecutionResult>;
}
export interface ProcessRunner {
  execute(input: ProcessExecution): Promise<ProcessExecutionResult>;
}
export interface ProcessHostPolicy {
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
  limits: ProcessLimits;
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
  roleInstructions?: string;
  protections: ReadyProtectionSnapshot[];
  broker: ParticipantCredential;
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
