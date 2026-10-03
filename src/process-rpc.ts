import type { ProcessDialogRequest, ProcessDialogResponse } from "./process-dialog.ts";
import { osProcessIdentity } from "./process-os-identity.ts";
import {
  qualificationTiming,
  validateQualificationPreset,
  type QualificationPreset,
} from "./process-qualification.ts";
import {
  isInspectionDiagnostic,
  diagnosticFrameBytes,
  diagnosticInspectionLimit,
  diagnosticProcessLimit,
  diagnosticHistoryLimit,
  type InspectionDiagnostic,
  type InspectionSink,
  type InspectionStage,
} from "./process-inspection-diagnostic.ts";
/** Pi 0.73.0 JSONL transport. This is not a protection capture/launch adapter. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ResultDeliveryTimeoutError } from "./process-results.ts";
import { readChildFailureExitStatus, type ChildFailurePhase } from "./process-child-failure.ts";
import type {
  AgentSessionEvent,
  RpcCommand,
  RpcResponse,
  RpcSessionState,
} from "@mariozechner/pi-coding-agent";

export class ProcessRpcError extends Error {
  readonly code: string;
  readonly phase?:
    | RpcCommand["type"]
    | "startup:get_state"
    | "inspect"
    | "verifyReady"
    | ChildFailurePhase;
  constructor(code: string, phase?: ProcessRpcError["phase"]) {
    super(`Pi RPC failed: ${code}${phase ? ` [${phase}]` : ""}`);
    this.name = "ProcessRpcError";
    this.code = code;
    this.phase = phase;
  }
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export interface ProcessRpcOptions {
  processId?: string;
  onSpawn?: (process: ProcessRpc) => Promise<void>;
  beforeMutation?: (
    action: "steer" | "abort" | "signal" | "cleanup" | "dialog" | "parent-exiting",
  ) => void;
  onExit?: (code: string) => void;
  onDialog?: (request: ProcessDialogRequest, signal: AbortSignal) => Promise<ProcessDialogResponse>;
  executable: string;
  args: string[];
  cwd: string;
  /** Already materialized explicit environment. Never merged with process.env. */
  environment: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /** Trusted private bootstrap qualification; never changes ordinary request deadlines. */
  qualificationPreset?: QualificationPreset;
  /** Overrides only the first get_state response deadline, never readiness verification. */
  startupTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Trusted host callback only; absent means no diagnostic frames are requested. */
  onInspectionDiagnostic?: InspectionSink;
  onEvent?: (event: AgentSessionEvent | Record<string, unknown>) => void;
  /** Trusted bootstrap verifies resource/protection/tool/role readiness out of band.
   * get_state alone is NOT proof. Missing/rejected verification forbids prompts.
   */
  verifyReady: (state: RpcSessionState, pid: number, proof?: unknown) => Promise<void>;
  /** Private Node IPC bootstrap; contains references and broker capability, never auth values. */
  bootstrapData?: unknown;
}
interface Pending {
  command: string;
  result: Deferred<unknown>;
  timer: NodeJS.Timeout;
}
interface Run {
  result: Deferred<string>;
  submitted: boolean;
  started: boolean;
  ended: boolean;
  acknowledged: boolean;
  assistant?: Record<string, unknown>;
  turns: number;
  maxTurns: number;
  managed: boolean;
  delivered: boolean;
}

export class ProcessRpc {
  readonly processId: string;
  readonly pid: number;
  private readonly osIdentity?: string;
  private readonly ipcDialogs = new Set<string>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: ProcessRpcOptions;
  private readonly timing: ReturnType<typeof qualificationTiming>;
  private readonly closed = deferred<void>();
  private readonly pending = new Map<string, Pending>();
  private partial = Buffer.alloc(0);
  private failure?: ProcessRpcError;
  private ready = false;
  private run?: Run;
  private killTimer?: NodeJS.Timeout;
  private termTimer?: NodeJS.Timeout;
  private readonly dialogs = new Map<string, AbortController>();
  private stopping = false;
  private readonly stopRefused = deferred<void>();
  get alive(): boolean {
    return (
      this.pid > 0 &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.closedResolved
    );
  }
  private closedResolved = false;
  private diagnosticCount = 0;
  private readonly diagnosticHistory: InspectionDiagnostic[] = [];
  private readonly diagnosticRequests = new Map<
    string,
    { stage: InspectionStage; count: number; completed: boolean }
  >();
  /** Copies only fixed observations; does not expose private request identifiers. */
  getInspectionDiagnostics(): readonly InspectionDiagnostic[] {
    return this.diagnosticHistory.map((record) => ({ ...record }));
  }
  private observe(record: InspectionDiagnostic): void {
    if (!this.options.onInspectionDiagnostic) return;
    const fixed = Object.freeze({ ...record });
    if (this.diagnosticHistory.length === diagnosticHistoryLimit) this.diagnosticHistory.shift();
    this.diagnosticHistory.push(fixed);
    try {
      this.options.onInspectionDiagnostic(fixed);
    } catch {
      /* No change to readiness. */
    }
  }
  private receiveDiagnostic(message: Record<string, unknown>): void {
    if (
      !this.options.onInspectionDiagnostic ||
      Buffer.byteLength(JSON.stringify(message)) >
        Math.min(diagnosticFrameBytes, this.options.maxFrameBytes ?? 4_194_304) ||
      Object.keys(message).length !== 3 ||
      typeof message.id !== "string" ||
      !isInspectionDiagnostic(message.record)
    )
      throw new ProcessRpcError("CONTROL_DIAGNOSTIC_INVALID");
    const request = this.diagnosticRequests.get(message.id);
    if (
      !request ||
      request.stage !== message.record.stage ||
      message.record.phase === "request" ||
      (request.completed && !(message.record.phase === "return" && message.record.event === "end"))
    )
      throw new ProcessRpcError("CONTROL_DIAGNOSTIC_INVALID");
    if (
      ++request.count > diagnosticInspectionLimit ||
      ++this.diagnosticCount > diagnosticProcessLimit
    )
      throw new ProcessRpcError("CONTROL_DIAGNOSTIC_LIMIT");
    this.observe(message.record);
  }

  private constructor(options: ProcessRpcOptions) {
    this.options = options;
    this.processId = options.processId ?? randomUUID();
    this.timing = qualificationTiming(options.qualificationPreset);
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.environment,
      stdio:
        options.bootstrapData === undefined
          ? ["pipe", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe", "ipc"],
    }) as ChildProcessWithoutNullStreams;
    this.pid = this.child.pid ?? 0;
    if (options.bootstrapData !== undefined) {
      this.child.on("message", (message) => {
        if (this.failure) return;
        try {
          if (object(message) && message.type === "inspection_diagnostic") {
            this.receiveDiagnostic(message);
            return;
          }
          if (Buffer.byteLength(JSON.stringify(message)) > (options.maxFrameBytes ?? 4_194_304))
            throw new ProcessRpcError("CONTROL_FRAME_TOO_LARGE");
          if (object(message) && message.type === "dialog_request" && object(message.request)) {
            if (typeof message.request.id !== "string")
              throw new ProcessRpcError("DIALOG_PROTOCOL_ERROR");
            this.ipcDialogs.add(message.request.id);
            this.frame(message.request);
            return;
          }
          if (
            object(message) &&
            message.type === "dialog_cancel" &&
            typeof message.id === "string"
          ) {
            this.dialogs.get(message.id)?.abort();
            this.ipcDialogs.delete(message.id);
            return;
          }
          if (!object(message) || message.type !== "inspection" || typeof message.id !== "string")
            throw new ProcessRpcError("CONTROL_PROTOCOL_ERROR");
          const pending = this.pending.get(message.id);
          if (!pending || pending.command !== "inspect")
            throw new ProcessRpcError("CONTROL_RESPONSE_MISMATCH");
          const diagnostic = this.diagnosticRequests.get(message.id);
          if (diagnostic) diagnostic.completed = true;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.success !== true)
            pending.result.reject(new ProcessRpcError("CHILD_NOT_READY"));
          else pending.result.resolve(message.proof);
        } catch (error) {
          this.fail(error instanceof ProcessRpcError ? error.code : "CONTROL_PROTOCOL_ERROR");
        }
      });
      this.child.send?.({ type: "bootstrap", data: options.bootstrapData }, (error) => {
        if (error) this.failTransport("BOOTSTRAP_FAILED");
      });
    }
    this.osIdentity = osProcessIdentity(this.pid);
    this.child.on("error", () => this.fail("SPAWN_FAILED"));
    this.child.stdin.on("error", () => this.failTransport("STDIN_FAILED"));
    // Drain stderr without retaining, forwarding or persisting credential-bearing diagnostics.
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.on("close", (status, signal) => {
      this.closedResolved = true;
      if (this.termTimer) clearTimeout(this.termTimer);
      if (this.killTimer) clearTimeout(this.killTimer);
      const diagnostic =
        options.bootstrapData !== undefined && signal === null
          ? readChildFailureExitStatus(status)
          : undefined;
      this.fail(diagnostic?.code ?? "PROCESS_EXITED", diagnostic?.phase);
      try {
        options.onExit?.(diagnostic?.code ?? "PROCESS_EXITED");
      } catch {
        /* Identity refusal never targets another run. */
      }
      this.closed.resolve();
    });
  }

  static async start(options: ProcessRpcOptions): Promise<ProcessRpc> {
    const preset = validateQualificationPreset(options.qualificationPreset);
    if (preset && options.bootstrapData === undefined)
      throw new ProcessRpcError("PRIVATE_BOOTSTRAP_REQUIRED");
    if (
      options.startupTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.startupTimeoutMs) ||
        options.startupTimeoutMs < 1 ||
        options.startupTimeoutMs > 120_000)
    )
      throw new ProcessRpcError("INVALID_LIMIT");
    for (const n of [options.requestTimeoutMs ?? 10_000, options.maxFrameBytes ?? 4_194_304]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new ProcessRpcError("INVALID_LIMIT");
    }
    if (
      options.onInspectionDiagnostic !== undefined &&
      typeof options.onInspectionDiagnostic !== "function"
    )
      throw new ProcessRpcError("INVALID_DIAGNOSTIC_SINK");
    if (typeof options.verifyReady !== "function") throw new ProcessRpcError("READINESS_REQUIRED");
    if (
      options.bootstrapData !== undefined &&
      Buffer.byteLength(JSON.stringify({ type: "bootstrap", data: options.bootstrapData })) >
        (options.maxFrameBytes ?? 4_194_304)
    )
      throw new ProcessRpcError("BOOTSTRAP_TOO_LARGE");
    const client = new ProcessRpc(options);
    try {
      await options.onSpawn?.(client);
      const state = await client.readState(options.startupTimeoutMs, "startup:get_state");
      // Pi retries model failures by default. Never issue any retry from this transport.
      await client.request({ type: "set_auto_retry", enabled: false });
      const verification = deferred<void>();
      const timer = setTimeout(
        () => verification.reject(new ProcessRpcError("READINESS_TIMEOUT", "verifyReady")),
        client.timing?.readinessMs ?? options.requestTimeoutMs ?? 10_000,
      );
      try {
        void options
          .verifyReady(state, client.pid, await client.inspect("startup"))
          .then(verification.resolve, verification.reject);
        await Promise.race([
          verification.promise,
          client.closed.promise.then(() => {
            throw client.failure ?? new ProcessRpcError("PROCESS_EXITED");
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (client.failure) throw client.failure;
      client.ready = true;
      return client;
    } catch (error) {
      await client.close();
      throw error instanceof ProcessRpcError ? error : new ProcessRpcError("READINESS_REJECTED");
    }
  }

  private fail(code: string, phase?: ProcessRpcError["phase"]): void {
    if (this.failure) return;
    this.failure = new ProcessRpcError(code, phase);
    this.ready = false;
    this.partial = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.result.reject(this.failure);
    }
    this.pending.clear();
    this.run?.result.reject(this.failure);
    for (const dialog of this.dialogs.values()) dialog.abort();
    this.dialogs.clear();
    this.stopOwned();
  }

  private failTransport(code: string): void {
    // Pipe loss from an already exited OS child must not mask its fixed exit diagnostic.
    // A genuinely live original process with a broken pipe still fails immediately.
    if (this.alive && this.osIdentity && osProcessIdentity(this.pid) === this.osIdentity)
      this.fail(code);
  }

  private authorize(
    action: "steer" | "abort" | "signal" | "cleanup" | "dialog" | "parent-exiting",
  ): boolean {
    try {
      if (this.alive && (!this.osIdentity || osProcessIdentity(this.pid) !== this.osIdentity))
        throw new ProcessRpcError("PROCESS_IDENTITY_UNPROVEN");
      this.options.beforeMutation?.(action);
      return true;
    } catch (error) {
      this.emit({
        type:
          error instanceof ProcessRpcError && error.code === "PROCESS_OWNERSHIP_CHANGED"
            ? "process_ownership_changed"
            : "process_identity_uncertain",
        action,
      });
      return false;
    }
  }
  private stopOwned(): void {
    if (this.stopping || !this.alive) return;
    if (!this.authorize("abort")) {
      this.detach();
      this.stopRefused.resolve();
      return;
    }
    this.stopping = true;
    // Cooperative cancellation first. No ack barrier may prevent bounded termination.
    if (this.run)
      this.child.stdin.write(JSON.stringify({ type: "abort", id: randomUUID() }) + "\n");
    this.termTimer = setTimeout(() => {
      if (!this.alive) return;
      if (!this.authorize("signal")) {
        this.detach();
        this.stopRefused.resolve();
        return;
      }
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => {
        if (this.alive) {
          if (this.authorize("signal")) this.child.kill("SIGKILL");
          else {
            this.detach();
            this.stopRefused.resolve();
          }
        }
      }, 1000);
      this.killTimer.unref();
    }, 100);
    this.termTimer.unref();
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    let start = 0;
    try {
      while (start < chunk.length && !this.failure) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (this.partial.length + end - start > (this.options.maxFrameBytes ?? 4_194_304)) {
          throw new ProcessRpcError("FRAME_TOO_LARGE");
        }
        this.partial = Buffer.concat([this.partial, chunk.subarray(start, end)]);
        if (newline < 0) break;
        const line = new TextDecoder("utf-8", { fatal: true }).decode(this.partial);
        this.partial = Buffer.alloc(0);
        this.frame(JSON.parse(line));
        start = end + 1;
      }
    } catch (error) {
      this.fail(error instanceof ProcessRpcError ? error.code : "PROTOCOL_ERROR");
    }
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      this.fail("EVENT_HANDLER_FAILED");
    }
  }

  private frame(frame: unknown): void {
    if (!object(frame) || typeof frame.type !== "string")
      throw new ProcessRpcError("PROTOCOL_ERROR");
    if (frame.type === "response") {
      const pending = typeof frame.id === "string" ? this.pending.get(frame.id) : undefined;
      if (!pending || frame.command !== pending.command || typeof frame.success !== "boolean") {
        throw new ProcessRpcError("RESPONSE_MISMATCH");
      }
      this.pending.delete(frame.id as string);
      clearTimeout(pending.timer);
      if (!frame.success) pending.result.reject(new ProcessRpcError("COMMAND_REJECTED"));
      else pending.result.resolve((frame as unknown as RpcResponse & { data?: unknown }).data);
      return;
    }
    if (frame.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor", "custom"].includes(frame.method as string)) {
        if (typeof frame.id !== "string" || this.dialogs.has(frame.id) || this.dialogs.size >= 16)
          throw new ProcessRpcError("DIALOG_PROTOCOL_ERROR");
        if (!["select", "confirm", "input"].includes(frame.method as string)) {
          this.emit({
            type: "process_dialog_unsupported",
            requestId: frame.id,
            method: frame.method,
          });
          this.fail("CUSTOM_TUI_UNSUPPORTED");
          return;
        }
        if (
          typeof frame.title !== "string" ||
          (frame.method === "confirm" && typeof frame.message !== "string") ||
          (frame.method === "select" &&
            (!Array.isArray(frame.options) || frame.options.some((v) => typeof v !== "string"))) ||
          (frame.timeout !== undefined &&
            (!Number.isSafeInteger(frame.timeout) || (frame.timeout as number) < 1))
        )
          throw new ProcessRpcError("DIALOG_PROTOCOL_ERROR");
        const controller = new AbortController();
        this.dialogs.set(frame.id, controller);
        this.emit({
          type: "process_dialog_pending",
          request: frame,
          blocked: !this.options.onDialog,
        });
        let timer: NodeJS.Timeout | undefined;
        if (frame.timeout !== undefined)
          timer = setTimeout(() => controller.abort(), frame.timeout as number);
        const finish = () => {
          if (timer) clearTimeout(timer);
          this.dialogs.delete(frame.id as string);
          this.ipcDialogs.delete(frame.id as string);
          this.emit({ type: "process_dialog_finished", requestId: frame.id });
        };
        controller.signal.addEventListener("abort", finish, { once: true });
        if (this.options.onDialog)
          void this.options
            .onDialog(frame as unknown as ProcessDialogRequest, controller.signal)
            .then(
              (response) => {
                if (
                  controller.signal.aborted ||
                  this.failure ||
                  !this.dialogs.has(frame.id as string)
                )
                  return;
                if (
                  response.id !== frame.id ||
                  response.type !== "extension_ui_response" ||
                  !(
                    ("cancelled" in response && response.cancelled === true) ||
                    (frame.method === "confirm" &&
                      "confirmed" in response &&
                      typeof response.confirmed === "boolean") ||
                    (frame.method !== "confirm" &&
                      "value" in response &&
                      typeof response.value === "string" &&
                      (frame.method !== "select" ||
                        (frame.options as string[]).includes(response.value)))
                  )
                ) {
                  this.fail("DIALOG_RESPONSE_INVALID");
                  return;
                }
                if (!this.authorize("dialog")) {
                  controller.abort();
                  return;
                }
                if (this.ipcDialogs.delete(response.id))
                  this.child.send?.({ type: "dialog_response", response }, (error) => {
                    if (error) this.fail("DIALOG_CHANNEL_FAILED");
                  });
                else this.child.stdin.write(JSON.stringify(response) + "\n");
                finish();
              },
              () => {
                if (!controller.signal.aborted) this.fail("DIALOG_CHANNEL_FAILED");
              },
            );
      }
      this.emit(frame);
      return;
    }
    // Events are delivered synchronously, never queued without a bound.
    this.emit(frame);
    if (frame.type === "extension_error") throw new ProcessRpcError("EXTENSION_FAILED");
    const run = this.run;
    if (frame.type === "agent_start" && (!this.ready || !run?.submitted))
      throw new ProcessRpcError("UNAUTHORIZED_AGENT_START");
    if (!run) return;
    if (
      (frame.type === "agent_start" || frame.type === "turn_start") &&
      run.turns >= run.maxTurns
    ) {
      this.emit({ type: "process_limit", limit: "turns" });
      this.fail("TURN_LIMIT");
      return;
    }
    if (frame.type === "agent_start") {
      if (run.started && !(run.managed && run.ended && !run.delivered))
        throw new ProcessRpcError("UNEXPECTED_AGENT_START");
      run.started = true;
      run.ended = false;
    }
    if (
      frame.type === "message_end" &&
      object(frame.message) &&
      frame.message.role === "assistant"
    ) {
      run.assistant = frame.message;
    }
    if (frame.type === "turn_end") {
      run.turns++;
      if (run.turns >= run.maxTurns && run.assistant?.stopReason === "toolUse") {
        this.emit({ type: "process_limit", limit: "turns" });
        this.fail("TURN_LIMIT");
      }
    }
    if (frame.type === "agent_end") {
      if (!run.started) throw new ProcessRpcError("UNEXPECTED_AGENT_END");
      run.ended = true;
      this.complete();
    }
  }

  private complete(): void {
    const run = this.run;
    if (!run || !run.ended || !run.acknowledged) return;
    const message = run.assistant;
    if (!message || message.stopReason !== "stop") {
      run.result.reject(
        new ProcessRpcError(
          message?.stopReason === "error" ? "PROVIDER_FAILED" : "INCOMPLETE_RESULT",
        ),
      );
      return;
    }
    if (run.managed && !run.delivered) return;
    if (!Array.isArray(message.content)) throw new ProcessRpcError("PROTOCOL_ERROR");
    const text = message.content
      .filter((part) => object(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    run.result.resolve(text);
  }

  private request(
    command: RpcCommand,
    timeoutMs?: number,
    phase: ProcessRpcError["phase"] = command.type,
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    const result = deferred<unknown>();
    const line = JSON.stringify({ ...command, id }) + "\n";
    if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? 4_194_304)) {
      return Promise.reject(new ProcessRpcError("FRAME_TOO_LARGE"));
    }
    if (
      this.pending.size >= 16 ||
      this.child.stdin.writableLength + Buffer.byteLength(line) >
        (this.options.maxFrameBytes ?? 4_194_304)
    ) {
      return Promise.reject(new ProcessRpcError("CAPACITY"));
    }
    const timer = setTimeout(
      () => this.fail("REQUEST_TIMEOUT", phase),
      timeoutMs ?? this.options.requestTimeoutMs ?? 10_000,
    );
    this.pending.set(id, { command: command.type, result, timer });
    this.child.stdin.write(line);
    return result.promise;
  }

  private inspect(stage: InspectionStage): Promise<unknown> {
    if (this.options.bootstrapData === undefined) return Promise.resolve(undefined);
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    const result = deferred<unknown>();
    const started = performance.now();
    const observe = (event: InspectionDiagnostic["event"]) =>
      this.observe({
        stage,
        phase: "request",
        event,
        durationMs: performance.now() - started,
      });
    const timer = setTimeout(
      () => this.fail("CONTROL_TIMEOUT", "inspect"),
      this.timing?.inspectionMs ?? this.options.requestTimeoutMs ?? 10_000,
    );
    this.pending.set(id, { command: "inspect", result, timer });
    if (this.options.onInspectionDiagnostic) {
      if (this.diagnosticRequests.size === 2)
        this.diagnosticRequests.delete(this.diagnosticRequests.keys().next().value!);
      this.diagnosticRequests.set(id, { stage, count: 0, completed: false });
      observe("start");
      void result.promise.then(
        () => observe("end"),
        () => observe("error"),
      );
    }
    this.child.send?.(
      {
        type: "inspect",
        id,
        ...(this.options.onInspectionDiagnostic ? { diagnosticStage: stage } : {}),
      },
      (error) => {
        if (error) this.fail("CONTROL_FAILED");
      },
    );
    return result.promise;
  }

  getState(): Promise<RpcSessionState> {
    return this.readState();
  }

  private async readState(
    timeoutMs?: number,
    phase: ProcessRpcError["phase"] = "get_state",
  ): Promise<RpcSessionState> {
    const state = await this.request({ type: "get_state" }, timeoutMs, phase);
    if (
      !object(state) ||
      typeof state.sessionId !== "string" ||
      typeof state.isStreaming !== "boolean" ||
      state.isStreaming ||
      state.pendingMessageCount !== 0
    ) {
      this.fail("STATE_MISMATCH");
      throw new ProcessRpcError("STATE_MISMATCH");
    }
    return state as unknown as RpcSessionState;
  }

  async prompt(
    message: string,
    limits: {
      maxTurns: number;
      timeoutMs: number;
      signal?: AbortSignal;
      completion?: Promise<unknown>;
    },
  ): Promise<string> {
    if (!this.ready || this.failure) throw this.failure ?? new ProcessRpcError("NOT_READY");
    if (this.run) throw new ProcessRpcError("BUSY");
    if (![limits.maxTurns, limits.timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new ProcessRpcError("INVALID_LIMIT");
    if (limits.signal?.aborted) throw new ProcessRpcError("ABORTED");
    const run: Run = {
      result: deferred<string>(),
      submitted: false,
      started: false,
      ended: false,
      acknowledged: false,
      turns: 0,
      maxTurns: limits.maxTurns,
      managed: limits.completion !== undefined,
      delivered: false,
    };
    this.run = run;
    const timeLimit = () => {
      if (this.run !== run || this.failure) return;
      this.emit({ type: "process_limit", limit: "time" });
      this.fail("TIME_LIMIT");
    };
    if (limits.completion)
      void limits.completion.then(
        () => {
          if (this.run !== run) return;
          run.delivered = true;
          this.complete();
        },
        (error) => {
          if (this.run !== run) return;
          // The collector starts the same run budget just before prompt().
          // Whichever timer expires first must retain the time-limit outcome.
          if (error instanceof ResultDeliveryTimeoutError) timeLimit();
          else this.fail("RESULT_DELIVERY_FAILED");
        },
      );
    const abort = () => this.fail("ABORTED");
    limits.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(timeLimit, limits.timeoutMs);
    try {
      await Promise.race([
        this.options.verifyReady(await this.getState(), this.pid, await this.inspect("preprompt")),
        run.result.promise,
      ]);
      if (this.failure) throw this.failure;
      run.submitted = true;
      // Pi acknowledges only after input, possible compaction and before_agent_start.
      // The timer already running above bounds readiness, preflight and execution together.
      await this.request({ type: "prompt", message }, limits.timeoutMs);
      run.acknowledged = true;
      this.complete();
      return await run.result.promise;
    } catch (error) {
      // No retries after uncertain prompt acceptance or tool execution.
      this.fail(error instanceof ProcessRpcError ? error.code : "PROMPT_FAILED");
      throw error instanceof ProcessRpcError ? error : new ProcessRpcError("READINESS_REJECTED");
    } finally {
      clearTimeout(timer);
      limits.signal?.removeEventListener("abort", abort);
      this.run = undefined;
    }
  }

  /** Host reply bypasses a blocked foreground model through Pi's registered command path. */
  async command(message: string): Promise<void> {
    if (!/^\/[a-zA-Z0-9_-]+(?: |$)/.test(message) || message.includes("\n"))
      throw new ProcessRpcError("INVALID_COMMAND");
    if (!this.authorize("steer")) throw new ProcessRpcError("PROCESS_IDENTITY_UNPROVEN");
    await this.request({ type: "prompt", message });
  }
  async replyHelp(requestId: string, message: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(requestId) || !message.trim())
      throw new ProcessRpcError("INVALID_REPLY");
    if (!this.authorize("steer")) throw new ProcessRpcError("PROCESS_IDENTITY_UNPROVEN");
    await this.request({ type: "prompt", message: `/agent-reply ${requestId} ${message}` });
  }
  async close(): Promise<void> {
    if (!this.authorize("cleanup")) {
      this.detach();
      return;
    }
    this.fail("CLOSED");
    this.stopOwned();
    let deadline: NodeJS.Timeout | undefined;
    const bounded = new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => {
        if (this.alive) {
          reject(new ProcessRpcError("PROCESS_CLEANUP_TIMEOUT"));
          return;
        }
        for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr])
          stream.destroy();
        resolve();
      }, 3000);
      deadline.unref();
    });
    try {
      await Promise.race([this.closed.promise, this.stopRefused.promise, bounded]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
  /** Release only our transport references after takeover or an identity refusal. */
  detach(): void {
    if (this.termTimer) clearTimeout(this.termTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr])
      (stream as unknown as { unref?: () => void }).unref?.();
  }
  cancelDialogs(): void {
    for (const controller of this.dialogs.values()) controller.abort();
    this.dialogs.clear();
  }
  parentExiting(): void {
    if (this.alive && this.authorize("parent-exiting") && this.child.connected)
      this.child.send?.({ type: "parent_exiting", processId: this.processId }, () => {});
  }
}
