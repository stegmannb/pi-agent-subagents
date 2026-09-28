import assert from "node:assert/strict";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import test, { type TestContext } from "node:test";
import { LocalMessageBroker, type ParticipantCredential } from "./messaging-broker.ts";
import { LocalMessageClient } from "./messaging-client.ts";
import {
  DEFAULT_LIMITS,
  TransportError,
  type Envelope,
  type ErrorCode,
  type TransportLimits,
} from "./messaging-protocol.ts";
import { JsonLineWire } from "./messaging-wire.ts";

const code = (expected: ErrorCode) => (error: unknown) =>
  error instanceof TransportError && error.code === expected;
async function setup(t: TestContext, limits: Partial<TransportLimits> = {}) {
  const broker = await LocalMessageBroker.start(limits);
  const clients: LocalMessageClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await broker.close();
  });
  function register(agentId: string, parentId: string | null = null, groupId = "group") {
    return broker.register({ agentId, parentId, groupId, sessionId: `session-${agentId}` });
  }
  async function connect(agentId: string, parentId: string | null = null, groupId = "group") {
    const client = await LocalMessageClient.connect(register(agentId, parentId, groupId));
    clients.push(client);
    return client;
  }
  return { broker, register, connect };
}
function event(from: string, to: string, messageId = "message"): Envelope {
  return { version: 1, messageId, kind: "event", from, to, payload: "hello" };
}
async function raw(t: TestContext, socketPath: string) {
  const socket = createConnection(socketPath);
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  const frames: Record<string, any>[] = [];
  const waiters: ((frame: Record<string, any>) => void)[] = [];
  let partial = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    partial += chunk;
    for (;;) {
      const end = partial.indexOf("\n");
      if (end < 0) break;
      const frame = JSON.parse(partial.slice(0, end));
      partial = partial.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  await once(socket, "connect");
  const next = async (): Promise<Record<string, any>> => {
    if (frames.length) return frames.shift()!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("raw frame deadline")), 2000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  };
  const send = (frame: unknown) => socket.write(JSON.stringify(frame) + "\n");
  return {
    socket,
    next,
    send,
    async hello(credential: ParticipantCredential) {
      send({ version: 1, type: "hello", capability: credential.capability });
      return next();
    },
  };
}

test("private socket, immutable identities, per-participant capabilities and registration limits", async (t) => {
  const { broker, register } = await setup(t, { maxParticipants: 2 });
  assert.ok(Buffer.byteLength(broker.socketPath) < 100);
  assert.equal((await stat(dirname(broker.socketPath))).mode & 0o777, 0o700);
  assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
  const parent = register("parent");
  const child = register("child", "parent");
  assert.notEqual(parent.capability, child.capability);
  assert.equal(parent.capability.length, 64);
  assert.throws(() => register("third"), code("CAPACITY"));
  assert.throws(() => register("parent"), code("DUPLICATE_CONFLICT"));
  await assert.rejects(
    LocalMessageClient.connect({ ...parent, capability: "bad" }),
    code("AUTH_FAILED"),
  );
  const client = await LocalMessageClient.connect(parent);
  t.after(() => client.close());
  assert.deepEqual(client.participant, {
    groupId: "group",
    agentId: "parent",
    parentId: null,
    sessionId: "session-parent",
  });
  await assert.rejects(LocalMessageClient.connect(parent), code("ALREADY_CONNECTED"));
  await broker.close();
  await assert.rejects(stat(broker.socketPath), { code: "ENOENT" });
  assert.throws(() => register("later"), code("BROKER_CLOSED"));
});

test("parent-child and siblings communicate; replies bypass the inbox and pending model work", async (t) => {
  const { connect } = await setup(t);
  const parent = await connect("parent");
  const a = await connect("a", "parent");
  const b = await connect("b", "parent");
  const answer = parent.request("a", { taskId: "task-7" });
  const request = await a.nextMessage();
  const siblingAnswer = a.request("b", "question");
  const siblingRequest = await b.nextMessage();
  await b.reply(siblingRequest, "sibling reply").received;
  assert.equal((await siblingAnswer).payload, "sibling reply");
  await a.reply(request, "complete").received;
  assert.equal((await answer).payload, "complete");
  const progress = a.event("parent", "progress");
  await progress.accepted;
  await progress.received;
  assert.equal((await parent.nextMessage()).payload, "progress");
  await assert.rejects(parent.nextMessage(15), code("TIMEOUT"));
});

test("unknown, foreign, disconnected targets and forged senders are rejected without blocking peers", async (t) => {
  const { connect, register } = await setup(t);
  const a = await connect("a");
  const b = await connect("b");
  await connect("foreign", null, "other");
  register("offline");
  assert.throws(() => register("bad-parent", "foreign"), code("FORBIDDEN"));
  await assert.rejects(a.event("missing", null).accepted, code("UNKNOWN_TARGET"));
  await assert.rejects(a.event("foreign", null).accepted, code("FORBIDDEN"));
  await assert.rejects(a.event("offline", null).accepted, code("TARGET_DISCONNECTED"));
  await assert.rejects(a.send(event("b", "a")).accepted, code("SENDER_MISMATCH"));
  await a.event("b", "still works").received;
  assert.equal((await b.nextMessage()).payload, "still works");
});

test("acceptance, receipt and reply are separate protocol stages", async (t) => {
  const { broker, register, connect } = await setup(t);
  const a = await connect("a");
  const credential = register("b");
  const b = await raw(t, broker.socketPath);
  assert.equal((await b.hello(credential)).type, "ready");
  const handle = a.send(event("a", "b"));
  let received = false;
  void handle.received.then(() => {
    received = true;
  });
  await handle.accepted;
  const delivery = await b.next();
  assert.equal(delivery.type, "message");
  assert.equal(received, false);
  b.send({ version: 1, type: "received", messageId: "message", from: "a" });
  await handle.received;
  assert.equal(received, true);
});

test("JSONL accepts fragmented UTF-8 and multiple frames per chunk", async (t) => {
  const { broker, register, connect } = await setup(t);
  const credential = register("a");
  const b = await connect("b");
  const a = await raw(t, broker.socketPath);
  await a.hello(credential);
  const first = {
    version: 1,
    type: "send",
    envelope: { ...event("a", "b", "first"), payload: "Grüße 🌲" },
  };
  const bytes = Buffer.from(JSON.stringify(first) + "\n");
  const split = bytes.indexOf(Buffer.from("🌲")) + 1;
  a.socket.write(bytes.subarray(0, split));
  a.socket.write(
    Buffer.concat([
      bytes.subarray(split),
      Buffer.from(
        JSON.stringify({ version: 1, type: "send", envelope: event("a", "b", "second") }) + "\n",
      ),
    ]),
  );
  assert.equal((await b.nextMessage()).payload, "Grüße 🌲");
  assert.equal((await b.nextMessage()).messageId, "second");
});

test("malformed, unsupported, invalid UTF-8 and oversized frames close only the offender", async (t) => {
  const { broker, connect } = await setup(t, { maxFrameBytes: 1024 });
  const a = await connect("a");
  const b = await connect("b");
  for (const [bytes, expected] of [
    [Buffer.from("{broken\n"), "PROTOCOL_ERROR"],
    [Buffer.from('{"version":2}\n'), "PROTOCOL_ERROR"],
    [Buffer.from([0xff, 10]), "PROTOCOL_ERROR"],
    [Buffer.alloc(1025, 65), "FRAME_TOO_LARGE"],
  ] as const) {
    const offender = await raw(t, broker.socketPath);
    const closed = once(offender.socket, "close");
    offender.socket.write(bytes);
    assert.equal((await offender.next()).code, expected);
    await closed;
  }
  await a.event("b", "healthy").received;
  assert.equal((await b.nextMessage()).payload, "healthy");
  await assert.rejects(a.event("b", "x".repeat(1024)).accepted, code("FRAME_TOO_LARGE"));
});

test("dedupe replays acknowledgments, rejects conflicts, bounds retention and expires", async (t) => {
  const { connect } = await setup(t, { maxDedupeEntries: 1, dedupeTtlMs: 1000 });
  const a = await connect("a");
  const b = await connect("b");
  const message = event("a", "b");
  await a.send(message).received;
  await b.nextMessage();
  await a.send(message).received;
  await assert.rejects(b.nextMessage(10), code("TIMEOUT"));
  await assert.rejects(
    a.send({ ...message, payload: "conflict" }).accepted,
    code("DUPLICATE_CONFLICT"),
  );
  await assert.rejects(a.event("b", "full").accepted, code("CAPACITY"));
  const later = Date.now() + 1001;
  t.mock.method(Date, "now", () => later);
  await a.send(message).received;
  assert.equal((await b.nextMessage()).messageId, message.messageId);
});

test("wrong correlations and wrong respondents cannot resolve requests; parallel replies match IDs", async (t) => {
  const { connect } = await setup(t);
  const a = await connect("a");
  const b = await connect("b");
  const c = await connect("c");
  const pending = Array.from({ length: 12 }, (_, i) => a.request("b", i));
  const incoming = await Promise.all(pending.map(() => b.nextMessage()));
  await assert.rejects(
    b.send({ ...event("b", "a"), kind: "reply", correlationId: "wrong" }).accepted,
    code("INVALID_CORRELATION"),
  );
  await assert.rejects(
    c.send({ ...event("c", "a"), kind: "reply", correlationId: incoming[0].messageId }).accepted,
    code("INVALID_CORRELATION"),
  );
  for (const request of incoming.toReversed()) await b.reply(request, request.payload).received;
  assert.deepEqual(
    (await Promise.all(pending)).map((reply) => reply.payload),
    Array.from({ length: 12 }, (_, i) => i),
  );
});

test("timeouts, cancel, own disconnect, target disconnect and shutdown settle pending requests", async (t) => {
  const { broker, connect } = await setup(t);
  const a = await connect("a");
  const b = await connect("b");
  const expired = a.request("b", null, { timeoutMs: 15 });
  const old = await b.nextMessage();
  await assert.rejects(expired, code("TIMEOUT"));
  // Allow the broker deadline, started after the local deadline, to expire too.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(b.reply(old, "late").accepted, code("INVALID_CORRELATION"));
  const cancelled = a.request("b", null, { messageId: "cancel-me" });
  await b.nextMessage();
  await a.cancel("b", "cancel-me").received;
  await assert.rejects(cancelled, code("CANCELLED"));
  assert.equal((await b.nextMessage()).kind, "cancel");
  const disconnected = a.request("b", null);
  await b.nextMessage();
  b.close();
  await assert.rejects(disconnected, code("TARGET_DISCONNECTED"));
  const c = await connect("c");
  const own = c.request("a", null);
  await a.nextMessage();
  c.close();
  await assert.rejects(own, code("DISCONNECTED"));
  const ending = a.request("a", "self");
  const inbox = a.nextMessage();
  await inbox;
  const waiting = a.nextMessage();
  await broker.close();
  await assert.rejects(ending, code("BROKER_CLOSED"));
  await assert.rejects(waiting, code("BROKER_CLOSED"));
});

test("broker disappearance rejects open calls without reconnecting", async (t) => {
  const { broker, connect } = await setup(t);
  const a = await connect("a");
  // A proxy lets the test sever a broker connection without exposing test-only production APIs.
  const path = `${dirname(broker.socketPath)}/proxy`;
  const sockets: Socket[] = [];
  const proxy = createServer((client) => {
    const upstream = createConnection(broker.socketPath);
    sockets.push(client, upstream);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => proxy.listen(path, resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });
  const credential = broker.register({
    groupId: "group",
    agentId: "proxy",
    parentId: null,
    sessionId: "proxy-session",
  });
  const client = await LocalMessageClient.connect({ ...credential, socketPath: path });
  t.after(() => client.close());
  const result = client.request("a", null);
  await a.nextMessage();
  for (const socket of sockets) socket.destroy();
  await assert.rejects(result, code("BROKER_DISCONNECTED"));
});

test("bounded inbox and pending state isolate an unconsumed participant", async (t) => {
  const { connect } = await setup(t, { maxInboxMessages: 1, maxPending: 2 });
  const a = await connect("a");
  const b = await connect("b");
  const c = await connect("c");
  await a.event("b", "fills inbox").received;
  await assert.rejects(a.event("b", "overflow").received, code("TARGET_DISCONNECTED"));
  assert.throws(() => b.nextMessage(), code("CAPACITY"));
  await a.event("c", "healthy").received;
  await c.nextMessage();
  const first = a.request("c", null);
  await c.nextMessage();
  const second = a.request("c", null);
  await c.nextMessage();
  assert.throws(() => a.request("c", null), code("CAPACITY"));
  a.close();
  await assert.rejects(first, code("DISCONNECTED"));
  await assert.rejects(second, code("DISCONNECTED"));
});

test("wire rejects writes above queue budget before allocating an unbounded write queue", () => {
  let writes = 0;
  const socket = {
    on() {},
    destroyed: false,
    writableEnded: false,
    writableLength: DEFAULT_LIMITS.maxQueueBytes,
    write() {
      writes++;
    },
  } as unknown as Socket;
  const wire = new JsonLineWire(
    socket,
    { ...DEFAULT_LIMITS },
    () => {},
    () => {},
  );
  assert.throws(() => wire.send({ version: 1 }), code("CAPACITY"));
  assert.equal(writes, 0);
});

test("authentication deadline, unauthenticated sends and forged receipts are rejected", async (t) => {
  const { broker, register, connect } = await setup(t, { handshakeTimeoutMs: 20 });
  const idle = await raw(t, broker.socketPath);
  assert.equal((await idle.next()).code, "TIMEOUT");
  const unauthenticated = await raw(t, broker.socketPath);
  unauthenticated.send({ version: 1, type: "send", envelope: event("a", "b") });
  assert.equal((await unauthenticated.next()).code, "AUTH_FAILED");
  const a = await connect("a");
  const b = await connect("b");
  const credential = register("liar");
  const liar = await raw(t, broker.socketPath);
  await liar.hello(credential);
  await a.send(event("a", "b")).received;
  await b.nextMessage();
  liar.send({ version: 1, type: "received", messageId: "message", from: "a" });
  assert.equal((await liar.next()).code, "INVALID_CORRELATION");
});

test("a full dedupe budget preserves the reply or cancel slot for an admitted request", async (t) => {
  for (const terminal of ["reply", "cancel"] as const) {
    const { connect } = await setup(t, { maxDedupeEntries: 2 });
    const a = await connect("a");
    const b = await connect("b");
    const result = a.request("b", null);
    const request = await b.nextMessage();
    await assert.rejects(a.event("b", "no free slot").accepted, code("CAPACITY"));
    if (terminal === "reply") {
      await b.reply(request, "answer").received;
      assert.equal((await result).payload, "answer");
    } else {
      await a.cancel("b", request.messageId).received;
      await assert.rejects(result, code("CANCELLED"));
      assert.equal((await b.nextMessage()).kind, "cancel");
    }
  }
});

test("fatal cleanup and broker shutdown have absolute deadlines despite continued peer writes", async (t) => {
  for (const fatal of [true, false]) {
    const { broker } = await setup(t);
    const socket = createConnection({ path: broker.socketPath, allowHalfOpen: true });
    t.after(() => socket.destroy());
    socket.on("error", () => {});
    socket.resume();
    await once(socket, "connect");
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    const interval = setInterval(() => {
      if (!socket.destroyed) socket.write("{}\n");
    }, 5);
    t.after(() => clearInterval(interval));
    const deadline = setTimeout(() => socket.destroy(new Error("cleanup deadline exceeded")), 1000);
    t.after(() => clearTimeout(deadline));
    const started = performance.now();
    if (fatal) socket.write("{invalid\n");
    else await broker.close();
    await closed;
    clearInterval(interval);
    clearTimeout(deadline);
    assert.ok(
      performance.now() - started < 900,
      "traffic must not extend cleanup to the test deadline",
    );
  }
});

test("an unread raw socket exhausts only its own write queue and healthy peers still communicate", async (t) => {
  const { broker, register, connect } = await setup(t, { maxQueueBytes: 128 * 1024 });
  const a = await connect("a");
  const c = await connect("c");
  const credential = register("slow");
  const slow = await raw(t, broker.socketPath);
  await slow.hello(credential);
  slow.socket.pause();
  let disconnected = false;
  for (let i = 0; i < 200; i++) {
    try {
      await a.event("slow", "x".repeat(32 * 1024)).accepted;
    } catch (error) {
      assert.ok(code("TARGET_DISCONNECTED")(error));
      disconnected = true;
      break;
    }
  }
  assert.equal(disconnected, true);
  await a.event("c", "healthy").received;
  assert.equal((await c.nextMessage()).payload, "healthy");
});
