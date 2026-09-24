import { EventEmitter } from "node:events";
import { chmodSync } from "node:fs";
import { createServer } from "node:net";

// Deliberately local and ephemeral. This is not a durable production mailbox.
export function readFrames(socket, receive) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 64 * 1024) return socket.destroy();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        receive(JSON.parse(line));
      } catch {
        socket.destroy();
        return;
      }
    }
  });
}

export function writeFrame(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

export class Broker extends EventEmitter {
  peers = new Map();
  sockets = new Set();
  questions = new Map();
  ids = new Set();
  events = [];

  constructor(socketPath, token) {
    super();
    this.path = socketPath;
    this.token = token;
    this.server = createServer((socket) => this.accept(socket));
  }

  record(event) {
    const entry = { ...event, seq: this.events.length, at: new Date().toISOString() };
    this.events.push(entry);
    this.emit("record", entry);
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, resolve);
    });
    chmodSync(this.path, 0o600);
  }

  accept(socket) {
    this.sockets.add(socket);
    let peer;
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (peer) {
        this.peers.delete(peer);
        this.record({ type: "disconnected", peer });
      }
    });
    readFrames(socket, (message) => {
      const reject = (reason) => {
        writeFrame(socket, { type: "rejected", reason });
        this.record({ type: "rejected", peer, reason });
      };
      if (!peer) {
        if (
          message.type !== "hello" ||
          message.token !== this.token ||
          !["a", "b"].includes(message.peer) ||
          this.peers.has(message.peer)
        ) {
          reject("invalid registration");
          socket.end();
          return;
        }
        peer = message.peer;
        this.peers.set(peer, socket);
        this.record({ type: "registered", peer, metadata: message.metadata });
        writeFrame(socket, { type: "registered" });
        return;
      }
      if (message.type === "event") {
        this.record({ type: "event", peer, name: message.name, data: message.data });
        return;
      }
      if (
        message.type !== "send" ||
        !["question", "reply"].includes(message.kind) ||
        typeof message.id !== "string" ||
        !message.id ||
        this.ids.has(message.id) ||
        typeof message.text !== "string" ||
        !this.peers.has(message.to) ||
        message.to === peer
      ) {
        reject("invalid message, duplicate ID, or unavailable recipient");
        return;
      }
      if (message.kind === "reply") {
        const question = this.questions.get(message.replyTo);
        if (!question || question.from !== message.to || question.to !== peer) {
          reject("reply does not match an open question");
          return;
        }
        this.questions.delete(message.replyTo);
      } else {
        this.questions.set(message.id, { from: peer, to: message.to });
      }
      this.ids.add(message.id);
      // Bind sender identity to the connection, never to a model-supplied field.
      const envelope = {
        id: message.id,
        kind: message.kind,
        from: peer,
        to: message.to,
        text: message.text,
        ...(message.kind === "reply" ? { replyTo: message.replyTo } : {}),
      };
      writeFrame(this.peers.get(message.to), { type: "deliver", envelope });
      this.record({ type: "routed", envelope });
    });
  }

  waitFor(predicate, timeout = 20_000) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.off("record", listener);
        resolve(event);
      };
      const timer = setTimeout(() => {
        this.off("record", listener);
        reject(new Error("Timed out waiting for proof event"));
      }, timeout);
      this.on("record", listener);
    });
  }

  command(peer, message) {
    const socket = this.peers.get(peer);
    if (!socket) throw new Error(`Peer ${peer} is unavailable`);
    writeFrame(socket, message);
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
