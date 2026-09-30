import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DelegationGroup, type GroupBinding } from "./delegation-group.ts";
import type { ProcessRole } from "./process-profile.ts";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  TransportError,
  isId,
  isRecord,
  parseEnvelope,
  parseParticipant,
  resolveLimits,
  type Envelope,
  type ErrorCode,
  type Participant,
  type ServerFrame,
  type TransportLimits,
} from "./messaging-protocol.ts";
import { JsonLineWire } from "./messaging-wire.ts";

export interface ParticipantCredential {
  socketPath: string;
  capability: string;
}
interface Registration {
  participant: Participant;
  connection?: Connection;
}
interface Connection {
  socket: Socket;
  wire: JsonLineWire;
  registration?: Registration;
  timer: NodeJS.Timeout;
  destroyTimer?: NodeJS.Timeout;
}
interface Delivery {
  envelope: Pick<Envelope, "from" | "to" | "messageId">;
  fingerprint: string;
  expires: number;
  received: boolean;
  pending?: NodeJS.Timeout;
}
function key(from: string, messageId: string): string {
  return `${from}/${messageId}`;
}

export class LocalMessageBroker {
  readonly socketPath: string;
  readonly limits: Readonly<TransportLimits>;
  private readonly directory: string;
  private readonly server: Server;
  private readonly credentials = new Map<string, Registration>();
  private readonly participants = new Map<string, Registration>();
  private readonly connections = new Set<Connection>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly groups = new Map<string, DelegationGroup>();
  private readonly memberCredentials = new Map<string, ParticipantCredential>();
  private closed = false;
  private closing?: Promise<void>;
  private constructor(directory: string, limits: TransportLimits) {
    this.directory = directory;
    this.socketPath = join(directory, "s");
    this.limits = Object.freeze(limits);
    this.server = createServer((socket) => this.connect(socket));
  }
  static async start(options: Partial<TransportLimits> = {}): Promise<LocalMessageBroker> {
    const limits = resolveLimits(options);
    // Deliberately avoid macOS's long TMPDIR: sockaddr_un has a short path limit.
    const directory = await mkdtemp("/tmp/pasa-");
    const broker = new LocalMessageBroker(directory, limits);
    try {
      await chmod(directory, 0o700);
      await new Promise<void>((resolve, reject) => {
        broker.server.once("error", reject);
        broker.server.listen(broker.socketPath, () => {
          broker.server.off("error", reject);
          resolve();
        });
      });
      await chmod(broker.socketPath, 0o600);
      broker.server.on("error", () => {
        void broker.close();
      });
      return broker;
    } catch (error) {
      await broker.close();
      throw error;
    }
  }
  register(participant: Participant): ParticipantCredential {
    if (this.closed) throw new TransportError("BROKER_CLOSED");
    const identity = Object.freeze(parseParticipant(participant));
    if (this.participants.has(identity.agentId)) throw new TransportError("DUPLICATE_CONFLICT");
    if (this.participants.size >= this.limits.maxParticipants) throw new TransportError("CAPACITY");
    if (identity.parentId !== null) {
      const parent = this.participants.get(identity.parentId);
      if (!parent || parent.participant.groupId !== identity.groupId)
        throw new TransportError("FORBIDDEN");
    }
    const capability = randomBytes(32).toString("hex");
    const registration = { participant: identity };
    this.credentials.set(capability, registration);
    this.participants.set(identity.agentId, registration);
    return { socketPath: this.socketPath, capability };
  }
  registerRoot(
    sessionId: string,
    role: ProcessRole,
    limits: { maxConcurrent: number; maxDepth: number },
  ): {
    binding: GroupBinding;
    credential: ParticipantCredential;
  } {
    const binding: GroupBinding = {
      groupId: randomUUID(),
      agentId: randomUUID(),
      sessionId,
      parentId: null,
      processId: randomUUID(),
      taskId: "root",
      depth: 0,
      role,
      ...limits,
      active: true,
    };
    const group = new DelegationGroup(binding);
    const credential = this.register(binding);
    this.groups.set(binding.groupId, group);
    this.memberCredentials.set(binding.agentId, credential);
    return { binding, credential };
  }
  private control(connection: Connection, frame: Record<string, unknown>): void {
    if (!isId(frame.id)) throw new TransportError("PROTOCOL_ERROR");
    const participant = connection.registration!.participant;
    const group = this.groups.get(participant.groupId);
    try {
      if (!group) throw new TransportError("FORBIDDEN");
      let value: unknown;
      const input = frame.input;
      if (frame.operation === "members") value = [...group.members.values()];
      else if (frame.operation === "reserve") {
        if (this.participants.size >= this.limits.maxParticipants)
          throw new TransportError("CAPACITY");
        const binding = group.reserve(participant.agentId, input);
        try {
          const credential = this.register(binding);
          this.memberCredentials.set(binding.agentId, credential);
          value = { binding, credential };
        } catch (error) {
          group.release(participant.agentId, binding.agentId, binding.processId);
          throw error;
        }
      } else if (frame.operation === "resume" && isRecord(input) && isId(input.agentId)) {
        const previousRegistration = this.participants.get(input.agentId);
        const binding = group.resume(
          participant.agentId,
          input.agentId,
          previousRegistration?.connection !== undefined,
        );
        const previous = this.memberCredentials.get(binding.agentId)!;
        this.credentials.delete(previous.capability);
        const credential = {
          socketPath: this.socketPath,
          capability: randomBytes(32).toString("hex"),
        };
        const registration = { participant: previousRegistration!.participant };
        this.credentials.set(credential.capability, registration);
        this.participants.set(binding.agentId, registration);
        this.memberCredentials.set(binding.agentId, credential);
        value = { binding, credential };
      } else if (
        frame.operation === "release" &&
        isRecord(input) &&
        isId(input.agentId) &&
        isId(input.processId)
      ) {
        group.release(participant.agentId, input.agentId, input.processId);
        value = null;
      } else throw new TransportError("PROTOCOL_ERROR");
      this.send(connection, { version: 1, type: "control-result", id: frame.id, value });
    } catch (error) {
      this.send(connection, {
        version: 1,
        type: "control-result",
        id: frame.id,
        code: error instanceof TransportError ? error.code : "PROTOCOL_ERROR",
      });
    }
  }
  private connect(socket: Socket): void {
    // Reject before allocating framing/authentication state.
    if (this.closed || this.connections.size >= this.limits.maxConnections) {
      socket.destroy();
      return;
    }
    const connection: Connection = {
      socket,
      wire: new JsonLineWire(
        socket,
        this.limits,
        (frame) => this.receive(connection, frame),
        (code) => this.fatal(connection, code),
      ),
      timer: setTimeout(() => this.fatal(connection, "TIMEOUT"), this.limits.handshakeTimeoutMs),
    };
    this.connections.add(connection);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.disconnect(connection));
  }
  private send(connection: Connection, frame: ServerFrame): boolean {
    try {
      connection.wire.send(frame);
      return true;
    } catch {
      connection.socket.destroy();
      return false;
    }
  }
  private fatal(connection: Connection, code: ErrorCode): void {
    connection.wire.stop();
    this.send(connection, { version: 1, type: "error", code });
    // A bounded grace period lets a readable peer observe the reason.
    this.endConnection(connection);
  }
  private endConnection(connection: Connection): void {
    connection.socket.end();
    // Absolute deadline: incoming traffic must not prolong cleanup.
    connection.destroyTimer ??= setTimeout(() => connection.socket.destroy(), 100);
  }
  private receive(connection: Connection, frame: unknown): void {
    if (!isRecord(frame) || frame.version !== 1) throw new TransportError("PROTOCOL_ERROR");
    if (!connection.registration) {
      if (frame.type !== "hello" || typeof frame.capability !== "string")
        throw new TransportError("AUTH_FAILED");
      const registration = this.credentials.get(frame.capability);
      if (!registration) throw new TransportError("AUTH_FAILED");
      if (registration.connection) throw new TransportError("ALREADY_CONNECTED");
      connection.registration = registration;
      registration.connection = connection;
      clearTimeout(connection.timer);
      this.send(connection, {
        version: 1,
        type: "ready",
        participant: registration.participant,
        limits: this.limits,
      });
      return;
    }
    if (frame.type === "control") {
      this.control(connection, frame);
      return;
    }
    if (frame.type === "received") {
      if (!isId(frame.messageId) || !isId(frame.from)) throw new TransportError("PROTOCOL_ERROR");
      this.prune();
      const delivery = this.deliveries.get(key(frame.from, frame.messageId));
      if (!delivery || delivery.envelope.to !== connection.registration.participant.agentId) {
        throw new TransportError("INVALID_CORRELATION");
      }
      delivery.received = true;
      const sender = this.participants.get(delivery.envelope.from)?.connection;
      if (sender) this.send(sender, { version: 1, type: "received", messageId: frame.messageId });
      return;
    }
    if (frame.type !== "send") throw new TransportError("PROTOCOL_ERROR");
    const envelope = parseEnvelope(frame.envelope);
    try {
      this.route(connection, envelope);
    } catch (error) {
      this.send(connection, {
        version: 1,
        type: "error",
        messageId: envelope.messageId,
        code: error instanceof TransportError ? error.code : "PROTOCOL_ERROR",
      });
    }
  }
  private prune(): void {
    const now = Date.now();
    for (const [id, delivery] of this.deliveries) {
      if (!delivery.pending && delivery.expires <= now) this.deliveries.delete(id);
    }
  }
  private route(connection: Connection, envelope: Envelope): void {
    const sender = connection.registration!.participant;
    if (envelope.from !== sender.agentId) throw new TransportError("SENDER_MISMATCH");
    const target = this.participants.get(envelope.to);
    if (!target) throw new TransportError("UNKNOWN_TARGET");
    if (target.participant.groupId !== sender.groupId) throw new TransportError("FORBIDDEN");
    this.prune();
    const id = key(envelope.from, envelope.messageId);
    const fingerprint = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
    const previous = this.deliveries.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new TransportError("DUPLICATE_CONFLICT");
      this.send(connection, { version: 1, type: "accepted", messageId: envelope.messageId });
      if (previous.received)
        this.send(connection, { version: 1, type: "received", messageId: envelope.messageId });
      return;
    }
    if (!target.connection || target.connection.socket.destroyed)
      throw new TransportError("TARGET_DISCONNECTED");
    let request: Delivery | undefined;
    if (envelope.kind === "reply" || envelope.kind === "cancel") {
      const requester = envelope.kind === "reply" ? envelope.to : envelope.from;
      request = this.deliveries.get(key(requester, envelope.correlationId!));
      if (
        !request?.pending ||
        request.envelope.to !== (envelope.kind === "reply" ? envelope.from : envelope.to)
      ) {
        throw new TransportError("INVALID_CORRELATION");
      }
    }
    let reserved = 0;
    let senderPending = 0;
    for (const delivery of this.deliveries.values()) {
      if (delivery.pending) {
        reserved++;
        if (delivery.envelope.from === envelope.from) senderPending++;
      }
    }
    // Every request reserves a terminal reply/cancel slot. Events cannot consume it.
    const required = envelope.kind === "request" ? 2 : request ? 0 : 1;
    if (
      this.deliveries.size + reserved + required > this.limits.maxDedupeEntries ||
      (envelope.kind === "request" && senderPending >= this.limits.maxPending)
    ) {
      throw new TransportError("CAPACITY");
    }
    if (envelope.kind === "request" && envelope.timeoutMs! > this.limits.requestTimeoutMs) {
      throw new TransportError("PROTOCOL_ERROR");
    }
    // The bounded socket write is the acceptance boundary. It is not a receipt.
    if (!this.send(target.connection, { version: 1, type: "message", envelope })) {
      throw new TransportError("TARGET_DISCONNECTED");
    }
    const delivery: Delivery = {
      envelope: { from: envelope.from, to: envelope.to, messageId: envelope.messageId },
      fingerprint,
      expires: Date.now() + this.limits.dedupeTtlMs,
      received: false,
    };
    this.deliveries.set(id, delivery);
    if (envelope.kind === "request") {
      delivery.pending = setTimeout(
        () => this.finishRequest(delivery, "TIMEOUT"),
        envelope.timeoutMs,
      );
    }
    if (request) this.finishRequest(request, envelope.kind === "cancel" ? "CANCELLED" : undefined);
    this.send(connection, { version: 1, type: "accepted", messageId: envelope.messageId });
  }
  private finishRequest(delivery: Delivery, code?: ErrorCode): void {
    clearTimeout(delivery.pending);
    delivery.pending = undefined;
    if (code) {
      const sender = this.participants.get(delivery.envelope.from)?.connection;
      if (sender)
        this.send(sender, {
          version: 1,
          type: "error",
          messageId: delivery.envelope.messageId,
          code,
        });
    }
  }
  private disconnect(connection: Connection): void {
    clearTimeout(connection.timer);
    clearTimeout(connection.destroyTimer);
    connection.wire.stop();
    this.connections.delete(connection);
    const registration = connection.registration;
    if (!registration || registration.connection !== connection) return;
    registration.connection = undefined;
    for (const delivery of this.deliveries.values()) {
      if (
        delivery.pending &&
        (delivery.envelope.from === registration.participant.agentId ||
          delivery.envelope.to === registration.participant.agentId)
      )
        this.finishRequest(delivery, "TARGET_DISCONNECTED");
    }
    if (this.closed) return;
    for (const peer of this.connections) {
      if (peer.registration?.participant.groupId === registration.participant.groupId) {
        this.send(peer, {
          version: 1,
          type: "peer-disconnected",
          agentId: registration.participant.agentId,
        });
      }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    for (const delivery of this.deliveries.values()) clearTimeout(delivery.pending);
    this.deliveries.clear();
    for (const connection of this.connections) {
      clearTimeout(connection.timer);
      connection.wire.stop();
      this.send(connection, { version: 1, type: "shutdown" });
      this.endConnection(connection);
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.credentials.clear();
    this.participants.clear();
    await rm(this.directory, { recursive: true, force: true });
  }
}
