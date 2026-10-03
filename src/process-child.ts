import { validateQualificationPreset } from "./process-qualification.ts";
import {
  InspectionTrace,
  diagnosticFrameBytes,
  diagnosticProcessLimit,
} from "./process-inspection-diagnostic.ts";
/** Private RPC child entrypoint. Uses the public Pi SDK and a private Node IPC bootstrap. */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  DefaultResourceLoader,
  SessionManager,
  AgentSessionRuntime,
  createAgentSession,
  createEventBus,
  initTheme,
  runRpcMode,
  type AgentSessionServices,
} from "@mariozechner/pi-coding-agent";
import type { ProcessBootstrap, ChildInspection } from "./process-contract.ts";
import { CHILD_POLICY_EVENT } from "./process-contract.ts";
import { requestQualifiedProtectionSnapshot, verifyChildProtection } from "./protection-adapter.ts";
import { referenceProfileFile, ProcessProfileError } from "./process-profile.ts";
import { verifyProcessResources, verifyProcessSession } from "./process-session.ts";
import { LocalMessageClient } from "./messaging-client.ts";
import type { ChildPolicyBinding } from "./process-boundary.ts";
import { childFailureExitStatus } from "./process-child-failure.ts";
import { attachProcessRunner } from "./process-runner.ts";
import { childSettings } from "./process-settings.ts";
import { ProcessRegistry, type ProcessHandle } from "./process-lifecycle.ts";
import { createChildDialogs } from "./process-child-dialog.ts";
import type { ProcessDialogResponse } from "./process-dialog.ts";
import { captureProfileResources } from "./process-profile.ts";
import {
  findCommunication,
  MANAGED_STATE_EVENT,
  MANAGED_CHANGED_EVENT,
} from "./process-communication.ts";

async function boot(data: ProcessBootstrap): Promise<void> {
  const qualificationPreset = validateQualificationPreset(data.qualificationPreset);
  const { profile } = data;
  verifyProcessResources(profile);
  verifyProcessSession(profile);
  if (realpathSync(process.cwd()) !== profile.cwd)
    throw new ProcessProfileError("CHILD_CWD_MISMATCH");
  const eventBus = createEventBus();
  const authStorage = AuthStorage.create(data.credentials.authFile);
  const modelRegistry = ModelRegistry.create(
    authStorage,
    profile.resources.find((r) => r.kind === "provider")?.path,
  );
  const settingsSourceCwd = data.settingsSourceCwd ?? data.parentCwd;
  const merged = childSettings(settingsSourceCwd, profile.agentDir, profile);
  const settingsManager = SettingsManager.inMemory(merged);
  initTheme(settingsManager.getTheme(), false);
  settingsManager.setRetryEnabled(false);
  const paths = (kind: string) =>
    profile.resources.filter((r) => r.kind === kind).map((r) => r.path);
  const text = (path: string) => readFileSync(path, "utf8");
  const boundary = realpathSync(fileURLToPath(new URL("./process-boundary.ts", import.meta.url)));
  const extensions = [...new Set([...paths("extension"), boundary])];
  let inspect!: (trace?: InspectionTrace) => Promise<ChildInspection>;
  let boundaryBound = false;
  const dialogs = createChildDialogs(
    (message) => {
      if (process.connected) process.send?.(message, () => {});
    },
    () => ownsCurrentRun(),
  );
  eventBus.on(CHILD_POLICY_EVENT, (value) => {
    (value as { bind(binding: ChildPolicyBinding): void }).bind({
      tools: profile.tools,
      dialogs: dialogs.ui,
      verify: async () => {
        await inspect();
      },
      terminate: (phase, error) => process.exit(childFailureExitStatus(phase, error)),
    });
    boundaryBound = true;
  });
  const loader = new DefaultResourceLoader({
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    settingsManager,
    eventBus,
    noExtensions: true,
    additionalExtensionPaths: extensions,
    noSkills: true,
    additionalSkillPaths: paths("skill"),
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({
      agentsFiles: paths("instruction").map((path) => ({ path, content: text(path) })),
    }),
    systemPromptOverride: () => paths("system-prompt").map(text)[0],
    appendSystemPromptOverride: () => paths("append-prompt").map(text),
  });
  await loader.reload();
  if (!boundaryBound) throw new ProcessProfileError("CHILD_POLICY_UNAVAILABLE");
  const loaded = loader.getExtensions();
  if (loaded.errors.length) throw new ProcessProfileError("CHILD_EXTENSION_FAILED");
  const model = modelRegistry.find(profile.model.provider, profile.model.id);
  // createAgentSession registers extension providers; resolve the model afterwards if needed.
  const { session } = await createAgentSession({
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.open(profile.session.file),
    settingsManager,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: profile.thinking,
    tools: profile.tools,
  });
  const selected = modelRegistry.find(profile.model.provider, profile.model.id);
  if (!selected) throw new ProcessProfileError("UNKNOWN_MODEL");
  await session.setModel(selected);
  session.setThinkingLevel(profile.thinking);
  const client = await LocalMessageClient.connect(data.broker);
  if (
    client.participant.agentId !== profile.identity.agentId ||
    client.participant.sessionId !== profile.identity.sessionId
  )
    throw new ProcessProfileError("BROKER_IDENTITY_MISMATCH");
  const members = data.groupBinding
    ? await client.control<import("./delegation-group.ts").GroupBinding[]>("members")
    : [];
  const actualBinding = members.find((m) => m.agentId === profile.identity.agentId);
  if (
    data.groupBinding &&
    (!actualBinding ||
      JSON.stringify(actualBinding) !== JSON.stringify(data.groupBinding) ||
      actualBinding.depth !== profile.depth ||
      actualBinding.maxConcurrent !== profile.limits.maxConcurrent ||
      actualBinding.maxDepth !== profile.limits.maxDepth ||
      actualBinding.processId !== profile.identity.processId ||
      actualBinding.parentId !== profile.parent.agentId ||
      JSON.stringify(actualBinding.role) !== JSON.stringify(profile.role))
  )
    throw new ProcessProfileError("BROKER_IDENTITY_MISMATCH");
  inspect = async (trace) => {
    const sync = <T>(phase: "resources" | "session" | "extensions", operation: () => T): T =>
      trace ? trace.sync(phase, operation) : operation();
    sync("resources", () => verifyProcessResources(profile, trace));
    if (
      JSON.stringify(settingsManager.getGlobalSettings()) !==
        JSON.stringify(childSettings(settingsSourceCwd, profile.agentDir, profile)) ||
      Object.keys(settingsManager.getProjectSettings()).length !== 0
    )
      throw new ProcessProfileError("PARENT_SETTINGS_DRIFT");
    sync("session", () => verifyProcessSession(profile));
    sync("extensions", () => {
      const actualExtensions = session.resourceLoader.getExtensions();
      if (
        actualExtensions.errors.length ||
        JSON.stringify(actualExtensions.extensions.map((e) => realpathSync(e.resolvedPath))) !==
          JSON.stringify(extensions)
      )
        throw new ProcessProfileError("CHILD_RESOURCE_MISMATCH");
      for (const path of extensions) referenceProfileFile(path);
      if (profile.rolePrompt) {
        const inventory = captureProfileResources(session.resourceLoader, {
          cwd: profile.cwd,
          agentDir: profile.agentDir,
          settingsSourceCwd,
          configurationFiles: data.hostPolicy?.nodeImports,
          systemPromptFile: paths("system-prompt")[0],
          appendSystemPromptFiles: paths("append-prompt"),
        });
        const expected = [...profile.resources];
        if (!expected.some((r) => r.kind === "extension" && r.path === boundary))
          expected.splice(
            expected.findIndex(
              (r) => r.kind !== "instruction" && r.kind !== "skill" && r.kind !== "extension",
            ),
            0,
            { kind: "extension", ...referenceProfileFile(boundary) },
          );
        // Loader enumeration order groups resource kinds; compare the complete path/content set.
        const canonical = (refs: typeof inventory) => refs.map((r) => JSON.stringify(r)).sort();
        if (JSON.stringify(canonical(inventory)) !== JSON.stringify(canonical(expected)))
          throw new ProcessProfileError("CHILD_RESOURCE_MISMATCH");
        const roleText = text(profile.rolePrompt.path);
        if (
          !roleText.startsWith(
            `Role binding: ${JSON.stringify({ role: profile.role, cwd: profile.cwd })}\n`,
          )
        )
          throw new ProcessProfileError("CHILD_RESOURCE_MISMATCH");
      }
    });
    const snapshots = [];
    for (const expected of data.protections) {
      const capture = async () => {
        const actual = (
          await requestQualifiedProtectionSnapshot(
            eventBus,
            {
              protectionId: expected.protectionId,
              expectedSessionId: session.sessionId,
              targetCwd: profile.cwd,
            },
            qualificationPreset,
          )
        ).read();
        verifyChildProtection(expected, actual, {
          cwd: profile.cwd,
          sessionId: profile.identity.sessionId,
        });
        return actual;
      };
      const phase = expected.protectionId === "pi-agent-guard" ? "guard" : "sandbox";
      snapshots.push(trace ? await trace.async(phase, capture) : await capture());
    }
    // After actual extension binding, restrict the complete tool set (including custom tools).
    session.setActiveToolsByName(profile.tools);
    if (
      JSON.stringify([...session.getActiveToolNames()].sort()) !==
      JSON.stringify([...profile.tools].sort())
    )
      throw new ProcessProfileError("CHILD_TOOL_MISMATCH");
    return {
      pid: process.pid,
      cwd: realpathSync(process.cwd()),
      sessionId: session.sessionId,
      tools: session.getActiveToolNames(),
      extensions: paths("extension"),
      protections: snapshots,
      brokerAgentId: client.participant.agentId,
    };
  };
  const services: AgentSessionServices = {
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader: loader,
    diagnostics: [],
  };
  const registry = data.hostPolicy
    ? new ProcessRegistry(join(data.hostPolicy.sessionDirectory, "lifecycle"))
    : undefined;
  const ownHandle: ProcessHandle = {
    taskId: actualBinding?.taskId ?? "unknown",
    ...profile.identity,
    sessionFile: profile.session.file,
    cwd: profile.cwd,
    pid: process.pid,
    parentAgentId: profile.parent.agentId,
    parentSessionId: profile.parent.sessionId,
    ownership: "managed",
    revision: 0,
    routeParentId: profile.parent.agentId,
  };
  let keepAlive: NodeJS.Timeout | undefined;
  const hold = () => {
    // A disconnected manually owned RPC process retains its saved session and live work.
    // Reconnection/recovery is deliberately not implemented by this hold.
    keepAlive ??= setInterval(() => {}, 60_000);
    return new Promise<never>(() => {});
  };
  const ownsCurrentRun = () => {
    try {
      return !registry || registry.read(ownHandle, false).ownership === "managed";
    } catch {
      return false;
    }
  };
  class BoundChildRuntime extends AgentSessionRuntime {
    private disposal?: Promise<void>;
    override async dispose(): Promise<void> {
      if (!ownsCurrentRun()) return hold();
      return (this.disposal ??= (async () => {
        await detach?.();
        await super.dispose();
      })());
    }
  }
  const runtime = new BoundChildRuntime(session, services, async () => {
    throw new ProcessProfileError("CHILD_SESSION_REPLACEMENT_FORBIDDEN");
  });
  const detach =
    data.hostPolicy && actualBinding
      ? await attachProcessRunner(
          () => ({ session, cwd: profile.cwd, agentDir: profile.agentDir, eventBus }),
          data.hostPolicy,
          { client, binding: actualBinding, profile, settingsSourceCwd },
        )
      : undefined;
  let published = false;
  const maybePublish = () => {
    void session.agent.waitForIdle().then(() => {
      if (!actualBinding || published || session.isStreaming) return;
      let pending = false;
      eventBus.emit(MANAGED_STATE_EVENT, {
        set: (value: boolean) => {
          pending = value;
        },
      });
      if (pending) return;
      const last = session.messages.at(-1);
      if (!last || last.role !== "assistant" || last.stopReason !== "stop") return;
      const communication = findCommunication(eventBus);
      if (!communication) return;
      const parent = members.find((m) => m.agentId === actualBinding.parentId);
      if (!parent) return;
      published = true;
      void communication
        .publish({
          resultId: `${actualBinding.processId}:result`,
          taskId: actualBinding.taskId,
          childAgentId: actualBinding.agentId,
          childSessionId: actualBinding.sessionId,
          childProcessId: actualBinding.processId,
          parentSessionId: parent.sessionId,
          goal: communication.report?.goal ?? data.taskGoal ?? "Assigned task",
          basis:
            communication.report?.basis ??
            JSON.stringify({ cwd: profile.cwd, sessionFile: profile.session.file }),
          findings:
            communication.report?.findings ??
            last.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
          evidence: communication.report?.evidence ?? [profile.session.file],
          blockers: communication.report?.blockers ?? [],
        })
        .catch((error) => {
          process.exit(childFailureExitStatus("child:model", error));
        });
    });
  };
  session.subscribe((event) => {
    if (event.type === "agent_end") maybePublish();
  });
  eventBus.on(MANAGED_CHANGED_EVENT, maybePublish);
  let diagnosticCount = 0;
  process.on(
    "message",
    (message: {
      type?: string;
      id?: string;
      diagnosticStage?: unknown;
      processId?: string;
      response?: ProcessDialogResponse;
    }) => {
      if (message.type === "dialog_response" && message.response) {
        if (ownsCurrentRun()) dialogs.reply(message.response);
        return;
      }
      if (message.type === "parent_exiting") {
        if (message.processId !== profile.identity.processId) return;
        try {
          if (ownsCurrentRun() && registry) {
            const current = registry.read(ownHandle, false);
            registry.update(current, {
              parentState: "parent_exiting",
              phase: "stopped",
              error: "PARENT_EXITING",
            });
          }
        } catch {
          /* Best effort; a changed identity grants no termination authority. */
        }
        return;
      }
      if (message.type !== "inspect" || typeof message.id !== "string") return;
      const stage = message.diagnosticStage;
      const trace =
        stage === "startup" || stage === "preprompt"
          ? new InspectionTrace(stage, (record) => {
              if (diagnosticCount++ >= diagnosticProcessLimit || !process.connected) return;
              const frame = { type: "inspection_diagnostic", id: message.id, record };
              if (Buffer.byteLength(JSON.stringify(frame)) > diagnosticFrameBytes) return;
              // No awaited flush/ack, and no diagnostic work in the immediate hook-exit path.
              process.send?.(frame, () => {});
            })
          : undefined;
      const check = trace ? trace.async("inspection", () => inspect(trace)) : inspect();
      const respond = (success: boolean, proof?: ChildInspection) => {
        const send = () =>
          process.send?.(
            {
              type: "inspection",
              id: message.id,
              success,
              ...(success ? { proof } : {}),
            },
            () => {},
          );
        if (trace) trace.sync("return", send);
        else send();
      };
      void check.then(
        (proof) => respond(true, proof),
        () => respond(false),
      );
    },
  );
  process.on("disconnect", () => {
    if (!ownsCurrentRun()) {
      try {
        const current = registry?.read(ownHandle, false);
        if (current && current.ownership !== "managed")
          registry!.update(current, {
            parentState:
              current.parentState === "parent_exiting" ? "parent_exiting" : "disconnected",
            phase: "detached",
            error:
              current.parentState === "parent_exiting" ? "PARENT_EXITING" : "PARENT_DISCONNECTED",
          });
      } catch {
        /* Unproven identity leaves the process and evidence untouched. */
      }
      void hold();
      return;
    }
    if (registry) {
      try {
        const current = registry.read(ownHandle, false);
        registry.update(current, {
          parentState: current.parentState === "parent_exiting" ? "parent_exiting" : "disconnected",
          phase: "stopped",
          error:
            current.parentState === "parent_exiting" ? "PARENT_EXITING" : "PARENT_DISCONNECTED",
        });
      } catch {
        void hold();
        return;
      }
    }
    // A tool can ignore AbortSignal. The same registered run is rechecked at the deadline.
    const deadline = setTimeout(() => {
      if (ownsCurrentRun())
        process.exit(
          childFailureExitStatus("child:disconnect", { code: "CHILD_IPC_DISCONNECTED" }),
        );
      else void hold();
    }, 1000);
    deadline.unref();
    void (async () => {
      await session.abort();
      await detach?.();
      client.close();
      await runtime.dispose();
    })().finally(() => {
      if (ownsCurrentRun())
        process.exit(
          childFailureExitStatus("child:disconnect", { code: "CHILD_IPC_DISCONNECTED" }),
        );
      else void hold();
    });
  });
  await runRpcMode(runtime);
}

if (!process.send) throw new Error("PRIVATE_BOOTSTRAP_REQUIRED");
process.once("message", (message: { type?: string; data?: ProcessBootstrap }) => {
  if (message.type !== "bootstrap" || !message.data)
    process.exit(childFailureExitStatus("child:boot", { code: "PRIVATE_BOOTSTRAP_REQUIRED" }));
  void boot(message.data).catch((error) =>
    process.exit(childFailureExitStatus("child:boot", error)),
  );
});
