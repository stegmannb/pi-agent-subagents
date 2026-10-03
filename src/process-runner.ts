import { validateQualificationPreset } from "./process-qualification.ts";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
/** SDK-host process runner. Captures the actual live parent before each incarnation. */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { childSettings } from "./process-settings.ts";
import { SUBAGENT_CONTEXT_TOOL_NAMES } from "./tool-constants.ts";
import type { GroupBinding } from "./delegation-group.ts";
import type { ParticipantCredential } from "./messaging-broker.ts";
import {
  ProcessCommunication,
  COMMUNICATION_EVENT,
  PROCESS_DIALOG_EVENT,
} from "./process-communication.ts";
import {
  ProcessRegistry,
  ProcessIdentityError,
  type ProcessHandle,
  type ProcessRegistration,
} from "./process-lifecycle.ts";
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
import { osProcessIdentity } from "./process-os-identity.ts";
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
  type NestedProcessHost,
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
  nested?: NestedProcessHost,
): Promise<() => Promise<void>> {
  const qualificationPreset = validateQualificationPreset(policy.qualificationPreset);
  const childStartupTimeoutMs = policy.childStartupTimeoutMs ?? 10_000;
  if (
    policy.humanAnswerChannel !== undefined &&
    !["interactive", "rpc"].includes(policy.humanAnswerChannel)
  )
    throw new ProcessProfileError("INVALID_HUMAN_ANSWER_CHANNEL");
  if (
    !Number.isSafeInteger(childStartupTimeoutMs) ||
    childStartupTimeoutMs < 1 ||
    childStartupTimeoutMs > 120_000 ||
    policy.childStartupTimeoutMs === null
  )
    throw new ProcessProfileError("INVALID_CHILD_STARTUP_TIMEOUT");
  const limits = {
    ...policy.limits,
    maxConcurrent: policy.limits.maxConcurrent === undefined ? 4 : policy.limits.maxConcurrent,
    maxDepth: policy.limits.maxDepth === undefined ? 2 : policy.limits.maxDepth,
  };
  for (const value of [limits.maxConcurrent, limits.maxDepth])
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new ProcessProfileError("INVALID_GROUP_LIMIT");
  const classifications = policy.extensions.map((e) => ({
    path: realpathSync(e.path),
    protectionId: e.protectionId,
  }));
  mkdirSync(policy.sessionDirectory, { recursive: true, mode: 0o700 });

  const initialParent = getParent();
  const settingsSourceCwd = nested?.settingsSourceCwd ?? initialParent.cwd;
  const captureSources = {
    cwd: initialParent.cwd,
    agentDir: initialParent.agentDir,
    configurationFiles: policy.nodeImports,
    ...(nested
      ? {
          settingsSourceCwd,
          appendSystemPromptFiles: nested.profile.resources
            .filter((r) => r.kind === "append-prompt")
            .map((r) => r.path),
          systemPromptFile: nested.profile.resources.find((r) => r.kind === "system-prompt")?.path,
        }
      : {}),
  };
  const initialResources = captureProfileResources(initialParent.session.resourceLoader, {
    ...captureSources,
  });

  const availableContextTools = initialParent.session
    .getAllTools()
    .map((t) => t.name)
    .filter((t) => SUBAGENT_CONTEXT_TOOL_NAMES.includes(t));
  const broker = nested ? undefined : await LocalMessageBroker.start();
  const root = broker?.registerRoot(
    initialParent.session.sessionId,
    {
      name: "root",
      readOnly: false,
      allowedTools: [
        ...new Set([...initialParent.session.getActiveToolNames(), ...availableContextTools]),
      ],
    },
    limits,
    join(policy.sessionDirectory, "lifecycle"),
  );
  const binding = nested?.binding ?? root!.binding;
  const parentIdentity = {
    agentId: binding.agentId,
    sessionId: binding.sessionId,
    processId: binding.processId,
  };
  const parentClient =
    nested?.client ??
    (await LocalMessageClient.connect(root!.credential).catch(async (error) => {
      await broker?.close();
      throw error;
    }));
  const communication = new ProcessCommunication(
    parentClient,
    binding,
    initialParent.session,
    initialParent.eventBus,
    nested
      ? () => {
          const current = registry.read({
            taskId: binding.taskId!,
            ...nested.profile.identity,
            sessionFile: nested.profile.session.file,
            cwd: nested.profile.cwd,
            pid: process.pid,
            parentAgentId: nested.profile.parent.agentId,
            parentSessionId: nested.profile.parent.sessionId,
            ownership: "managed",
            revision: 0,
            routeParentId: nested.profile.parent.agentId,
          });
          if (current.ownership !== "managed") throw new ProcessIdentityError();
        }
      : undefined,
  );
  const unbindCommunication = initialParent.eventBus.on(COMMUNICATION_EVENT, (value) => {
    (value as { bind(channel: ProcessCommunication): void }).bind(communication);
  });
  const running = new Set<ProcessRpc>();
  const registry = new ProcessRegistry(join(policy.sessionDirectory, "lifecycle"));
  const runs = new Map<
    string,
    {
      handle: ProcessHandle;
      process?: ProcessRpc;
      identity: import("./process-results.ts").ResultIdentity;
      observe: (value: ProcessRegistration) => void;
      stopping: boolean;
    }
  >();
  const busySessions = new Set<string>();
  let disposed = false;

  async function capture(cwd: string) {
    const parent = getParent();
    if (disposed || parent.session.sessionId !== parentIdentity.sessionId)
      throw new ProcessProfileError("PARENT_SESSION_CHANGED");
    await parent.session.settingsManager.flush();
    const resources = captureProfileResources(parent.session.resourceLoader, {
      ...captureSources,
    });
    const settingsPaths = [
      join(parent.agentDir, "settings.json"),
      join(parent.cwd, ".pi/settings.json"),
    ];
    const immutable = (refs: typeof resources) =>
      refs.filter((ref) => !settingsPaths.includes(ref.path));
    if (JSON.stringify(immutable(resources)) !== JSON.stringify(immutable(initialResources)))
      throw new ProcessProfileError("PARENT_RESOURCE_CHANGED");
    const fromDisk = SettingsManager.create(settingsSourceCwd, parent.agentDir);
    if (
      nested
        ? JSON.stringify(childSettings(settingsSourceCwd, parent.agentDir, nested.profile)) !==
            JSON.stringify(parent.session.settingsManager.getGlobalSettings()) ||
          Object.keys(parent.session.settingsManager.getProjectSettings()).length !== 0
        : JSON.stringify(fromDisk.getGlobalSettings()) !==
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
    inspect(handle) {
      return registry.read(handle);
    },
    async takeover(handle, ownership) {
      const run = runs.get(handle.processId);
      if (
        !run?.process?.alive ||
        run.process.pid !== handle.pid ||
        run.process.processId !== handle.processId
      )
        throw new ProcessIdentityError();
      registry.read(handle);
      const value = await parentClient.control<ProcessRegistration>("takeover-process", {
        handle,
        ownership,
      });
      // Record, routing and ownership were atomically changed by the authenticated broker.
      run.handle = value;
      run.observe(value);
      run.process.cancelDialogs();
      return value;
    },
    async abort(handle) {
      const run = runs.get(handle.processId);
      const current = registry.read(handle);
      if (
        !run?.process?.alive ||
        current.ownership !== "managed" ||
        run.process.pid !== current.pid ||
        run.process.processId !== current.processId ||
        osProcessIdentity(run.process.pid) !== current.osIdentity
      )
        throw new ProcessIdentityError();
      run.stopping = true;
      const stopped = registry.update(handle, {
        phase: "stopped",
        error: "ABORTED",
        delivery: communication.results.get(run.identity.resultId)?.status,
      });
      run.observe(stopped);
      await run.process.close();
      if (run.process.alive) throw new ProcessIdentityError();
      await parentClient.control("release", {
        agentId: handle.agentId,
        processId: handle.processId,
      });
      running.delete(run.process);
      busySessions.delete(handle.sessionFile);
    },
    async cleanup(handle) {
      const run = runs.get(handle.processId);
      const current = registry.read(handle);
      if (
        !run?.process ||
        run.process.pid !== current.pid ||
        run.process.processId !== current.processId ||
        (run.process.alive && osProcessIdentity(run.process.pid) !== current.osIdentity) ||
        current.ownership !== "managed" ||
        !["cleanup-pending", "cleanup-error", "result-pending"].includes(current.phase)
      )
        throw new ProcessIdentityError();
      try {
        const delivery = communication.verifyIngested(run.identity);
        registry.update(handle, { phase: "cleanup-pending", delivery, error: undefined });
        run.stopping = true;
        await run.process?.close();
        if (run.process?.alive) throw new ProcessIdentityError();
        communication.verifyIngested(run.identity);
        await parentClient.control("release", {
          agentId: handle.agentId,
          processId: handle.processId,
        });
        // No await between the fresh identity check and this record mutation.
        const done = registry.update(handle, { phase: "completed", error: undefined });
        run.observe(done);
        if (run.process) running.delete(run.process);
        busySessions.delete(handle.sessionFile);
        return done;
      } catch (error) {
        run.stopping = false;
        const failed = registry.update(handle, {
          phase: "cleanup-error",
          error: error instanceof ProcessIdentityError ? error.code : "PROCESS_CLEANUP_FAILED",
        });
        run.observe(failed);
        throw error;
      }
    },
    async execute(input): Promise<ProcessExecutionResult> {
      if (binding.role.readOnly) throw new ProcessProfileError("ROLE_DELEGATION_FORBIDDEN");
      const cwd = realpathSync(input.cwd);
      const captured = await capture(cwd);
      const { parent, resources, classification, proofs } = captured;
      const resolved = resolveProcessStartProfile({
        parent: {
          identity: parentIdentity,
          cwd: parent.cwd,
          agentDir: parent.agentDir,
          sessionFile: parent.session.sessionFile ?? "",
          depth: binding.depth,
          model: { provider: parent.session.model!.provider, id: parent.session.model!.id },
          thinking: parent.session.thinkingLevel,
          activeTools: [
            ...new Set([...parent.session.getActiveToolNames(), ...availableContextTools]),
          ].filter((t) => binding.role.allowedTools.includes(t)),
          limits,
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
      const grant = await parentClient.control<{
        binding: GroupBinding;
        credential: ParticipantCredential;
      }>("reserve", {
        taskId: input.taskId,
        role: resolved.profile.role,
        maxConcurrent: resolved.profile.limits.maxConcurrent,
        maxDepth: resolved.profile.limits.maxDepth,
      });
      const profile = resolved.profile;
      profile.identity = {
        agentId: grant.binding.agentId,
        sessionId: grant.binding.sessionId,
        processId: grant.binding.processId,
      };
      profile.session.file = join(policy.sessionDirectory, `${grant.binding.sessionId}.jsonl`);
      profile.depth = grant.binding.depth;
      try {
        const roleFile = join(policy.sessionDirectory, `${grant.binding.sessionId}-role.md`);
        writeFileSync(
          roleFile,
          `Role binding: ${JSON.stringify({ role: profile.role, cwd: profile.cwd })}\nComplete only the assigned task.\n${input.roleInstructions ?? ""}`,
          { flag: "wx", mode: 0o400 },
        );
        profile.rolePrompt = referenceProfileFile(roleFile);
        profile.resources.push({ kind: "append-prompt", ...profile.rolePrompt });
        verifyProfileFiles(profile);
        reserveProcessSession(profile);
        return await run(input, profile, grant, proofs, captured.leases);
      } finally {
        const activeRun = [...runs.values()].find(
          (r) => r.handle.processId === grant.binding.processId,
        );
        if (
          !activeRun ||
          (!activeRun.process?.alive &&
            registry.read(activeRun.handle, false).ownership === "managed")
        )
          await parentClient.control("release", {
            agentId: grant.binding.agentId,
            processId: grant.binding.processId,
          });
      }
    },
  };

  async function run(
    input: ProcessExecution,
    profile: ProcessStartProfile,
    grant: { binding: GroupBinding; credential: ParticipantCredential },
    originalProofs: ReadyProtectionSnapshot[],
    originalLeases: ProtectionSnapshotLease[],
  ): Promise<ProcessExecutionResult> {
    if (disposed) throw new ProcessProfileError("PARENT_SESSION_CHANGED");
    if (busySessions.has(profile.session.file)) throw new ProcessProfileError("SESSION_BUSY");
    busySessions.add(profile.session.file);
    let process: ProcessRpc | undefined;
    let registration: ProcessRegistration | undefined;
    let successful = false;
    try {
      verifyProcessResources(profile);
      verifyProcessSession(profile);
      const fresh = await capture(profile.cwd);
      if (
        JSON.stringify(fresh.resources) !==
        JSON.stringify(profile.resources.filter((r) => r.path !== profile.rolePrompt?.path))
      )
        throw new ProcessProfileError("PARENT_RESOURCE_CHANGED");
      const incarnation = {
        ...profile,
        identity: { ...profile.identity, processId: grant.binding.processId },
      };
      const identity = {
        taskId: input.taskId,
        ...incarnation.identity,
        sessionFile: profile.session.file,
        cwd: profile.cwd,
      };
      const resultIdentity = {
        resultId: `${incarnation.identity.processId}:result`,
        taskId: input.taskId,
        childAgentId: incarnation.identity.agentId,
        childSessionId: incarnation.identity.sessionId,
        childProcessId: incarnation.identity.processId,
        parentSessionId: parentIdentity.sessionId,
      };
      communication.results.expect(resultIdentity);
      input.onIdentity?.(identity);
      registration = await parentClient.control<ProcessRegistration>("register-process", {
        ...identity,
        parentAgentId: parentIdentity.agentId,
        parentSessionId: parentIdentity.sessionId,
      });
      registration = registry.update(registration, {
        delivery: communication.results.get(resultIdentity.resultId)!.status,
      });
      const runRecord = {
        handle: registration as ProcessHandle,
        process: undefined as ProcessRpc | undefined,
        identity: resultIdentity,
        observe: (value: ProcessRegistration) => input.onIdentity?.(value),
        stopping: false,
      };
      runs.set(identity.processId, runRecord);
      input.onIdentity?.(registration);
      process = await ProcessRpc.start({
        processId: incarnation.identity.processId,
        onSpawn: async (rpc) => {
          process = rpc;
          running.add(rpc);
          runRecord.process = rpc;
          registration = await parentClient.control<ProcessRegistration>("bind-process", {
            handle: runRecord.handle,
            pid: rpc.pid,
          });
          runRecord.handle = registration;
          input.onIdentity?.(registration);
        },
        beforeMutation: (action) => {
          const current = registry.read(runRecord.handle);
          verifyProcessSession(profile);
          if (current.ownership !== "managed" && action !== "parent-exiting")
            throw new ProcessRpcError("PROCESS_OWNERSHIP_CHANGED");
          if (
            !runRecord.process ||
            runRecord.process.pid !== current.pid ||
            runRecord.process.processId !== current.processId ||
            getParent().session.sessionId !== current.parentSessionId
          )
            throw new ProcessIdentityError();
        },
        onExit: (code) => {
          if (!registration || runRecord.stopping) return;
          const current = registry.read(runRecord.handle);
          if (current.ownership !== "managed") return;
          const value = registry.update(runRecord.handle, {
            phase: "lost",
            error: code,
            delivery: communication.results.get(resultIdentity.resultId)?.status,
          });
          input.onIdentity?.(value);
        },
        ...(policy.humanAnswerChannel
          ? {
              onDialog: (
                request: import("./process-dialog.ts").ProcessDialogRequest,
                signal: AbortSignal,
              ) =>
                new Promise<import("./process-dialog.ts").ProcessDialogResponse>(
                  (resolve, reject) => {
                    if (signal.aborted) {
                      reject(new Error("DIALOG_CANCELLED"));
                      return;
                    }
                    signal.addEventListener("abort", () => reject(new Error("DIALOG_CANCELLED")), {
                      once: true,
                    });
                    initialParent.eventBus.emit(PROCESS_DIALOG_EVENT, {
                      request,
                      signal,
                      resolve,
                      reject,
                    });
                  },
                ),
            }
          : {}),
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
          taskGoal: input.prompt,
          protections: fresh.proofs,
          broker: grant.credential,
          groupBinding: grant.binding,
          settingsSourceCwd,
          hostPolicy: {
            ...policy,
            limits: profile.limits,
            onInspectionDiagnostic: undefined,
            extensions: [
              ...fresh.classification,
              {
                path: fileURLToPath(new URL("./process-boundary.ts", import.meta.url)),
                protectionId: null,
              },
            ].filter((entry, index, all) => all.findIndex((e) => e.path === entry.path) === index),
          },
        },
        onEvent: (event) => {
          if (
            registration &&
            (event.type === "process_dialog_pending" || event.type === "process_dialog_finished")
          ) {
            const current = registry.read(runRecord.handle);
            if (
              current.ownership === "managed" &&
              !runRecord.stopping &&
              ["starting", "running", "question"].includes(current.phase)
            ) {
              const value = registry.update(runRecord.handle, {
                phase: event.type === "process_dialog_pending" ? "question" : "running",
              });
              input.onIdentity?.(value);
            }
          }
          input.onEvent?.(event);
        },
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
            if (registration) input.onIdentity?.({ ...registry.read(runRecord.handle), pid });
            else input.onIdentity?.({ ...identity, pid });
          } catch (error) {
            // Keep our fixed validation code, never arbitrary extension error text.
            if (error instanceof ProcessProfileError) throw new ProcessRpcError(error.code);
            throw error;
          }
        },
      });
      running.add(process);
      input.onIdentity?.(registry.update(runRecord.handle, { phase: "running" }));
      const handoffPromise = communication.waitResult(
        resultIdentity,
        profile.limits.timeoutSeconds * 1000,
      );
      await process.prompt(`Task:\n${input.prompt}`, {
        maxTurns: profile.limits.maxTurns,
        timeoutMs: profile.limits.timeoutSeconds * 1000,
        signal: input.signal,
        completion: handoffPromise,
      });
      const handoff = await handoffPromise;
      input.onIdentity?.(
        registry.update(runRecord.handle, {
          phase: handoff.delivery.ingested ? "cleanup-pending" : "result-pending",
          delivery: handoff.delivery,
        }),
      );
      if (handoff.delivery.ingested) {
        try {
          await runner.cleanup!(runRecord.handle);
        } catch {
          /* Keep the received result, visible cleanup error and same-run retry handle. */
        }
      }
      successful = true;
      return {
        responseText: JSON.stringify(handoff.result, null, 2),
        delivery: handoff.delivery,
        resume: async (prompt, signal) => {
          const next = await parentClient.control<typeof grant>("resume", {
            agentId: grant.binding.agentId,
          });
          try {
            return await run(
              { ...input, prompt, signal },
              profile,
              next,
              originalProofs,
              originalLeases,
            );
          } finally {
            const nextRun = runs.get(next.binding.processId);
            if (
              !nextRun ||
              (!nextRun.process?.alive &&
                registry.read(nextRun.handle, false).ownership === "managed")
            )
              await parentClient.control("release", {
                agentId: next.binding.agentId,
                processId: next.binding.processId,
              });
          }
        },
      };
    } catch (error) {
      const held = registration && runs.get(registration.processId);
      if (held) {
        try {
          const current = registry.read(held.handle);
          if (current.ownership === "managed" && current.phase !== "cleanup-error") {
            held.stopping = true;
            const stopped = registry.update(held.handle, {
              phase:
                error instanceof ProcessIdentityError
                  ? "uncertain"
                  : error instanceof ProcessRpcError && error.code === "PROCESS_EXITED"
                    ? "lost"
                    : "stopped",
              error: error instanceof ProcessRpcError ? error.code : "PROCESS_RUN_FAILED",
              delivery: communication.results.get(held.identity.resultId)?.status,
            });
            input.onIdentity?.(stopped);
            await process?.close();
          }
        } catch {
          input.onEvent?.({ type: "process_identity_uncertain" });
          process?.detach();
        }
      } else await process?.close();
      throw error;
    } finally {
      if (process && !successful) {
        running.delete(process);
      }
      if (!successful || !process?.alive) busySessions.delete(profile.session.file);
    }
  }
  const unsubscribe = getParent().eventBus.on(PROCESS_RUNNER_EVENT, (request) => {
    (request as { bind(runner: ProcessRunner): void }).bind(runner);
  });
  let disposal: Promise<void> | undefined;
  return () =>
    (disposal ??= (async () => {
      disposed = true;
      unsubscribe();
      unbindCommunication();
      for (const run of runs.values()) {
        try {
          const current = registry.read(run.handle, false);
          if (current.phase === "completed" || !run.process?.alive) continue;
          if (current.ownership !== "managed") {
            registry.update(current, { parentState: "parent_exiting", error: "PARENT_EXITING" });
            run.process?.parentExiting();
            run.process?.detach();
            continue;
          }
          registry.update(run.handle, {
            parentState: "parent_exiting",
            phase: "stopped",
            error: "PARENT_EXITING",
          });
          run.stopping = true;
          run.process?.parentExiting();
        } catch {
          run.process?.detach();
        }
      }
      communication.close();
      await Promise.allSettled([...running].map((p) => p.close()));
      if (!nested) parentClient.close();
      await broker?.close();
    })());
}
