import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentSession, EventBus } from "@mariozechner/pi-coding-agent";
import type { GroupBinding } from "./delegation-group.ts";
import type { LocalMessageClient } from "./messaging-client.ts";
import { isRecord, TransportError, type Envelope, type Json } from "./messaging-protocol.ts";
import {
  ResultLedger,
  ResultDeliveryTimeoutError,
  type AgentResult,
  type ResultIdentity,
  type ResultDelivery,
} from "./process-results.ts";

export const COMMUNICATION_EVENT = "pasa:communication:v1";
export const MANAGED_STATE_EVENT = "pasa:managed-state:v1";
export const MANAGED_CHANGED_EVENT = "pasa:managed-changed:v1";
export const HELP_REQUEST_EVENT = "pasa:help-request:v1";
export class ProcessCommunication {
  readonly binding: GroupBinding;
  readonly results: ResultLedger;
  private readonly client: LocalMessageClient;
  private readonly session: AgentSession;
  private readonly requests = new Map<string, Envelope>();
  private readonly waiters = new Map<
    string,
    { resolve: () => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
  >();
  private ended = false;
  private failure?: unknown;
  private wakeQueue: Promise<void> = Promise.resolve();
  private pendingWakes = 0;
  private readonly bus: EventBus;
  report?: {
    goal?: string;
    basis?: string;
    findings?: string;
    evidence?: string[];
    blockers?: string[];
  };
  constructor(
    client: LocalMessageClient,
    binding: GroupBinding,
    session: AgentSession,
    bus: EventBus,
  ) {
    this.client = client;
    this.binding = binding;
    this.session = session;
    this.bus = bus;
    this.results = new ResultLedger(
      (result) => this.persist(result),
      () => this.changed(),
    );
    void this.pump();
  }
  get pending(): boolean {
    return this.pendingWakes > 0 || this.requests.size > 0 || this.failure !== undefined;
  }
  wake(content: string, behavior: "steer" | "followUp" = "steer"): void {
    if (this.pendingWakes >= 128) {
      this.failure = new Error("WAKE_CAPACITY");
      throw this.failure;
    }
    this.pendingWakes++;
    this.wakeQueue = this.wakeQueue
      .then(async () => {
        if (this.ended) return;
        // Use the public guarded prompt path, including input and before_agent_start.
        // Raw custom-message triggerTurn bypasses those hooks when the session is idle.
        await this.session.prompt(content, {
          streamingBehavior: behavior,
          expandPromptTemplates: false,
        });
      })
      .catch((error) => {
        this.failure = error;
      })
      .finally(() => {
        this.pendingWakes--;
        this.bus.emit(MANAGED_CHANGED_EVENT, {});
      });
  }
  private persist(result: AgentResult): void {
    if (this.session.sessionId !== result.parentSessionId || !this.session.sessionFile)
      throw new Error("PARENT_SESSION_CHANGED");
    const disk = () => {
      const entries = readFileSync(this.session.sessionFile!, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (entries[0]?.type !== "session" || entries[0].id !== result.parentSessionId)
        throw new Error("PARENT_SESSION_CHANGED");
      return entries.filter(
        (e) =>
          e.type === "custom" &&
          e.customType === "pasa:result" &&
          e.data?.resultId === result.resultId,
      );
    };
    const previous = disk();
    if (previous.length) {
      if (previous.length !== 1 || JSON.stringify(previous[0].data) !== JSON.stringify(result))
        throw new Error("CONFLICTING_RESULT");
      return;
    }
    // SDK append mutates memory before writing. Never append again after a partial write failure.
    if (
      this.session.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "custom" &&
            e.customType === "pasa:result" &&
            (e.data as AgentResult)?.resultId === result.resultId,
        )
    )
      throw new Error("PARENT_SESSION_WRITE_FAILED");
    this.session.sessionManager.appendCustomEntry("pasa:result", result);
    const saved = disk();
    if (saved.length !== 1 || JSON.stringify(saved[0].data) !== JSON.stringify(result))
      throw new Error("PARENT_SESSION_WRITE_FAILED");
  }
  private changed(): void {
    for (const [id, waiter] of this.waiters) {
      const status = this.results.get(id)?.status;
      if (status?.produced && status.accepted && status.received) {
        clearTimeout(waiter.timer);
        this.waiters.delete(id);
        waiter.resolve();
      }
    }
  }
  /** Collect a received result and its delivery status, including pending ingestion after a save error.
   * Fulfillment is not a persistence acknowledgement; consumers must check delivery.ingested.
   */
  async waitResult(
    identity: ResultIdentity,
    timeoutMs = 30_000,
  ): Promise<{ result: AgentResult; delivery: ResultDelivery }> {
    if (this.failure) throw this.failure;
    const status = this.results.get(identity.resultId)?.status;
    if (!status?.received || !status.accepted)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            this.waiters.delete(identity.resultId);
            reject(new ResultDeliveryTimeoutError());
          },
          Math.max(1, timeoutMs),
        );
        this.waiters.set(identity.resultId, { resolve, reject, timer });
        this.changed();
      });
    const entry = this.results.get(identity.resultId)!;
    return { result: entry.result!, delivery: entry.status };
  }
  async members(): Promise<GroupBinding[]> {
    return this.client.control("members");
  }
  async send(to: string, message: string): Promise<string> {
    const target = to === "parent" ? this.binding.parentId : to;
    if (!target) throw new Error("PARENT_UNAVAILABLE");
    const handle = this.client.event(target, { type: "steer", message });
    await handle.received;
    return handle.messageId;
  }
  async help(message: string, signal?: AbortSignal): Promise<string> {
    if (!this.binding.parentId) throw new Error("PARENT_UNAVAILABLE");
    const id = randomUUID();
    const cancel = () => {
      void this.client.cancel(this.binding.parentId!, id).accepted.catch(() => {});
    };
    if (signal?.aborted) throw new Error("ABORTED");
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const reply = await this.client.request(
        this.binding.parentId,
        { type: "help", message },
        { messageId: id },
      );
      if (!isRecord(reply.payload) || typeof reply.payload.message !== "string")
        throw new Error("INVALID_REPLY");
      return reply.payload.message;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  pendingHelp(): Array<{ id: string; from: string; message: Json }> {
    return [...this.requests.values()].map((e) => ({
      id: e.messageId,
      from: e.from,
      message: e.payload,
    }));
  }
  async reply(id: string, message: string): Promise<void> {
    const request = this.requests.get(id);
    if (!request) throw new Error("UNKNOWN_HELP_REQUEST");
    await this.client.reply(request, { message }).received;
    this.requests.delete(id);
    this.bus.emit(MANAGED_CHANGED_EVENT, {});
  }
  async steer(to: string, message: string): Promise<void> {
    const request = [...this.requests.values()].find((e) => e.from === to);
    if (request) await this.reply(request.messageId, message);
    else await this.send(to, message);
  }
  async publish(result: AgentResult): Promise<void> {
    if (!this.binding.parentId) throw new Error("PARENT_UNAVAILABLE");
    const delivery = this.client.event(this.binding.parentId, {
      type: "result",
      result: result as unknown as Json,
    });
    await delivery.accepted;
    await this.client.event(this.binding.parentId, {
      type: "result-stage",
      resultId: result.resultId,
      stage: "accepted",
    }).accepted;
    await delivery.received;
    await this.client.event(this.binding.parentId, {
      type: "result-stage",
      resultId: result.resultId,
      stage: "received",
    }).received;
  }
  private async pump(): Promise<void> {
    while (!this.ended) {
      try {
        const envelope = await this.client.nextMessage();
        if (envelope.kind === "cancel") {
          const request = this.requests.get(envelope.correlationId!);
          if (request?.from === envelope.from) this.requests.delete(envelope.correlationId!);
          this.bus.emit(MANAGED_CHANGED_EVENT, {});
          continue;
        }
        const payload = envelope.payload;
        if (!isRecord(payload)) continue;
        if (payload.type === "result") {
          this.results.receive(envelope.from, payload.result);
          continue;
        }
        if (
          payload.type === "result-stage" &&
          typeof payload.resultId === "string" &&
          ["accepted", "received"].includes(payload.stage as string)
        ) {
          this.results.stage(
            envelope.from,
            payload.resultId,
            payload.stage as "accepted" | "received",
          );
          continue;
        }
        if (payload.type === "help" && envelope.kind === "request") {
          if (this.requests.size >= 128) throw new Error("HELP_CAPACITY");
          this.requests.set(envelope.messageId, envelope);
          this.bus.emit(HELP_REQUEST_EVENT, {
            requestId: envelope.messageId,
            from: envelope.from,
            message: payload.message,
          });
          const timer = setTimeout(() => {
            this.requests.delete(envelope.messageId);
            this.bus.emit(MANAGED_CHANGED_EVENT, {});
          }, envelope.timeoutMs);
          timer.unref();
        }
        if (
          typeof payload.message === "string" &&
          ["help", "steer"].includes(payload.type as string)
        )
          this.wake(
            "Agent message: " +
              JSON.stringify({
                from: envelope.from,
                requestId: envelope.kind === "request" ? envelope.messageId : undefined,
                message: payload.message,
              }),
          );
      } catch (error) {
        if (error instanceof TransportError && error.code === "TIMEOUT") continue;
        this.failure = error;
        for (const waiter of this.waiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.waiters.clear();
        return;
      }
    }
  }
  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CLOSED"));
    }
    this.waiters.clear();
  }
}
export function findCommunication(bus: EventBus): ProcessCommunication | undefined {
  let value: ProcessCommunication | undefined;
  bus.emit(COMMUNICATION_EVENT, {
    bind: (channel: ProcessCommunication) => {
      value = channel;
    },
  });
  return value;
}
