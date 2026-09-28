import { validateQualificationPreset } from "./process-qualification.ts";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
/** SDK-host process runner. Captures the actual live parent before each incarnation. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LocalMessageBroker } from "./messaging-broker.ts";
import { LocalMessageClient } from "./messaging-client.ts";
import {
  captureProfileResources,
  materializeProfileEnvironment,
  ProcessProfileError,
  referenceProfileFile,
  referenceProfileEnvironment,
  resolveProcessStartProfile,
  verifyProfileFiles,
  type ProcessStartProfile,
} from "./process-profile.ts";
import {
  requestQualifiedProtectionSnapshot,
  verifyChildProtection,
  type ReadyProtectionSnapshot,
  type ProtectionSnapshotLease,
} from "./protection-adapter.ts";
import { ProcessRpc, ProcessRpcError } from "./process-rpc.ts";
import {
  reserveProcessSession,
  verifyProcessResources,
  verifyProcessSession,
} from "./process-session.ts";
import {
  PROCESS_RUNNER_EVENT,
  type ProcessHostPolicy,
  type ProcessParent,
  type ProcessRunner,
  type ProcessExecution,
  type ProcessExecutionResult,
  type ChildInspection,
} from "./process-contract.ts";

export function requireProcessRunner(bus: ProcessParent["eventBus"]): ProcessRunner {
  let runner: ProcessRunner | undefined;
  bus.emit(PROCESS_RUNNER_EVENT, {
    bind(value: ProcessRunner) {
      if (runner) throw new ProcessProfileError("DUPLICATE_PARENT_HOST");
      runner = value;
    },
  });
  if (!runner) throw new ProcessProfileError("LIVE_PARENT_INVENTORY_UNAVAILABLE");
  return runner;
}
export async function attachProcessRunner(
  getParent: () => ProcessParent,
  policy: ProcessHostPolicy,
): Promise<() => Promise<void>> {
  const qualificationPreset = validateQualificationPreset(policy.qualificationPreset);
  const childStartupTimeoutMs = policy.childStartupTimeoutMs ?? 10_000;
  if (
    !Number.isSafeInteger(childStartupTimeoutMs) ||
    childStartupTimeoutMs < 1 ||
    childStartupTimeoutMs > 120_000 ||
    policy.childStartupTimeoutMs === null
  )
    throw new ProcessProfileError("INVALID_CHILD_STARTUP_TIMEOUT");
  const classifications = policy.extensions.map((e) => ({
    path: realpathSync(e.path),
    protectionId: e.protectionId,
  }));
  mkdirSync(policy.sessionDirectory, { recursive: true, mode: 0o700 });

  const initialParent = getParent();
  const initialResources = captureProfileResources(initialParent.session.resourceLoader, {
    cwd: initialParent.cwd,
    agentDir: initialParent.agentDir,
    configurationFiles: policy.nodeImports,
  });

  const broker = await LocalMessageBroker.start();
  const parentIdentity = {
    agentId: randomUUID(),
    sessionId: getParent().session.sessionId,
    processId: randomUUID(),
  };
  const groupId = randomUUID();
  const parentCredential = broker.register({
    groupId,
    agentId: parentIdentity.agentId,
    sessionId: parentIdentity.sessionId,
    parentId: null,
  });
  const parentClient = await LocalMessageClient.connect(parentCredential).catch(async (error) => {
    await broker.close();
    throw error;
  });
  const running = new Set<ProcessRpc>();
  const busySessions = new Set<string>();
  let active = 0;
  let disposed = false;

  async function capture(cwd: string) {
    const parent = getParent();
    if (disposed || parent.session.sessionId !== parentIdentity.sessionId)
      throw new ProcessProfileError("PARENT_SESSION_CHANGED");
    await parent.session.settingsManager.flush();
    const resources = captureProfileResources(parent.session.resourceLoader, {
      cwd: parent.cwd,
      agentDir: parent.agentDir,
      configurationFiles: policy.nodeImports,
    });
    const settingsPaths = [
      join(parent.agentDir, "settings.json"),
      join(parent.cwd, ".pi/settings.json"),
    ];
    const immutable = (refs: typeof resources) =>
      refs.filter((ref) => !settingsPaths.includes(ref.path));
    if (JSON.stringify(immutable(resources)) !== JSON.stringify(immutable(initialResources)))
      throw new ProcessProfileError("PARENT_RESOURCE_CHANGED");
    const fromDisk = SettingsManager.create(parent.cwd, parent.agentDir);
    if (
      JSON.stringify(fromDisk.getGlobalSettings()) !==
        JSON.stringify(parent.session.settingsManager.getGlobalSettings()) ||
      JSON.stringify(fromDisk.getProjectSettings()) !==
        JSON.stringify(parent.session.settingsManager.getProjectSettings())
    )
      throw new ProcessProfileError("PARENT_SETTINGS_DRIFT");
    const extensionPaths = resources.filter((r) => r.kind === "extension").map((r) => r.path);
    const classification = extensionPaths.map((path) => {
      const matches = classifications.filter((c) => c.path === path);
      if (matches.length !== 1) throw new ProcessProfileError("EXTENSION_CLASSIFICATION_REQUIRED");
      return matches[0];
    });
    const proofs: ReadyProtectionSnapshot[] = [];
    const leases: ProtectionSnapshotLease[] = [];
    for (const entry of classification) {
      if (!entry.protectionId) continue;
      const lease = await requestQualifiedProtectionSnapshot(
        parent.eventBus,
        {
          protectionId: entry.protectionId,
          expectedSessionId: parent.session.sessionId,
          targetCwd: cwd,
        },
        qualificationPreset,
      );
      const proof = lease.read();
      leases.push(lease);
      if (proof.binding.cwd !== parent.cwd || !proof.codeFiles.some((r) => r.path === entry.path))
        throw new ProcessProfileError("PROTECTION_BINDING_MISMATCH");
      for (const ref of [...proof.codeFiles, ...proof.configurationFiles])
        if (referenceProfileFile(ref.path).sha256 !== ref.sha256)
          throw new ProcessProfileError("RESOURCE_CHANGED");
      for (const ref of proof.environment) {
        if (policy.credentials.environmentNames.includes(ref.name))
          throw new ProcessProfileError("PROTECTION_CREDENTIAL_ENVIRONMENT");
        const actual = createHash("sha256")
          .update(JSON.stringify(globalThis.process.env[ref.name] ?? null))
          .digest("hex");
        if (actual !== ref.sha256) throw new ProcessProfileError("PROTECTION_ENVIRONMENT_CHANGED");
        if (
          ref.name === "PI_CODING_AGENT_DIR" &&
          globalThis.process.env[ref.name] !== parent.agentDir
        )
          throw new ProcessProfileError("PROTECTION_AGENT_DIR_MISMATCH");
      }
      proofs.push(proof);
    }
    if (!parent.session.model) throw new ProcessProfileError("MODEL_REQUIRED");
    return { parent, resources, classification, proofs, leases };
  }

  const runner: ProcessRunner = {
    async execute(input): Promise<ProcessExecutionResult> {
      const cwd = realpathSync(input.cwd);
      const captured = await capture(cwd);
      const { parent, resources, classification, proofs } = captured;
      const resolved = resolveProcessStartProfile({
        parent: {
          identity: parentIdentity,
          cwd: parent.cwd,
          agentDir: parent.agentDir,
          sessionFile: parent.session.sessionFile ?? "",
          depth: 0,
          model: { provider: parent.session.model!.provider, id: parent.session.model!.id },
          thinking: parent.session.thinkingLevel,
          activeTools: parent.session.getActiveToolNames(),
          limits: policy.limits,
          resources,
          protectionInventory: "complete",
          extensionClassification: classification,
          protections: proofs.map((p) => ({
            id: p.protectionId,
            extensionPath: classification.find((c) => c.protectionId === p.protectionId)!.path,
            replay: {
              kind: "file-backed",
              verifiedCwd: cwd,
              configurationFiles: [...p.codeFiles, ...p.configurationFiles],
              environment: referenceProfileEnvironment(
                p.environment
                  .map((e) => e.name)
                  .filter(
                    (name) =>
                      name !== "PI_CODING_AGENT_DIR" && globalThis.process.env[name] !== undefined,
                  ),
                globalThis.process.env,
              ),
            },
          })),
        },
        cwd,
        sessionDirectory: policy.sessionDirectory,
        role: input.role,
        availableModels: (await parent.session.modelRegistry.getAvailable()).map((m) => ({
          provider: m.provider,
          id: m.id,
        })),
        credentials: policy.credentials,
        environmentAllowlist: policy.environmentAllowlist,
        ...(input.model ? { modelOverride: input.model } : {}),
        ...(input.thinking ? { thinkingOverride: input.thinking } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
      });
      verifyProfileFiles(resolved.profile);
      const credential = broker.register({
        groupId,
        agentId: resolved.profile.identity.agentId,
        sessionId: resolved.profile.identity.sessionId,
        parentId: parentIdentity.agentId,
      });
      reserveProcessSession(resolved.profile);
      return run(input, resolved.profile, credential, proofs, captured.leases);
    },
  };

  async function run(
    input: ProcessExecution,
    profile: ProcessStartProfile,
    brokerCredential: ReturnType<LocalMessageBroker["register"]>,
    originalProofs: ReadyProtectionSnapshot[],
    originalLeases: ProtectionSnapshotLease[],
  ): Promise<ProcessExecutionResult> {
    if (disposed || active >= profile.limits.maxConcurrent)
      throw new ProcessProfileError("CONCURRENCY_LIMIT");
    if (busySessions.has(profile.session.file)) throw new ProcessProfileError("SESSION_BUSY");
    busySessions.add(profile.session.file);
    active++;
    let process: ProcessRpc | undefined;
    try {
      verifyProcessResources(profile);
      verifyProcessSession(profile);
      const fresh = await capture(profile.cwd);
      if (JSON.stringify(fresh.resources) !== JSON.stringify(profile.resources))
        throw new ProcessProfileError("PARENT_RESOURCE_CHANGED");
      const incarnation = {
        ...profile,
        identity: { ...profile.identity, processId: randomUUID() },
      };
      const identity = {
        taskId: input.taskId,
        ...incarnation.identity,
        sessionFile: profile.session.file,
        cwd: profile.cwd,
      };
      input.onIdentity?.(identity);
      process = await ProcessRpc.start({
        startupTimeoutMs: childStartupTimeoutMs,
        qualificationPreset,
        executable: profile.runtime.node.path,
        args: [
          ...(policy.nodeImports ?? []).flatMap((path) => ["--import", path]),
          fileURLToPath(new URL("./process-child.ts", import.meta.url)),
        ],
        cwd: profile.cwd,
        environment: materializeProfileEnvironment(
          profile,
          policy.credentials,
          globalThis.process.env,
        ),
        bootstrapData: {
          qualificationPreset,
          profile: incarnation,
          credentials: policy.credentials,
          parentCwd: fresh.parent.cwd,
          roleInstructions: input.roleInstructions,
          protections: fresh.proofs,
          broker: brokerCredential,
        },
        onEvent: input.onEvent,
        onInspectionDiagnostic: policy.onInspectionDiagnostic,
        verifyReady: async (state, pid, evidence) => {
          try {
            if (input.signal?.aborted) throw new ProcessProfileError("ABORTED");
            const proof = evidence as ChildInspection | undefined;
            if (
              !proof ||
              proof.pid !== pid ||
              proof.cwd !== profile.cwd ||
              proof.sessionId !== profile.identity.sessionId ||
              proof.brokerAgentId !== profile.identity.agentId ||
              state.sessionId !== profile.identity.sessionId ||
              state.sessionFile !== profile.session.file ||
              state.model?.provider !== profile.model.provider ||
              state.model?.id !== profile.model.id ||
              state.thinkingLevel !== profile.thinking ||
              JSON.stringify([...proof.tools].sort()) !==
                JSON.stringify([...profile.tools].sort()) ||
              JSON.stringify(proof.extensions) !==
                JSON.stringify(
                  profile.resources.filter((r) => r.kind === "extension").map((r) => r.path),
                ) ||
              proof.protections.length !== fresh.proofs.length
            )
              throw new ProcessProfileError("CHILD_READINESS_MISMATCH");
            for (let i = 0; i < fresh.proofs.length; i++)
              verifyChildProtection(fresh.proofs[i], proof.protections[i], {
                cwd: profile.cwd,
                sessionId: profile.identity.sessionId,
              });
            const now = await capture(profile.cwd);
            for (const lease of [...originalLeases, ...fresh.leases, ...now.leases]) lease.read();
            const stable = (values: ReadyProtectionSnapshot[], includeGeneration = true) =>
              JSON.stringify(
                values.map(({ requestId: _id, ...value }) => ({
                  ...value,
                  binding: {
                    ...value.binding,
                    generation: includeGeneration ? value.binding.generation : undefined,
                  },
                })),
              );
            if (
              stable(now.proofs) !== stable(fresh.proofs) ||
              // A new incarnation takes a fresh lease. Guard also increments generation
              // for completed checks which leave the effective file-backed policy unchanged.
              // Keep exact generation stability across this startup, and exact policy parity
              // across incarnations. Runtime mutations remain unsupported by producers.
              stable(originalProofs, false) !== stable(fresh.proofs, false)
            )
              throw new ProcessProfileError("PARENT_PROTECTION_CHANGED");
            verifyProcessResources(profile);
            input.onIdentity?.({ ...identity, pid });
          } catch (error) {
            // Keep our fixed validation code, never arbitrary extension error text.
            if (error instanceof ProcessProfileError) throw new ProcessRpcError(error.code);
            throw error;
          }
        },
      });
      running.add(process);
      const responseText = await process.prompt(`Task:\n${input.prompt}`, {
        maxTurns: profile.limits.maxTurns,
        timeoutMs: profile.limits.timeoutSeconds * 1000,
        signal: input.signal,
      });
      return {
        responseText,
        resume: (prompt, signal) =>
          run(
            { ...input, prompt, signal },
            profile,
            brokerCredential,
            originalProofs,
            originalLeases,
          ),
      };
    } finally {
      if (process) {
        running.delete(process);
        await process.close();
      }
      busySessions.delete(profile.session.file);
      active--;
    }
  }
  const unsubscribe = getParent().eventBus.on(PROCESS_RUNNER_EVENT, (request) => {
    (request as { bind(runner: ProcessRunner): void }).bind(runner);
  });
  return async () => {
    disposed = true;
    unsubscribe();
    await Promise.allSettled([...running].map((p) => p.close()));
    parentClient.close();
    await broker.close();
  };
}
