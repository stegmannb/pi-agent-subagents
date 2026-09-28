import type { Socket } from "node:net";
import { TextDecoder } from "node:util";
import { TransportError, type TransportLimits, type ErrorCode } from "./messaging-protocol.ts";

/** Bounded UTF-8 JSONL framing. Callbacks are synchronous; never await application work. */
export class JsonLineWire {
  private partial = Buffer.alloc(0);
  private stopped = false;
  private readonly socket: Socket;
  private readonly limits: TransportLimits;
  constructor(
    socket: Socket,
    limits: TransportLimits,
    receive: (value: unknown) => void,
    fail: (code: ErrorCode) => void,
  ) {
    this.socket = socket;
    this.limits = limits;
    socket.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      let start = 0;
      try {
        while (start < chunk.length && !this.stopped) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          if (this.partial.length + end - start > limits.maxFrameBytes) {
            throw new TransportError("FRAME_TOO_LARGE");
          }
          this.partial = Buffer.concat([this.partial, chunk.subarray(start, end)]);
          if (newline < 0) break;
          const text = new TextDecoder("utf-8", { fatal: true }).decode(this.partial);
          this.partial = Buffer.alloc(0);
          receive(JSON.parse(text));
          start = end + 1;
        }
      } catch (error) {
        this.stopped = true;
        this.partial = Buffer.alloc(0);
        fail(error instanceof TransportError ? error.code : "PROTOCOL_ERROR");
      }
    });
  }
  send(value: unknown): void {
    if (this.socket.destroyed || this.socket.writableEnded)
      throw new TransportError("DISCONNECTED");
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      throw new TransportError("PROTOCOL_ERROR");
    }
    if (!text) throw new TransportError("PROTOCOL_ERROR");
    const bytes = Buffer.byteLength(text);
    if (bytes > this.limits.maxFrameBytes) throw new TransportError("FRAME_TOO_LARGE");
    if (this.socket.writableLength + bytes + 1 > this.limits.maxQueueBytes) {
      throw new TransportError("CAPACITY");
    }
    this.socket.write(text + "\n");
  }
  stop(): void {
    this.stopped = true;
    this.partial = Buffer.alloc(0);
  }
}
