import { validateQualificationPreset } from "./process-qualification.ts";
/** Companion host for Pi 0.73.0, using only its exported SDK APIs. */
import { readFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createEventBus,
  SessionManager,
  InteractiveMode,
  initTheme,
  runRpcMode,
  type AgentSessionRuntime,
} from "@mariozechner/pi-coding-agent";
import { attachProcessRunner } from "./process-runner.ts";
import { ProcessProfileError, SUPPORTED_PI_VERSION } from "./process-profile.ts";
import type { ProcessHostPolicy } from "./process-contract.ts";

export interface CompanionHostOptions {
  cwd: string;
  agentDir: string;
  model: { provider: string; id: string };
  policy: ProcessHostPolicy;
  sessionFile?: string;
  /** Explicit trusted host configuration: fixed diagnostics to stderr, default off. */
  inspectionDiagnostics?: boolean;
}
export async function createCompanionHost(
  options: CompanionHostOptions,
): Promise<{ runtime: AgentSessionRuntime; close(): Promise<void> }> {
  validateQualificationPreset(options.policy.qualificationPreset);
  const packagePath = join(
    dirname(fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"))),
    "../package.json",
  );
  if (JSON.parse(readFileSync(packagePath, "utf8")).version !== SUPPORTED_PI_VERSION)
    throw new ProcessProfileError("UNSUPPORTED_PI_VERSION");
  const cwd = realpathSync(options.cwd);
  const agentDir = realpathSync(options.agentDir);
  if (realpathSync(process.cwd()) !== cwd || process.env.PI_CODING_AGENT_DIR !== agentDir)
    throw new ProcessProfileError("HOST_BOOTSTRAP_MISMATCH");
  const extension = realpathSync(fileURLToPath(new URL("../index.ts", import.meta.url)));
  const entries = [...options.policy.extensions];
  if (!entries.some((entry) => realpathSync(entry.path) === extension))
    entries.push({ path: extension, protectionId: null });
  const hasSandbox = entries.some((entry) => entry.protectionId === "pi-agent-sandbox");
  if (hasSandbox)
    process.env.PASA_SANDBOX_PI_ENTRY = fileURLToPath(
      import.meta.resolve("@mariozechner/pi-coding-agent"),
    );
  const environmentAllowlist = [
    ...new Set([
      ...options.policy.environmentAllowlist,
      ...(hasSandbox ? ["PASA_SANDBOX_PI_ENTRY"] : []),
    ]),
  ];
  let diagnosticCount = 0;
  let detach: (() => Promise<void>) | undefined;
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      if (realpathSync(process.cwd()) !== cwd) throw new ProcessProfileError("HOST_CWD_CHANGED");
      await detach?.();
      const eventBus = createEventBus();
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: { eventBus, additionalExtensionPaths: entries.map((e) => e.path) },
      });
      if (
        services.diagnostics.some((d) => d.type === "error") ||
        services.resourceLoader.getExtensions().errors.length
      )
        throw new ProcessProfileError("PARENT_RESOURCE_ERRORS");
      const model = services.modelRegistry.find(options.model.provider, options.model.id);
      // RPC extensions also receive a UI context and may use its theme at session_start.
      initTheme(services.settingsManager.getTheme(), false);
      if (
        !model ||
        !(await services.modelRegistry.getAvailable()).some(
          (m) => m.provider === model.provider && m.id === model.id,
        )
      )
        throw new ProcessProfileError("UNKNOWN_MODEL");
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
      });
      detach = await attachProcessRunner(
        () => ({ session: created.session, cwd, agentDir, eventBus }),
        {
          ...options.policy,
          extensions: entries,
          environmentAllowlist,
          ...(options.inspectionDiagnostics === true
            ? {
                onInspectionDiagnostic: (record) => {
                  if (diagnosticCount++ < 512)
                    console.error("PASA_INSPECTION " + JSON.stringify(record));
                },
              }
            : {}),
        },
      );
      return { ...created, services, diagnostics: services.diagnostics };
    },
    {
      cwd,
      agentDir,
      sessionManager: options.sessionFile
        ? SessionManager.open(options.sessionFile)
        : SessionManager.create(cwd),
    },
  );
  return {
    runtime,
    async close() {
      await detach?.();
      await runtime.dispose();
    },
  };
}

export async function runCompanionHost(
  options: CompanionHostOptions,
  mode: "interactive" | "rpc",
): Promise<void> {
  const host = await createCompanionHost(options);
  try {
    if (mode === "rpc") await runRpcMode(host.runtime);
    else await new InteractiveMode(host.runtime).run();
  } finally {
    await host.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [configPath, mode = "interactive"] = process.argv.slice(2);
  if (!configPath || !["interactive", "rpc"].includes(mode)) {
    console.error("Usage: node src/process-host.ts <host-config.json> [interactive|rpc]");
    process.exitCode = 2;
  } else {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as CompanionHostOptions;
    mkdirSync(config.agentDir, { recursive: true, mode: 0o700 });
    process.chdir(config.cwd);
    process.env.PI_CODING_AGENT_DIR = realpathSync(config.agentDir);
    void runCompanionHost(config, mode as "interactive" | "rpc").catch((error) => {
      console.error(error instanceof ProcessProfileError ? error.message : "Companion host failed");
      process.exitCode = 1;
    });
  }
}
