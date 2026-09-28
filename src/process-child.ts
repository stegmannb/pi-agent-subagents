import { validateQualificationPreset } from "./process-qualification.ts";
import {
  InspectionTrace,
  diagnosticFrameBytes,
  diagnosticProcessLimit,
} from "./process-inspection-diagnostic.ts";
/** Private RPC child entrypoint. Uses the public Pi SDK and a private Node IPC bootstrap. */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  const parentSettings = SettingsManager.create(data.parentCwd, profile.agentDir);
  // Pi merges nested settings one level deep. Keep child writes in memory.
  const global = parentSettings.getGlobalSettings();
  const project = parentSettings.getProjectSettings();
  const merged: Record<string, unknown> = { ...global };
  for (const [key, value] of Object.entries(project)) {
    const prior = merged[key];
    merged[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      prior &&
      typeof prior === "object" &&
      !Array.isArray(prior)
        ? { ...prior, ...value }
        : value;
  }
  const settingsManager = SettingsManager.inMemory(merged);
  initTheme(settingsManager.getTheme(), false);
  settingsManager.setRetryEnabled(false);
  const paths = (kind: string) =>
    profile.resources.filter((r) => r.kind === kind).map((r) => r.path);
  const text = (path: string) => readFileSync(path, "utf8");
  const boundary = realpathSync(fileURLToPath(new URL("./process-boundary.ts", import.meta.url)));
  const extensions = [...paths("extension"), boundary];
  let inspect!: (trace?: InspectionTrace) => Promise<ChildInspection>;
  let boundaryBound = false;
  eventBus.on(CHILD_POLICY_EVENT, (value) => {
    (value as { bind(binding: ChildPolicyBinding): void }).bind({
      tools: profile.tools,
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
    appendSystemPromptOverride: () => [
      ...paths("append-prompt").map(text),
      `You are a subagent performing the ${profile.role.name} role in ${profile.cwd}. Complete only the assigned task.`,
      ...(data.roleInstructions ? [data.roleInstructions] : []),
    ],
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
  inspect = async (trace) => {
    const sync = <T>(phase: "resources" | "session" | "extensions", operation: () => T): T =>
      trace ? trace.sync(phase, operation) : operation();
    sync("resources", () => verifyProcessResources(profile, trace));
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
      extensions: extensions.slice(0, -1),
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
  const runtime = new AgentSessionRuntime(session, services, async () => {
    throw new ProcessProfileError("CHILD_SESSION_REPLACEMENT_FORBIDDEN");
  });
  let diagnosticCount = 0;
  process.on("message", (message: { type?: string; id?: string; diagnosticStage?: unknown }) => {
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
        process.send?.({
          type: "inspection",
          id: message.id,
          success,
          ...(success ? { proof } : {}),
        });
      if (trace) trace.sync("return", send);
      else send();
    };
    void check.then(
      (proof) => respond(true, proof),
      () => respond(false),
    );
  });
  process.on("disconnect", () => {
    client.close();
    void runtime
      .dispose()
      .finally(() =>
        process.exit(
          childFailureExitStatus("child:disconnect", { code: "CHILD_IPC_DISCONNECTED" }),
        ),
      );
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
