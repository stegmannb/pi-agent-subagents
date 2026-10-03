import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { ParticipantCredential } from "./messaging-broker.ts";
import {
  ERROR_CODES,
  TransportError,
  isId,
  isRecord,
  parseEnvelope,
  parseParticipant,
  resolveLimits,
  type Envelope,
  type ErrorCode,
  type Json,
  type Participant,
  type TransportLimits,
} from "./messaging-protocol.ts";
import { JsonLineWire } from "./messaging-wire.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: TransportError) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: TransportError) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Each stage is independently observable. An unused stage must not cause an unhandled rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export interface DeliveryHandle {
  messageId: string;
  accepted: Promise<void>;
  received: Promise<void>;
}
interface Outgoing {
  to: string;
  accepted: Deferred<void>;
  received: Deferred<void>;
  timer: NodeJS.Timeout;
}
interface RequestWait {
  to: string;
  result: Deferred<Envelope>;
  timer: NodeJS.Timeout;
}
interface InboxWait {
  result: Deferred<Envelope>;
  timer: NodeJS.Timeout;
}

export class LocalMessageClient {
  private identity?: Participant;
  get participant(): Readonly<Participant> {
    if (!this.identity) throw new TransportError("DISCONNECTED");
    return this.identity;
  }
  private readonly limits: TransportLimits;
  private readonly socket: Socket;
  private readonly wire: JsonLineWire;
  private readonly ready = deferred<void>();
  private readonly deliveries = new Map<string, Outgoing>();
  private readonly requests = new Map<string, RequestWait>();
  private readonly controls = new Map<
    string,
    { result: Deferred<unknown>; timer: NodeJS.Timeout }
  >();
  private readonly inbox: Envelope[] = [];
  private inboxBytes = 0;
  private readonly waiters: InboxWait[] = [];
  private ended?: TransportError;
  private readonly handshakeTimer: NodeJS.Timeout;
  private constructor(credential: ParticipantCredential, options: Partial<TransportLimits>) {
    this.limits = resolveLimits(options);
    this.socket = createConnection(credential.socketPath);
    this.wire = new JsonLineWire(
      this.socket,
      this.limits,
      (frame) => this.receive(frame),
      (code) => this.fail(code),
    );
    this.handshakeTimer = setTimeout(() => this.fail("TIMEOUT"), this.limits.handshakeTimeoutMs);
    this.socket.on("connect", () => {
      try {
        this.wire.send({ version: 1, type: "hello", capability: credential.capability });
      } catch (error) {
        this.fail(error instanceof TransportError ? error.code : "PROTOCOL_ERROR");
      }
    });
    this.socket.on("error", () => this.fail("BROKER_DISCONNECTED"));
    this.socket.on("close", () => this.fail("BROKER_DISCONNECTED"));
  }
  static async connect(
    credential: ParticipantCredential,
    options: Partial<TransportLimits> = {},
  ): Promise<LocalMessageClient> {
    const client = new LocalMessageClient(credential, options);
    await client.ready.promise;
    return client;
  }
  private receive(frame: unknown): void {
    if (!isRecord(frame) || frame.version !== 1) throw new TransportError("PROTOCOL_ERROR");
    if (frame.type === "shutdown") {
      this.fail("BROKER_CLOSED");
      return;
    }
    if (frame.type === "control-result") {
      if (!isId(frame.id)) throw new TransportError("PROTOCOL_ERROR");
      const pending = this.controls.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.controls.delete(frame.id);
      if (frame.code !== undefined) {
        if (!ERROR_CODES.includes(frame.code as ErrorCode))
          throw new TransportError("PROTOCOL_ERROR");
        pending.result.reject(new TransportError(frame.code as ErrorCode));
      } else pending.result.resolve(frame.value);
      return;
    }
    if (frame.type === "error") {
      if (!ERROR_CODES.includes(frame.code as ErrorCode))
        throw new TransportError("PROTOCOL_ERROR");
      if (frame.messageId === undefined) {
        this.fail(frame.code as ErrorCode);
        return;
      }
      if (!isId(frame.messageId)) throw new TransportError("PROTOCOL_ERROR");
      this.rejectMessage(frame.messageId, new TransportError(frame.code as ErrorCode));
      return;
    }
    if (!this.identity) {
      if (frame.type !== "ready" || !isRecord(frame.limits))
        throw new TransportError("PROTOCOL_ERROR");
      this.identity = Object.freeze(parseParticipant(frame.participant));
      const brokerLimits = resolveLimits(frame.limits);
      // Enforce whichever side has the smaller resource budget.
      for (const name of Object.keys(this.limits) as (keyof TransportLimits)[]) {
        this.limits[name] = Math.min(this.limits[name], brokerLimits[name]);
      }
      clearTimeout(this.handshakeTimer);
      this.ready.resolve();
      return;
    }
    if (frame.type === "peer-disconnected") {
      if (!isId(frame.agentId)) throw new TransportError("PROTOCOL_ERROR");
      const error = new TransportError("TARGET_DISCONNECTED");
      for (const [id, delivery] of this.deliveries)
        if (delivery.to === frame.agentId) this.rejectMessage(id, error);
      for (const [id, request] of this.requests)
        if (request.to === frame.agentId) this.rejectMessage(id, error);
      return;
    }
    if (frame.type === "accepted" || frame.type === "received") {
      if (!isId(frame.messageId)) throw new TransportError("PROTOCOL_ERROR");
      const delivery = this.deliveries.get(frame.messageId);
      if (delivery) {
        delivery[frame.type].resolve();
        if (frame.type === "received") {
          delivery.accepted.resolve();
          clearTimeout(delivery.timer);
          this.deliveries.delete(frame.messageId);
        }
      }
      return;
    }
    if (frame.type !== "message") throw new TransportError("PROTOCOL_ERROR");
    const envelope = parseEnvelope(frame.envelope);
    if (envelope.to !== this.identity.agentId) throw new TransportError("PROTOCOL_ERROR");
    if (envelope.kind === "reply") {
      const request = this.requests.get(envelope.correlationId!);
      // A reply can race the local timeout. Never queue an orphan reply for a model turn.
      if (request && request.to === envelope.from) {
        clearTimeout(request.timer);
        this.requests.delete(envelope.correlationId!);
        request.result.resolve(envelope);
      }
    } else {
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.result.resolve(envelope);
      } else {
        const size = Buffer.byteLength(JSON.stringify(envelope));
        if (
          this.inbox.length >= this.limits.maxInboxMessages ||
          this.inboxBytes + size > this.limits.maxQueueBytes
        ) {
          throw new TransportError("CAPACITY");
        }
        this.inbox.push(envelope);
        this.inboxBytes += size;
      }
    }
    this.wire.send({
      version: 1,
      type: "received",
      messageId: envelope.messageId,
      from: envelope.from,
    });
  }
  private assertOpen(): void {
    if (this.ended) throw this.ended;
    if (!this.identity) throw new TransportError("DISCONNECTED");
  }
  private timeout(timeoutMs: number): number {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > this.limits.requestTimeoutMs
    ) {
      throw new RangeError("timeoutMs must be positive and within the negotiated requestTimeoutMs");
    }
    return timeoutMs;
  }
  /** Low-level send, also usable to retry an identical message ID within the dedupe window. */
  send(envelope: Envelope): DeliveryHandle {
    this.assertOpen();
    // Validate the serialized value, including payload omissions, before allocating state.
    let parsed: Envelope;
    try {
      parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
    } catch {
      throw new TransportError("PROTOCOL_ERROR");
    }
    if (this.deliveries.has(parsed.messageId)) throw new TransportError("DUPLICATE_CONFLICT");
    if (this.deliveries.size >= this.limits.maxPending) throw new TransportError("CAPACITY");
    const accepted = deferred<void>();
    const received = deferred<void>();
    const timer = setTimeout(
      () => this.rejectMessage(parsed.messageId, new TransportError("TIMEOUT")),
      this.limits.requestTimeoutMs,
    );
    this.deliveries.set(parsed.messageId, { to: parsed.to, accepted, received, timer });
    try {
      this.wire.send({ version: 1, type: "send", envelope: parsed });
    } catch (error) {
      this.rejectMessage(
        parsed.messageId,
        error instanceof TransportError ? error : new TransportError("PROTOCOL_ERROR"),
      );
    }
    return { messageId: parsed.messageId, accepted: accepted.promise, received: received.promise };
  }
  event(to: string, payload: Json): DeliveryHandle {
    return this.send(this.envelope("event", to, payload));
  }
  /** Private host control. Sender identity comes from this authenticated connection. */
  control<T>(
    operation:
      | "members"
      | "reserve"
      | "resume"
      | "release"
      | "register-process"
      | "bind-process"
      | "takeover-process"
      | "check-process",
    input: unknown = null,
  ): Promise<T> {
    this.assertOpen();
    if (this.controls.size >= this.limits.maxPending) throw new TransportError("CAPACITY");
    const id = randomUUID();
    const result = deferred<unknown>();
    const timer = setTimeout(() => {
      this.controls.delete(id);
      result.reject(new TransportError("TIMEOUT"));
    }, this.limits.requestTimeoutMs);
    this.controls.set(id, { result, timer });
    try {
      this.wire.send({ version: 1, type: "control", id, operation, input });
    } catch (error) {
      clearTimeout(timer);
      this.controls.delete(id);
      result.reject(error instanceof TransportError ? error : new TransportError("PROTOCOL_ERROR"));
    }
    return result.promise as Promise<T>;
  }
  request(
    to: string,
    payload: Json,
    options: { timeoutMs?: number; messageId?: string } = {},
  ): Promise<Envelope> {
    this.assertOpen();
    const timeoutMs = this.timeout(options.timeoutMs ?? this.limits.requestTimeoutMs);
    const envelope = {
      ...this.envelope("request", to, payload),
      timeoutMs,
      ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
    };
    if (this.requests.has(envelope.messageId) || this.deliveries.has(envelope.messageId))
      throw new TransportError("DUPLICATE_CONFLICT");
    if (this.requests.size >= this.limits.maxPending) throw new TransportError("CAPACITY");
    const result = deferred<Envelope>();
    const timer = setTimeout(
      () => this.rejectMessage(envelope.messageId, new TransportError("TIMEOUT")),
      timeoutMs,
    );
    this.requests.set(envelope.messageId, { to, result, timer });
    try {
      const delivery = this.send(envelope);
      void delivery.accepted.catch((error: TransportError) =>
        this.rejectMessage(envelope.messageId, error),
      );
    } catch (error) {
      this.rejectMessage(
        envelope.messageId,
        error instanceof TransportError ? error : new TransportError("PROTOCOL_ERROR"),
      );
    }
    return result.promise;
  }
  reply(request: Envelope, payload: Json): DeliveryHandle {
    if (request.kind !== "request" || request.to !== this.participant.agentId)
      throw new TransportError("INVALID_CORRELATION");
    return this.send({
      ...this.envelope("reply", request.from, payload),
      correlationId: request.messageId,
    });
  }
  cancel(to: string, correlationId: string, payload: Json = null): DeliveryHandle {
    return this.send({ ...this.envelope("cancel", to, payload), correlationId });
  }
  private envelope(kind: Envelope["kind"], to: string, payload: Json): Envelope {
    return {
      version: 1,
      messageId: randomUUID(),
      kind,
      from: this.participant.agentId,
      to,
      payload,
    };
  }
  /** Receipt means arrival in this bounded inbox, not that application code has acted. */
  nextMessage(timeoutMs = this.limits.requestTimeoutMs): Promise<Envelope> {
    this.assertOpen();
    this.timeout(timeoutMs);
    const envelope = this.inbox.shift();
    if (envelope) {
      this.inboxBytes -= Buffer.byteLength(JSON.stringify(envelope));
      return Promise.resolve(envelope);
    }
    if (this.waiters.length >= this.limits.maxPending) throw new TransportError("CAPACITY");
    const result = deferred<Envelope>();
    const waiter: InboxWait = {
      result,
      timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        result.reject(new TransportError("TIMEOUT"));
      }, timeoutMs),
    };
    this.waiters.push(waiter);
    return result.promise;
  }
  private rejectMessage(id: string, error: TransportError): void {
    const delivery = this.deliveries.get(id);
    if (delivery) {
      clearTimeout(delivery.timer);
      delivery.accepted.reject(error);
      delivery.received.reject(error);
      this.deliveries.delete(id);
    }
    const request = this.requests.get(id);
    if (request) {
      clearTimeout(request.timer);
      request.result.reject(error);
      this.requests.delete(id);
    }
  }
  private fail(code: ErrorCode): void {
    if (this.ended) return;
    this.ended = new TransportError(code);
    clearTimeout(this.handshakeTimer);
    this.ready.reject(this.ended);
    for (const control of this.controls.values()) {
      clearTimeout(control.timer);
      control.result.reject(this.ended);
    }
    this.controls.clear();
    for (const id of this.deliveries.keys()) this.rejectMessage(id, this.ended);
    for (const id of this.requests.keys()) this.rejectMessage(id, this.ended);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.result.reject(this.ended);
    }
    this.waiters.length = 0;
    this.inbox.length = 0;
    this.inboxBytes = 0;
    this.wire.stop();
    this.socket.destroy();
  }
  close(): void {
    this.fail("DISCONNECTED");
  }
}
