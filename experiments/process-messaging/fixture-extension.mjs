import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFrames, writeFrame } from "./broker.mjs";

// Real Pi agent loops and tools, but deterministic model output, no API calls.
export default function (pi) {
  let socket;
  let context;
  let releaseWork;
  const emit = (name, data = {}) => writeFrame(socket, { type: "event", name, data });

  pi.registerProvider("process-proof", {
    baseUrl: "http://127.0.0.1:1/never-used",
    apiKey: "fixture-not-a-secret",
    api: "openai-completions",
    models: [
      {
        id: "deterministic",
        name: "Process proof (no network)",
        reasoning: false,
        input: ["text"],
        contextWindow: 16_384,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, transcript) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = transcript.messages.at(-1);
        const text =
          typeof last?.content === "string"
            ? last.content
            : (last?.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        let tool;
        let args;
        let answer = "Proof turn complete.";
        if (last?.role === "user" && text === "PASA_KEYBOARD_TEST") {
          emit("keyboard-observed");
          answer = "Keyboard input observed.";
        } else if (last?.role === "user" && text.includes("PROOF_WORK")) {
          tool = "proof_work";
          args = {};
        } else if (last?.role === "user" && text.includes("PROOF_ASK")) {
          tool = "proof_send";
          args = { id: randomUUID(), kind: "question", to: "b", text: "What is 6 * 7?" };
        } else if (last?.role === "user" && text.includes("PROOF_MAIL ")) {
          const envelope = JSON.parse(text.slice(text.indexOf("PROOF_MAIL ") + 11));
          emit("model-observed", { envelope });
          if (envelope.kind === "question") {
            tool = "proof_send";
            args = {
              id: randomUUID(),
              kind: "reply",
              to: envelope.from,
              replyTo: envelope.id,
              text: "42",
            };
          } else {
            answer = `Correlated answer received: ${envelope.text}`;
          }
        }
        const output = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: tool ? "toolUse" : "stop",
          content: tool
            ? [{ type: "toolCall", id: randomUUID(), name: tool, arguments: args }]
            : [{ type: "text", text: answer }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "start", partial: output });
        if (tool)
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: output.content[0],
            partial: output,
          });
        else stream.push({ type: "text_end", contentIndex: 0, content: answer, partial: output });
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });

  pi.registerTool({
    name: "proof_work",
    label: "Proof work",
    description: "Wait at a controlled work boundary.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          releaseWork = undefined;
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(new Error("Work aborted"));
        const timer = setTimeout(
          () => finish(new Error("No message arrived while working")),
          15_000,
        );
        releaseWork = () => finish();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else emit("work-started");
      });
      emit("work-finished");
      return { content: [{ type: "text", text: "Controlled work finished." }], details: {} };
    },
  });
  pi.registerTool({
    name: "proof_send",
    label: "Proof send",
    description: "Send a question or correlated reply to the other Pi process.",
    parameters: Type.Object({
      id: Type.String(),
      to: Type.String(),
      kind: Type.Union([Type.Literal("question"), Type.Literal("reply")]),
      text: Type.String(),
      replyTo: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      writeFrame(socket, { type: "send", ...args });
      return {
        content: [{ type: "text", text: "Submitted to broker; not a delivery acknowledgment." }],
        details: {},
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    pi.setActiveTools(["proof_work", "proof_send"]);
    socket = connect(process.env.PI_PROOF_SOCKET);
    socket.on("error", (error) =>
      ctx.ui.notify(`Proof connection failed: ${error.message}`, "error"),
    );
    socket.on("close", () => ctx.ui.notify("Proof broker disconnected", "warning"));
    socket.on("connect", () =>
      writeFrame(socket, {
        type: "hello",
        token: process.env.PI_PROOF_TOKEN,
        peer: process.env.PI_PROOF_PEER,
        metadata: {
          pid: process.pid,
          cwd: ctx.cwd,
          mode: ctx.mode,
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile(),
          tools: pi.getActiveTools(),
          profile: "isolated-fixture; no project context, skills, guards or sandbox",
        },
      }),
    );
    readFrames(socket, (message) => {
      if (message.type === "deliver") {
        emit("received", { envelope: message.envelope, busy: !context.isIdle() });
        pi.sendMessage(
          {
            customType: "process-proof-mail",
            content: `PROOF_MAIL ${JSON.stringify(message.envelope)}`,
            display: true,
            details: message.envelope,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        // Delivery reaches a busy process immediately; the model sees it at the next safe boundary.
        releaseWork?.();
      } else if (message.type === "prompt") {
        pi.sendUserMessage(message.text, { deliverAs: "steer" });
      } else if (message.type === "shutdown") {
        ctx.shutdown();
      } else if (message.type === "rejected") {
        emit("failure", { reason: message.reason });
        ctx.ui.notify(message.reason, "error");
      }
    });
  });
  pi.on("agent_end", () => emit("agent-end"));
  pi.on("agent_settled", () => emit("agent-settled"));
  pi.on("session_shutdown", () => socket?.end());
}
