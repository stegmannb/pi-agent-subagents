/** Serializable, fail-closed launch plans. This module never starts a child. */
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceLoader } from "@mariozechner/pi-coding-agent";

export const PROCESS_PROFILE_VERSION = 1;
export const SUPPORTED_PI_VERSION = "0.73.0";
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ProcessThinking = (typeof THINKING)[number];
export type ResourceKind =
  | "instruction"
  | "skill"
  | "extension"
  | "configuration"
  | "provider"
  | "context"
  | "system-prompt"
  | "append-prompt";
export interface FileReference {
  path: string;
  sha256: string;
}
export interface ResourceReference extends FileReference {
  kind: ResourceKind;
}
export interface ProcessModel {
  provider: string;
  id: string;
}
export interface ProcessLimits {
  maxConcurrent: number;
  maxDepth: number;
  maxTurns: number;
  timeoutSeconds: number;
}
export interface ProcessIdentity {
  agentId: string;
  sessionId: string;
  /** Logical process incarnation, never an OS PID or a pane ID. */
  processId: string;
}
export interface ProtectionRequirement {
  id: string;
  extensionPath: string;
  /** A trusted protection adapter must attest replay for this exact child cwd. */
  replay: {
    kind: "file-backed";
    verifiedCwd: string;
    configurationFiles: FileReference[];
    environment: EnvironmentReference[];
  } | null;
}
export interface ParentProfileSnapshot {
  identity: ProcessIdentity;
  cwd: string;
  agentDir: string;
  sessionFile: string;
  depth: number;
  model: ProcessModel;
  thinking: ProcessThinking;
  activeTools: string[];
  limits: ProcessLimits;
  resources: ResourceReference[];
  /** Required even for an explicitly empty inventory. No heuristic name matching. */
  protectionInventory: "complete";
  /** Every loaded extension must be classified by the trusted capture adapter. */
  extensionClassification: Array<{ path: string; protectionId: string | null }>;
  protections: ProtectionRequirement[];
}
export interface EnvironmentReference {
  name: string;
  sha256: string;
}
export interface CredentialReferences {
  /** Existing auth storage, never read, hashed, copied or embedded in the profile. */
  authFile: string;
  environmentNames: string[];
}
export interface ProcessRole {
  name: string;
  readOnly: boolean;
  /** Exact tool names. Custom tools need an explicit allowance and are denied in read-only roles. */
  allowedTools: string[];
}
export interface ProcessStartProfile {
  version: 1;
  identity: ProcessIdentity;
  runtime: {
    node: FileReference & { version: string };
    pi: FileReference & { version: "0.73.0"; packageFile: FileReference };
  };
  cwd: string;
  agentDir: string;
  session: { file: string; formatVersion: 3 };
  depth: number;
  parent: ProcessIdentity & { context: FileReference | null };
  model: ProcessModel & { source: "inherited" | "override" };
  thinking: ProcessThinking;
  role: ProcessRole;
  rolePrompt?: FileReference;
  tools: string[];
  limits: ProcessLimits;
  resources: ResourceReference[];
  protections: Array<{
    id: string;
    extension: FileReference;
    configuration: FileReference[];
    environment: EnvironmentReference[];
    verifiedCwd: string;
  }>;
  /** Names and non-secret protection fingerprints; values stay outside the profile. */
  environment: { inherit: string[]; required: EnvironmentReference[] };
}
export interface ResolveProcessProfileOptions {
  parent: ParentProfileSnapshot;
  cwd: string;
  sessionDirectory: string;
  role: ProcessRole;
  availableModels: ProcessModel[];
  credentials: CredentialReferences;
  modelOverride?: ProcessModel;
  thinkingOverride?: ProcessThinking;
  limits?: Partial<ProcessLimits>;
  contextFile?: string;
  environmentAllowlist: string[];
}

export class ProcessProfileError extends Error {
  readonly code: string;
  constructor(code: string) {
    // Do not include paths, model IDs, tool names, env values or underlying errors.
    super(`Process start refused: ${code}. See docs/process-start-profile.md.`);
    this.name = "ProcessProfileError";
    this.code = code;
  }
}
function fail(code: string): never {
  throw new ProcessProfileError(code);
}
function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
/** Reject functions, cycles, accessors, class instances and lossy JSON values. */
function assertPlainJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) fail("NON_SERIALIZABLE_CONFIGURATION");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    fail("NON_SERIALIZABLE_CONFIGURATION");
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail("NON_SERIALIZABLE_CONFIGURATION");
    if (Reflect.ownKeys(value).length !== value.length + 1) fail("NON_SERIALIZABLE_CONFIGURATION");
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail("NON_SERIALIZABLE_CONFIGURATION");
    }
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("NON_SERIALIZABLE_CONFIGURATION");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      descriptor.get ||
      descriptor.set ||
      (!descriptor.enumerable && !(Array.isArray(value) && key === "length"))
    )
      fail("NON_SERIALIZABLE_CONFIGURATION");
    assertPlainJson(descriptor.value, seen);
  }
  seen.delete(value);
}
function absolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    fail("ABSOLUTE_PATH_REQUIRED");
  return path;
}
function directory(path: string): string {
  try {
    if (!statSync(absolute(path)).isDirectory()) fail("DIRECTORY_UNAVAILABLE");
    return realpathSync(path);
  } catch {
    return fail("DIRECTORY_UNAVAILABLE");
  }
}
export function referenceProfileFile(path: string): FileReference {
  try {
    const resolved = realpathSync(absolute(path));
    if (!statSync(resolved).isFile()) fail("RESOURCE_UNAVAILABLE");
    return { path: resolved, sha256: hash(readFileSync(resolved)) };
  } catch {
    return fail("RESOURCE_UNAVAILABLE");
  }
}
function unchanged(ref: FileReference): void {
  if (referenceProfileFile(ref.path).sha256 !== ref.sha256) fail("RESOURCE_CHANGED");
}
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// These can inject code, change the agent directory, disable protection or inherit pane identity.
const FORBIDDEN_ENV =
  /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PI_CODING_AGENT_DIR|PI_OFFLINE|CMUX_.*|HERDR_.*|TMUX.*|STY|.*(?:PID|SESSION_ID|PROCESS_ID|AGENT_ID))$/;
function names(values: string[]): string[] {
  if (
    !Array.isArray(values) ||
    values.some((v) => typeof v !== "string" || !ENV_NAME.test(v) || FORBIDDEN_ENV.test(v))
  ) {
    fail("ENVIRONMENT_NOT_ALLOWED");
  }
  return [...new Set(values)].sort();
}
function validModel(model: ProcessModel): void {
  if (
    !model ||
    typeof model.provider !== "string" ||
    !model.provider ||
    typeof model.id !== "string" ||
    !model.id
  )
    fail("MODEL_REQUIRED");
}
function validIdentity(identity: ProcessIdentity): void {
  if (
    !identity ||
    [identity.agentId, identity.sessionId, identity.processId].some(
      (s) => typeof s !== "string" || !s,
    )
  )
    fail("IDENTITY_REQUIRED");
}
function runtime(): ProcessStartProfile["runtime"] {
  const packagePath = join(
    dirname(fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"))),
    "..",
    "package.json",
  );
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    fail("PI_RUNTIME_UNAVAILABLE");
  }
  if (pkg.version !== SUPPORTED_PI_VERSION || pkg.bin?.pi !== "dist/cli.js")
    fail("UNSUPPORTED_PI_VERSION");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 6)) fail("UNSUPPORTED_NODE_VERSION");
  try {
    accessSync(process.execPath, constants.X_OK);
  } catch {
    fail("NODE_RUNTIME_UNAVAILABLE");
  }
  return {
    node: { ...referenceProfileFile(process.execPath), version: process.versions.node },
    pi: {
      ...referenceProfileFile(join(dirname(packagePath), "dist/cli.js")),
      version: SUPPORTED_PI_VERSION,
      packageFile: referenceProfileFile(packagePath),
    },
  };
}

/** Fingerprint non-credential protection settings without retaining their values. */
export function referenceProfileEnvironment(
  environmentNames: string[],
  source: Readonly<Record<string, string | undefined>>,
): EnvironmentReference[] {
  return names(environmentNames).map((name) => {
    const value = source[name];
    if (typeof value !== "string") fail("REQUIRED_ENVIRONMENT_MISSING");
    return { name, sha256: hash(value) };
  });
}

/** Capture the parent's already-loaded effective inventory without loading extensions again. */
export function captureProfileResources(
  loader: Pick<
    ResourceLoader,
    "getExtensions" | "getSkills" | "getAgentsFiles" | "getSystemPrompt" | "getAppendSystemPrompt"
  >,
  sources: {
    cwd: string;
    agentDir: string;
    configurationFiles?: string[];
    settingsSourceCwd?: string;
    providerFiles?: string[];
    systemPromptFile?: string;
    appendSystemPromptFiles?: string[];
  },
): ResourceReference[] {
  const extensions = loader.getExtensions();
  const skills = loader.getSkills();
  if (extensions.errors.length || skills.diagnostics.some((d) => d.type === "error"))
    fail("PARENT_RESOURCE_ERRORS");
  const result: ResourceReference[] = [];
  const add = (kind: ResourceKind, path: string, content?: string) => {
    const ref = referenceProfileFile(path);
    if (content !== undefined && hash(content) !== ref.sha256)
      fail("NON_REPRODUCIBLE_INSTRUCTIONS");
    if (!result.some((r) => r.kind === kind && r.path === ref.path)) result.push({ kind, ...ref });
  };
  for (const entry of loader.getAgentsFiles().agentsFiles)
    add("instruction", entry.path, entry.content);
  for (const entry of skills.skills) add("skill", entry.filePath);
  for (const entry of extensions.extensions) add("extension", entry.resolvedPath);
  const cwd = directory(sources.cwd);
  const agentDir = directory(sources.agentDir);
  for (const path of [
    join(agentDir, "settings.json"),
    join(sources.settingsSourceCwd ?? cwd, ".pi/settings.json"),
  ]) {
    if (existsSync(path)) add("configuration", path);
  }
  const defaultPrompt = (name: string) =>
    [join(cwd, ".pi", name), join(agentDir, name)].find(existsSync);
  const system = loader.getSystemPrompt();
  if (system !== undefined) {
    const path = sources.systemPromptFile ?? defaultPrompt("SYSTEM.md");
    if (!path) fail("NON_REPRODUCIBLE_INSTRUCTIONS");
    add("system-prompt", path, system);
  }
  const appended = loader.getAppendSystemPrompt();
  const defaultAppend = defaultPrompt("APPEND_SYSTEM.md");
  const appendFiles = sources.appendSystemPromptFiles ?? (defaultAppend ? [defaultAppend] : []);
  if (appended.length !== appendFiles.length) fail("NON_REPRODUCIBLE_INSTRUCTIONS");
  appended.forEach((text, index) => add("append-prompt", appendFiles[index], text));
  const models = join(agentDir, "models.json");
  if (existsSync(models)) add("provider", models);
  for (const path of sources.configurationFiles ?? []) add("configuration", path);
  for (const path of sources.providerFiles ?? []) add("provider", path);
  return result;
}

/** Resolve from a trusted parent snapshot; no processes, installs or credential reads. */
function resolveProfile(options: ResolveProcessProfileOptions): {
  profile: ProcessStartProfile;
  credentials: CredentialReferences;
} {
  assertPlainJson(options);
  const parent = options.parent;
  if (parent.protectionInventory !== "complete") fail("PROTECTION_INVENTORY_REQUIRED");
  validIdentity(parent.identity);
  validModel(parent.model);
  directory(parent.cwd);
  const cwd = directory(options.cwd);
  const agentDir = directory(parent.agentDir);
  const sessionDirectory = directory(options.sessionDirectory);
  absolute(parent.sessionFile);
  absolute(options.credentials.authFile);
  if (!Number.isSafeInteger(parent.depth) || parent.depth < 0) fail("INVALID_DEPTH");
  const limits: ProcessLimits = {
    maxConcurrent: options.limits?.maxConcurrent ?? parent.limits.maxConcurrent,
    maxDepth: options.limits?.maxDepth ?? parent.limits.maxDepth,
    maxTurns: options.limits?.maxTurns ?? parent.limits.maxTurns,
    timeoutSeconds: options.limits?.timeoutSeconds ?? parent.limits.timeoutSeconds,
  };
  for (const key of ["maxConcurrent", "maxDepth", "maxTurns", "timeoutSeconds"] as const) {
    if (
      !Number.isSafeInteger(parent.limits[key]) ||
      parent.limits[key] < 1 ||
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > parent.limits[key]
    )
      fail("LIMIT_ESCALATION");
  }
  if (parent.depth + 1 > limits.maxDepth) fail("DEPTH_EXCEEDED");
  const model = options.modelOverride ?? parent.model;
  validModel(model);
  if (!options.availableModels.some((m) => m.provider === model.provider && m.id === model.id))
    fail("UNKNOWN_MODEL");
  const thinking = options.thinkingOverride ?? parent.thinking;
  if (!THINKING.includes(thinking)) fail("UNSUPPORTED_THINKING");
  if (
    typeof options.role.name !== "string" ||
    !options.role.name ||
    typeof options.role.readOnly !== "boolean" ||
    !Array.isArray(options.role.allowedTools)
  )
    fail("INVALID_ROLE");
  if (
    options.role.allowedTools.some((t) => typeof t !== "string" || !parent.activeTools.includes(t))
  )
    fail("TOOL_ESCALATION");
  const tools = [...new Set(options.role.allowedTools)].filter(
    (t) => !options.role.readOnly || ["read", "grep", "find", "ls"].includes(t),
  );
  const resources = parent.resources.map((ref) => {
    if (
      ![
        "instruction",
        "skill",
        "extension",
        "configuration",
        "provider",
        "context",
        "system-prompt",
        "append-prompt",
      ].includes(ref.kind)
    )
      fail("INVALID_RESOURCE_KIND");
    unchanged(ref);
    return { kind: ref.kind, path: ref.path, sha256: ref.sha256 };
  });
  const classified = new Set<string>();
  for (const entry of parent.extensionClassification) {
    const path = referenceProfileFile(entry.path).path;
    if (classified.has(path) || !resources.some((r) => r.kind === "extension" && r.path === path))
      fail("INVALID_EXTENSION_CLASSIFICATION");
    classified.add(path);
    if (
      entry.protectionId !== null &&
      !parent.protections.some(
        (p) => p.id === entry.protectionId && referenceProfileFile(p.extensionPath).path === path,
      )
    )
      fail("REQUIRED_PROTECTION_MISSING");
  }
  if (resources.some((r) => r.kind === "extension" && !classified.has(r.path)))
    fail("EXTENSION_CLASSIFICATION_REQUIRED");
  const inherit = names(options.environmentAllowlist);
  const credentialNames = names(options.credentials.environmentNames);
  if (credentialNames.some((name) => inherit.includes(name)))
    fail("CREDENTIAL_ENVIRONMENT_OVERLAP");
  const required: EnvironmentReference[] = [];
  const protectionIds = new Set<string>();
  const protections = parent.protections.map((protection) => {
    if (!protection.id || protectionIds.has(protection.id)) fail("INVALID_PROTECTION_INVENTORY");
    protectionIds.add(protection.id);
    if (!protection.replay || protection.replay.kind !== "file-backed")
      fail("NON_REPRODUCIBLE_PROTECTION");
    if (directory(protection.replay.verifiedCwd) !== cwd) fail("PROTECTION_CWD_NOT_VERIFIED");
    const extension = referenceProfileFile(protection.extensionPath);
    if (
      !parent.extensionClassification.some(
        (e) =>
          e.protectionId === protection.id && referenceProfileFile(e.path).path === extension.path,
      )
    )
      fail("INVALID_EXTENSION_CLASSIFICATION");
    if (
      !resources.some(
        (r) => r.kind === "extension" && r.path === extension.path && r.sha256 === extension.sha256,
      )
    )
      fail("REQUIRED_PROTECTION_MISSING");
    const configuration = protection.replay.configurationFiles.map((ref) => {
      unchanged(ref);
      return { path: ref.path, sha256: ref.sha256 };
    });
    const environment = protection.replay.environment.map((ref) => {
      names([ref.name]);
      if (!/^[a-f0-9]{64}$/.test(ref.sha256)) fail("INVALID_ENVIRONMENT_REFERENCE");
      if (!inherit.includes(ref.name)) fail("PROTECTION_ENVIRONMENT_MISSING");
      if (required.some((r) => r.name === ref.name && r.sha256 !== ref.sha256))
        fail("CONFLICTING_PROTECTION_ENVIRONMENT");
      required.push({ name: ref.name, sha256: ref.sha256 });
      return { name: ref.name, sha256: ref.sha256 };
    });
    return { id: protection.id, extension, configuration, environment, verifiedCwd: cwd };
  });
  const identity = { agentId: randomUUID(), sessionId: randomUUID(), processId: randomUUID() };
  const sessionFile = join(sessionDirectory, `${identity.sessionId}.jsonl`);
  if (existsSync(sessionFile) || sessionFile === parent.sessionFile) fail("SESSION_COLLISION");
  const profile: ProcessStartProfile = {
    version: PROCESS_PROFILE_VERSION,
    identity,
    runtime: runtime(),
    cwd,
    agentDir,
    session: { file: sessionFile, formatVersion: 3 },
    depth: parent.depth + 1,
    parent: {
      agentId: parent.identity.agentId,
      sessionId: parent.identity.sessionId,
      processId: parent.identity.processId,
      context: options.contextFile ? referenceProfileFile(options.contextFile) : null,
    },
    model: {
      provider: model.provider,
      id: model.id,
      source: options.modelOverride ? "override" : "inherited",
    },
    thinking,
    role: { name: options.role.name, readOnly: options.role.readOnly, allowedTools: [...tools] },
    tools,
    limits,
    resources,
    protections,
    environment: { inherit, required },
  };
  return {
    profile,
    credentials: { authFile: options.credentials.authFile, environmentNames: credentialNames },
  };
}

/** Resolve errors never expose values from malformed or unsupported input. */
export function resolveProcessStartProfile(options: ResolveProcessProfileOptions): {
  profile: ProcessStartProfile;
  credentials: CredentialReferences;
} {
  try {
    return resolveProfile(options);
  } catch (error) {
    if (error instanceof ProcessProfileError) throw error;
    return fail("INVALID_PROFILE_INPUT");
  }
}

/** Recheck references immediately before launch. Does not attest successful child loading. */
export function verifyProfileFiles(profile: ProcessStartProfile): void {
  if (
    profile.version !== PROCESS_PROFILE_VERSION ||
    profile.runtime.pi.version !== SUPPORTED_PI_VERSION
  )
    fail("UNSUPPORTED_PROFILE_VERSION");
  directory(profile.cwd);
  directory(profile.agentDir);
  directory(dirname(profile.session.file));
  if (existsSync(profile.session.file)) fail("SESSION_COLLISION");
  for (const ref of [
    profile.runtime.node,
    profile.runtime.pi,
    profile.runtime.pi.packageFile,
    ...profile.resources,
    ...profile.protections.flatMap((p) => [p.extension, ...p.configuration]),
    ...(profile.parent.context ? [profile.parent.context] : []),
  ])
    unchanged(ref);
}

/** Values exist only in the transient spawn environment; never pass this result to diagnostics. */
export function materializeProfileEnvironment(
  profile: ProcessStartProfile,
  credentials: CredentialReferences,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const inherit = names(profile.environment.inherit);
  const credentialNames = names(credentials.environmentNames);
  const required = names(profile.environment.required.map((ref) => ref.name));
  if (required.some((name) => !inherit.includes(name))) fail("PROTECTION_ENVIRONMENT_MISSING");
  const result: Record<string, string> = {};
  for (const name of [...inherit, ...credentialNames]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
    else if (required.includes(name) || credentialNames.includes(name))
      fail("REQUIRED_ENVIRONMENT_MISSING");
  }
  for (const ref of profile.environment.required) {
    if (hash(result[ref.name]) !== ref.sha256) fail("PROTECTION_ENVIRONMENT_CHANGED");
  }
  result.PI_CODING_AGENT_DIR = profile.agentDir;
  return result;
}

/** Intentionally omits every caller-controlled string, even paths and environment names. */
export function diagnoseProcessProfile(
  profile: ProcessStartProfile,
): Record<string, number | boolean> {
  return {
    version: profile.version,
    instructionCount: profile.resources.filter((r) => r.kind === "instruction").length,
    skillCount: profile.resources.filter((r) => r.kind === "skill").length,
    extensionCount: profile.resources.filter((r) => r.kind === "extension").length,
    protectionCount: profile.protections.length,
    toolCount: profile.tools.length,
    readOnly: profile.role.readOnly,
    modelOverride: profile.model.source === "override",
  };
}
