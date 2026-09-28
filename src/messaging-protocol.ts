/** Version 1 of the local process transport. No Pi runtime dependencies. */
export const PROTOCOL_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type MessageKind = "request" | "reply" | "event" | "cancel";
export interface Participant {
  groupId: string;
  agentId: string;
  parentId: string | null;
  sessionId: string;
}
export interface Envelope {
  version: 1;
  messageId: string;
  kind: MessageKind;
  from: string;
  to: string;
  correlationId?: string;
  payload: Json;
  timeoutMs?: number;
}
export const ERROR_CODES = [
  "PROTOCOL_ERROR",
  "FRAME_TOO_LARGE",
  "AUTH_FAILED",
  "ALREADY_CONNECTED",
  "FORBIDDEN",
  "UNKNOWN_TARGET",
  "TARGET_DISCONNECTED",
  "SENDER_MISMATCH",
  "DUPLICATE_CONFLICT",
  "INVALID_CORRELATION",
  "CAPACITY",
  "TIMEOUT",
  "CANCELLED",
  "DISCONNECTED",
  "BROKER_CLOSED",
  "BROKER_DISCONNECTED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export class TransportError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.name = "TransportError";
    this.code = code;
  }
}
export interface TransportLimits {
  maxFrameBytes: number;
  maxQueueBytes: number;
  maxInboxMessages: number;
  maxPending: number;
  maxParticipants: number;
  maxConnections: number;
  maxDedupeEntries: number;
  dedupeTtlMs: number;
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
}
export const DEFAULT_LIMITS: Readonly<TransportLimits> = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxQueueBytes: 256 * 1024,
  maxInboxMessages: 128,
  maxPending: 256,
  maxParticipants: 128,
  maxConnections: 128,
  maxDedupeEntries: 4096,
  dedupeTtlMs: 60_000,
  requestTimeoutMs: 30_000,
  handshakeTimeoutMs: 5_000,
});
export function resolveLimits(options: Partial<TransportLimits> = {}): TransportLimits {
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new TypeError("Transport limits must be positive integers <= 2147483647");
    }
  }
  if (limits.maxQueueBytes < limits.maxFrameBytes + 1) {
    throw new TypeError("maxQueueBytes must accommodate one frame and its newline");
  }
  return limits;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
export function parseParticipant(value: unknown): Participant {
  if (
    !isRecord(value) ||
    !isId(value.groupId) ||
    !isId(value.agentId) ||
    !isId(value.sessionId) ||
    (value.parentId !== null && !isId(value.parentId))
  ) {
    throw new TransportError("PROTOCOL_ERROR");
  }
  return {
    groupId: value.groupId,
    agentId: value.agentId,
    parentId: value.parentId,
    sessionId: value.sessionId,
  };
}
export function parseEnvelope(value: unknown): Envelope {
  if (
    !isRecord(value) ||
    value.version !== PROTOCOL_VERSION ||
    !isId(value.messageId) ||
    !isId(value.from) ||
    !isId(value.to) ||
    !["request", "reply", "event", "cancel"].includes(value.kind as string) ||
    !("payload" in value)
  )
    throw new TransportError("PROTOCOL_ERROR");
  const correlated = value.kind === "reply" || value.kind === "cancel";
  if (correlated ? !isId(value.correlationId) : value.correlationId !== undefined) {
    throw new TransportError("PROTOCOL_ERROR");
  }
  if (value.kind === "request") {
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > 2_147_483_647
    )
      throw new TransportError("PROTOCOL_ERROR");
  } else if (value.timeoutMs !== undefined) throw new TransportError("PROTOCOL_ERROR");
  return {
    version: 1,
    messageId: value.messageId,
    kind: value.kind as MessageKind,
    from: value.from,
    to: value.to,
    payload: value.payload as Json,
    ...(correlated ? { correlationId: value.correlationId as string } : {}),
    ...(value.kind === "request" ? { timeoutMs: value.timeoutMs as number } : {}),
  };
}
export type ClientFrame =
  | { version: 1; type: "hello"; capability: string }
  | { version: 1; type: "send"; envelope: Envelope }
  | { version: 1; type: "received"; messageId: string; from: string };
export type ServerFrame =
  | { version: 1; type: "ready"; participant: Participant; limits: TransportLimits }
  | { version: 1; type: "message"; envelope: Envelope }
  | { version: 1; type: "accepted" | "received"; messageId: string }
  | { version: 1; type: "error"; code: ErrorCode; messageId?: string }
  | { version: 1; type: "peer-disconnected"; agentId: string }
  | { version: 1; type: "shutdown" };
