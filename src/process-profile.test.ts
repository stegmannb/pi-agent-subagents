import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@mariozechner/pi-coding-agent";
import {
  captureProfileResources,
  diagnoseProcessProfile,
  materializeProfileEnvironment,
  ProcessProfileError,
  referenceProfileEnvironment,
  referenceProfileFile,
  resolveProcessStartProfile,
  SUPPORTED_PI_VERSION,
  verifyProfileFiles,
  type ResolveProcessProfileOptions,
} from "./process-profile.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pasa-profile-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const sessions = join(root, "sessions");
  for (const path of [cwd, agentDir, sessions]) mkdirSync(path);
  const file = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  file(join(agentDir, "settings.json"), JSON.stringify({ skills: ["!SKILL.md"] }));
  const guard = file(join(agentDir, "extensions/guard.ts"), "export default () => {};\n");
  const config = file(join(agentDir, "guard.json"), '{"enabled":true}');
  const instruction = file(join(cwd, "AGENTS.md"), "Keep protections enabled.\n");
  const context = file(join(root, "context.md"), "Review this bounded task.\n");
  const options: ResolveProcessProfileOptions = {
    parent: {
      identity: {
        agentId: "parent-agent",
        sessionId: "parent-session",
        processId: "parent-process",
      },
      cwd,
      agentDir,
      sessionFile: join(sessions, "parent.jsonl"),
      depth: 0,
      model: { provider: "fixture", id: "parent" },
      thinking: "medium",
      activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "custom"],
      limits: { maxConcurrent: 4, maxDepth: 2, maxTurns: 20, timeoutSeconds: 600 },
      resources: [
        { kind: "instruction", ...referenceProfileFile(instruction) },
        { kind: "extension", ...referenceProfileFile(guard) },
      ],
      protectionInventory: "complete",
      extensionClassification: [{ path: guard, protectionId: "guard" }],
      protections: [
        {
          id: "guard",
          extensionPath: guard,
          replay: {
            kind: "file-backed",
            verifiedCwd: cwd,
            configurationFiles: [referenceProfileFile(config)],
            environment: referenceProfileEnvironment(["PI_GUARD"], {
              PI_GUARD: '{"enabled":true}',
            }),
          },
        },
      ],
    },
    cwd,
    sessionDirectory: sessions,
    role: { name: "worker", readOnly: false, allowedTools: ["read", "bash", "write"] },
    availableModels: [
      { provider: "fixture", id: "parent" },
      { provider: "fixture", id: "override" },
    ],
    credentials: { authFile: join(agentDir, "auth.json"), environmentNames: ["FIXTURE_API_KEY"] },
    contextFile: context,
    environmentAllowlist: ["PATH", "HOME", "PI_GUARD"],
  };
  return { root, options, guard, config, file };
}
function refuses(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProcessProfileError);
    assert.equal(error.code, code);
    return true;
  };
}

test("profile has independent identities, pinned executable runtime and a new persistent session target", (t) => {
  const { options } = fixture(t);
  const { profile, credentials } = resolveProcessStartProfile(options);
  assert.notEqual(profile.identity.agentId, options.parent.identity.agentId);
  assert.notEqual(profile.identity.sessionId, options.parent.identity.sessionId);
  assert.notEqual(profile.identity.processId, options.parent.identity.processId);
  assert.equal(new Set(Object.values(profile.identity)).size, 3);
  assert.equal(
    profile.session.file,
    join(options.sessionDirectory, `${profile.identity.sessionId}.jsonl`),
  );
  assert.equal(existsSync(profile.session.file), false);
  assert.equal(profile.session.formatVersion, 3);
  assert.equal(profile.runtime.pi.version, SUPPORTED_PI_VERSION);
  assert.equal(profile.runtime.node.version, process.versions.node);
  assert.equal(
    JSON.parse(readFileSync(profile.runtime.pi.packageFile.path, "utf8")).version,
    SUPPORTED_PI_VERSION,
  );
  assert.equal(profile.model.source, "inherited");
  assert.equal(profile.depth, 1);
  assert.equal(profile.parent.context?.path, options.contextFile);
  assert.equal("credentials" in profile, false);
  assert.deepEqual(credentials, options.credentials);
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile);
  verifyProfileFiles(profile);
});

test("equivalent inputs reproduce configuration, while each resolution gets new identities", (t) => {
  const { options } = fixture(t);
  const first = resolveProcessStartProfile(options).profile;
  const second = resolveProcessStartProfile(JSON.parse(JSON.stringify(options))).profile;
  assert.notDeepEqual(first.identity, second.identity);
  assert.notEqual(first.session.file, second.session.file);
  assert.deepEqual(
    { ...first, identity: null, session: null },
    { ...second, identity: null, session: null },
  );
});

test("read-only role removes shell, mutations and custom tools but retains guard resources", (t) => {
  const { options } = fixture(t);
  options.role = {
    name: "reviewer",
    readOnly: true,
    allowedTools: [...options.parent.activeTools],
  };
  const { profile } = resolveProcessStartProfile(options);
  assert.deepEqual(profile.tools, ["read", "grep", "find", "ls"]);
  assert.equal(profile.protections.length, 1);
  assert.deepEqual(profile.resources, options.parent.resources);
  options.role.allowedTools.push("not-granted");
  assert.throws(() => resolveProcessStartProfile(options), refuses("TOOL_ESCALATION"));
});

test("model override is exact, explicit and fails rather than falling back", (t) => {
  const { options } = fixture(t);
  options.modelOverride = { provider: "fixture", id: "override" };
  options.thinkingOverride = "high";
  const { profile } = resolveProcessStartProfile(options);
  assert.deepEqual(profile.model, { provider: "fixture", id: "override", source: "override" });
  assert.equal(profile.thinking, "high");
  options.modelOverride.id = "unknown-secret-model";
  assert.throws(
    () => resolveProcessStartProfile(options),
    (error: unknown) => {
      refuses("UNKNOWN_MODEL")(error);
      assert.doesNotMatch(String(error), /unknown-secret-model/);
      return true;
    },
  );
  delete options.modelOverride;
  options.availableModels = [];
  assert.throws(() => resolveProcessStartProfile(options), refuses("UNKNOWN_MODEL"));
});

test("limits only narrow and depth cannot exceed the group limit", (t) => {
  const { options } = fixture(t);
  options.limits = { maxTurns: 5, maxConcurrent: 2 };
  assert.equal(resolveProcessStartProfile(options).profile.limits.maxTurns, 5);
  options.limits.maxConcurrent = 5;
  assert.throws(() => resolveProcessStartProfile(options), refuses("LIMIT_ESCALATION"));
  options.limits.maxConcurrent = 2;
  options.parent.depth = 2;
  assert.throws(() => resolveProcessStartProfile(options), refuses("DEPTH_EXCEEDED"));
});

test("missing, unclassified and non-reproducible protection is refused", (t) => {
  const { options } = fixture(t);
  options.parent.protections = [];
  assert.throws(() => resolveProcessStartProfile(options), refuses("REQUIRED_PROTECTION_MISSING"));
  options.parent.extensionClassification = [];
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("EXTENSION_CLASSIFICATION_REQUIRED"),
  );
  options.parent.protectionInventory = undefined as never;
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("NON_SERIALIZABLE_CONFIGURATION"),
  );
});

test("no replay, wrong child cwd, missing config, and live extension objects fail closed", (t) => {
  const { options, config, root } = fixture(t);
  const requirement = options.parent.protections[0];
  const replay = requirement.replay!;
  requirement.replay = null;
  assert.throws(() => resolveProcessStartProfile(options), refuses("NON_REPRODUCIBLE_PROTECTION"));
  requirement.replay = replay;
  options.cwd = root;
  assert.throws(() => resolveProcessStartProfile(options), refuses("PROTECTION_CWD_NOT_VERIFIED"));
  options.cwd = options.parent.cwd;
  requirement.replay = { ...replay, callback: () => {} } as never;
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("NON_SERIALIZABLE_CONFIGURATION"),
  );
  requirement.replay = replay;
  rmSync(config);
  assert.throws(() => resolveProcessStartProfile(options), refuses("RESOURCE_UNAVAILABLE"));
});

test("changed configuration, resource or occupied session is rejected during preflight", (t) => {
  const { options, config } = fixture(t);
  const { profile } = resolveProcessStartProfile(options);
  writeFileSync(config, '{"enabled":false}');
  assert.throws(() => verifyProfileFiles(profile), refuses("RESOURCE_CHANGED"));
  writeFileSync(config, '{"enabled":true}');
  writeFileSync(profile.session.file, "another session");
  assert.throws(() => verifyProfileFiles(profile), refuses("SESSION_COLLISION"));
  rmSync(profile.session.file);
  writeFileSync(options.parent.resources[0].path, "changed instructions");
  assert.throws(() => resolveProcessStartProfile(options), refuses("RESOURCE_CHANGED"));
});

test("environment is allowlisted, credential values stay transient, and diagnostics redact all inputs", (t) => {
  const { options } = fixture(t);
  const secret = "fixture-token-do-not-log";
  options.role.name = secret;
  const { profile, credentials } = resolveProcessStartProfile(options);
  const env = materializeProfileEnvironment(profile, credentials, {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    PI_GUARD: '{"enabled":true}',
    FIXTURE_API_KEY: secret,
    OTHER_TOKEN: "other-secret",
    NODE_OPTIONS: "--import evil",
    CMUX_SURFACE_ID: "parent-pane",
  });
  assert.deepEqual(env, {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    PI_GUARD: '{"enabled":true}',
    FIXTURE_API_KEY: secret,
    PI_CODING_AGENT_DIR: profile.agentDir,
  });
  const diagnostic = JSON.stringify(diagnoseProcessProfile(profile));
  assert.doesNotMatch(diagnostic, /fixture-token|parent-pane|fixture\/bin|API_KEY|PI_GUARD/);
  assert.throws(
    () => materializeProfileEnvironment(profile, credentials, { FIXTURE_API_KEY: secret }),
    refuses("REQUIRED_ENVIRONMENT_MISSING"),
  );
  assert.throws(
    () =>
      materializeProfileEnvironment(profile, credentials, {
        FIXTURE_API_KEY: secret,
        PI_GUARD: '{"enabled":false}',
      }),
    refuses("PROTECTION_ENVIRONMENT_CHANGED"),
  );
  options.environmentAllowlist.push("FIXTURE_API_KEY");
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("CREDENTIAL_ENVIRONMENT_OVERLAP"),
  );
});

test("injection and parent process/pane identity variables cannot be allowlisted", (t) => {
  const { options } = fixture(t);
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "PI_CODING_AGENT_DIR",
    "CMUX_SURFACE_ID",
    "HERDR_PANE",
    "TMUX",
    "PARENT_PID",
    "AGENT_ID",
  ]) {
    options.environmentAllowlist = [name];
    assert.throws(() => resolveProcessStartProfile(options), refuses("ENVIRONMENT_NOT_ALLOWED"));
  }
});

test("an empty tool allowance remains empty", (t) => {
  const { options } = fixture(t);
  options.role.allowedTools = [];
  assert.deepEqual(resolveProcessStartProfile(options).profile.tools, []);
});

test("Pi 0.73.0 captures effective project/global and explicit resources with configuration references", async (t) => {
  const { options, file, root } = fixture(t);
  const { cwd, agentDir } = options.parent;
  file(join(agentDir, "AGENTS.md"), "Global rules.\n");
  file(
    join(agentDir, "skills/global/SKILL.md"),
    "---\nname: global\ndescription: global skill\n---\nGlobal.\n",
  );
  file(
    join(cwd, ".pi/skills/project/SKILL.md"),
    "---\nname: project\ndescription: project skill\n---\nProject.\n",
  );
  const explicitSkill = file(
    join(root, "explicit/SKILL.md"),
    "---\nname: explicit\ndescription: explicit skill\n---\nExplicit.\n",
  );
  const explicitExtension = file(join(root, "explicit-extension.ts"), "export default () => {};\n");
  const settingsExtension = file(join(root, "settings-extension.ts"), "export default () => {};\n");
  file(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultModel: "global",
      extensions: [settingsExtension],
      skills: ["!SKILL.md", "+skills/global/SKILL.md"],
    }),
  );
  file(join(cwd, ".pi/settings.json"), JSON.stringify({ defaultModel: "project" }));
  const models = file(
    join(agentDir, "models.json"),
    '{"providers":{"fixture":{"apiKey":"fixture-secret"}}}',
  );
  const settings = SettingsManager.create(cwd, agentDir);
  assert.equal(settings.getDefaultModel(), "project");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    additionalExtensionPaths: [explicitExtension],
    additionalSkillPaths: [explicitSkill],
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const resources = captureProfileResources(loader, { cwd, agentDir });
  assert.deepEqual(
    resources.filter((r) => r.kind === "instruction").map((r) => r.path),
    [join(agentDir, "AGENTS.md"), join(cwd, "AGENTS.md")],
  );
  assert.equal(resources.filter((r) => r.kind === "skill").length, 3);
  assert.deepEqual(
    new Set(resources.filter((r) => r.kind === "extension").map((r) => r.path)),
    new Set([explicitExtension, settingsExtension, options.parent.protections[0].extensionPath]),
  );
  assert.equal(resources.filter((r) => r.kind === "configuration").length, 2);
  assert.equal(resources.find((r) => r.kind === "provider")?.path, models);
  assert.doesNotMatch(JSON.stringify(resources), /fixture-secret/);
  writeFileSync(join(cwd, "AGENTS.md"), "Changed since parent load");
  assert.throws(
    () => captureProfileResources(loader, { cwd, agentDir }),
    refuses("NON_REPRODUCIBLE_INSTRUCTIONS"),
  );
});

test("inline extension factories cannot be captured as reproducible file resources", async (t) => {
  const { options } = fixture(t);
  const { cwd, agentDir } = options.parent;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [() => {}],
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  assert.throws(
    () => captureProfileResources(loader, { cwd, agentDir }),
    refuses("RESOURCE_UNAVAILABLE"),
  );
});

test("protection configuration changed after attestation is rejected before resolution", (t) => {
  const { options, config } = fixture(t);
  writeFileSync(config, '{"enabled":false}');
  assert.throws(() => resolveProcessStartProfile(options), refuses("RESOURCE_CHANGED"));
});

test("malformed shape and accessors cannot leak input values through start errors", (t) => {
  const { options } = fixture(t);
  assert.throws(
    () => resolveProcessStartProfile({ parent: null } as never),
    refuses("INVALID_PROFILE_INPUT"),
  );
  Object.defineProperty(options.parent, "secret", {
    get() {
      throw new Error("secret-value");
    },
  });
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("NON_SERIALIZABLE_CONFIGURATION"),
  );
});

test("missing inventory and missing required environment cannot be treated as empty protection", (t) => {
  const { options } = fixture(t);
  delete (options.parent as Partial<typeof options.parent>).protectionInventory;
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("PROTECTION_INVENTORY_REQUIRED"),
  );
  options.parent.protectionInventory = "complete";
  options.environmentAllowlist = ["HOME"];
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("PROTECTION_ENVIRONMENT_MISSING"),
  );
});

test("resource capture refuses loader errors without exposing their text", async (t) => {
  const { options, file, root } = fixture(t);
  const { cwd, agentDir } = options.parent;
  const bad = file(join(root, "broken.ts"), 'throw new Error("secret-value");');
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [bad],
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  assert.throws(
    () => captureProfileResources(loader, { cwd, agentDir }),
    refuses("PARENT_RESOURCE_ERRORS"),
  );
});

test("system prompt source uses project precedence and refuses runtime-only overrides", async (t) => {
  const { options, file } = fixture(t);
  const { cwd, agentDir } = options.parent;
  file(join(agentDir, "SYSTEM.md"), "global system");
  const projectSystem = file(join(cwd, ".pi/SYSTEM.md"), "project system");
  const append = file(join(agentDir, "APPEND_SYSTEM.md"), "append system");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const resources = captureProfileResources(loader, { cwd, agentDir });
  assert.equal(resources.find((r) => r.kind === "system-prompt")?.path, projectSystem);
  assert.equal(resources.find((r) => r.kind === "append-prompt")?.path, append);
  const overridden = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => "runtime secret prompt",
    noPromptTemplates: true,
    noThemes: true,
  });
  await overridden.reload();
  assert.throws(
    () => captureProfileResources(overridden, { cwd, agentDir }),
    refuses("NON_REPRODUCIBLE_INSTRUCTIONS"),
  );
});

test("lossy arrays, cycles and class instances are not valid launch configuration", (t) => {
  const { options } = fixture(t);
  const original = options.parent.protections;
  options.parent.protections = [];
  options.parent.protections.length = 1; // Deliberate hole, unlike an explicit undefined value.
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("NON_SERIALIZABLE_CONFIGURATION"),
  );
  options.parent.protections = original;
  (options.parent as unknown as Record<string, unknown>).cycle = options.parent;
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("NON_SERIALIZABLE_CONFIGURATION"),
  );
  delete (options.parent as unknown as Record<string, unknown>).cycle;
  options.parent.protections[0].replay = new Map() as never;
  assert.throws(
    () => resolveProcessStartProfile(options),
    refuses("NON_SERIALIZABLE_CONFIGURATION"),
  );
});
