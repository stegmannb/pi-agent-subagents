# Process start profiles

`src/process-profile.ts` defines the PASA process launch contract, version 1.
It resolves and checks a serializable plan. It does **not** start Pi, install
packages, reserve a session, integrate with the existing runner, or prove that a
child has loaded its protections. The [RPC runner and companion host](process-runner.md) implement those steps;
profile resolution alone is never permission to send a prompt.

## Supported Pi runtime

The repository pins `@mariozechner/pi-coding-agent` to **0.73.0**. The resolver
checks the installed package version and `dist/cli.js` entry point, and records
canonical paths and SHA-256 fingerprints for the CLI, package manifest and
current Node executable. It records the running Node version; Pi requires
Node >=20.6.0 and this repo's development environment uses Node 22. Other Pi
versions fail with `UNSUPPORTED_PI_VERSION`, despite the broader peer range.

The implementation was checked against the installed 0.73.0 package:

- `dist/core/resource-loader.{js,d.ts}` exposes effective instruction files,
  skills, extension entry points, and system/append prompts.
- `dist/core/settings-manager.{js,d.ts}` loads global and project settings.
- `dist/cli/args.{js,d.ts}` supports `--mode rpc`, `--session`, `--provider`,
  `--model`, `--thinking`, `--tools`, `--extension`, and `--skill`.
- `dist/core/session-manager.{js,d.ts}` uses session header format version 3.

Supported thinking values are `off`, `minimal`, `low`, `medium`, `high`, and
`xhigh`. Model selection uses exact provider/id pairs supplied by the trusted
parent registry adapter. It never fuzzy-matches or silently falls back.
A caller must supply the effective parent model, even when it came from settings.

A plain `pi --mode rpc` invocation cannot enforce the whole profile. Pi's
`--tools` option controls built-in tools, not the entire extension tool set;
`--session` alone does not assign the planned header ID. The runner binds the full contract through its private bootstrap and readiness
inspection.

## Capture and trust boundary

Call `captureProfileResources(parentResourceLoader, sources)` on the parent's
**already loaded** resource loader. The function does not reload or execute
extensions. Capture uses effective resources instead of guessing from package
names or rescanning a worktree with different settings.

| Source | Treatment |
| --- | --- |
| Global instructions and ancestor/project AGENTS/CLAUDE files | Preserve the loader's order and verify loaded text against the referenced file. Pi chooses the first AGENTS.md, AGENTS.MD, CLAUDE.md or CLAUDE.MD per directory. |
| Global/project auto-discovered skills and extensions, including user/ancestor `.agents/skills` | Preserve the effective loader selection and order. |
| Settings/package and explicit CLI extension/skill paths | Capture their resolved local entry points/SKILL.md files from the loader. Package source URLs and live extension objects are not copied. |
| Global `agentDir/settings.json` and parent `cwd/.pi/settings.json` | Record existing files as configuration references. Pi project scalar settings override global values; use the effective loader for resource-specific merging and package filters. |
| Global `agentDir/models.json` | Record an existing file as a provider reference. Contents, including any inline credential, never enter the profile or diagnostics. |
| Extension-registered providers or settings outside those files | The capture adapter must declare the responsible extension and extra `providerFiles`/`configurationFiles`. In-memory registrations require a replayable extension or refusal. |
| SYSTEM.md and APPEND_SYSTEM.md | Project `.pi` files take precedence over agentDir files. Explicit file lists can identify CLI sources. Content must match the effective loader text. Unbacked string/callback overrides fail. |
| Parent conversation/handoff | Optional caller-selected context file reference, separate from instructions and credentials. Caller prepares only the intended bounded context. |
| auth.json and credential environment | Separate `CredentialReferences`; auth storage is not read or copied. Environment values are supplied only at launch. |

Paths must be absolute, readable local files. Symlinks are canonicalized. The
capture adapter must run while the parent's resources are stable and attest that
its file references still represent the loaded code/configuration. Pi does not
expose hashes of code as originally executed, transitive extension dependencies,
all runtime settings overrides, or arbitrary live protection state. Capturing a
current entry point hash cannot establish those facts by itself.

`ParentProfileSnapshot` is trusted integration input, **not** a model-generated
attestation or an untrusted IPC schema. `protectionInventory: "complete"` is
mandatory. Every captured extension also needs an `extensionClassification`
entry, either with its required `protectionId` or an explicit `null` meaning the
trusted adapter established that it is not a protection component. An empty or
forgotten classification fails when any extension exists. A role cannot edit
this inventory. The adapter must never classify a guard or sandbox as ordinary
to make resolution succeed.

Each required protection needs a `file-backed` replay declaration containing:

- Its loaded extension entry point.
- File references captured with `referenceProfileFile` for all files needed to
  reproduce its effective configuration, including relevant
  imported code/config dependencies or immutable deployment manifests.
- Fingerprints of non-credential environment settings used by that protection.
- `verifiedCwd`, the exact canonical child working directory for which the
  adapter verified the reproduction rules.

Use `referenceProfileEnvironment(names, parentEnvironment)` to fingerprint
non-secret protection settings. Credential names must stay separate. Empty file
and environment lists are valid only when the adapter has established that the
protection's built-in defaults fully reproduce the effective configuration.
There is no generic proof that a JSON file means an enabled sandbox. The adapter
must know the extension's loading, enablement and override semantics.

A live factory, callback, cyclic object, Map, class instance, accessor, or other
non-JSON input fails. A missing replay declaration, missing component, different
child cwd or unallowlisted protection environment also fails. There is no
`--no-extensions` fallback and no role-level switch to remove protections.

## Resolution and precedence

`resolveProcessStartProfile(options)` returns `{ profile, credentials }`.
Serialize only `profile` for the non-credential launch plan. The second value
contains references, never credential values, and belongs to the runner's
credential binding. The result contains only constructed fields, not extension
instances, arbitrary environment values or a copy of the parent session.

Precedence is deliberately narrow:

1. Use the parent's effective resources, protections, model, thinking and limits.
2. Apply an explicit model/thinking override. Unknown models fail with
   `UNKNOWN_MODEL`; the registry adapter must also reject unavailable providers.
3. Restrict tools to the role's exact subset of parent active tool names.
   Requests outside that subset fail. Read-only roles additionally retain only
   `read`, `grep`, `find`, and `ls`, removing shell, mutations and all custom tools.
   An empty allowance stays empty. Extension code still loads for protection
   hooks; this tool policy is not an OS sandbox or a proof that a tool override
   with a built-in name is read-only.
4. Apply only positive, finite integer limit reductions. The parent supplies the
   group defaults, normally four concurrent children and depth two. The resolver
   checks depth; the broker/runner must enforce live concurrency, turns and time.

Each resolution creates new UUIDs for `agentId`, `sessionId` and logical
`processId`. `profile.depth` is the child's depth. `parent` contains only the
parent's logical identities and an optional context reference. No parent PID,
pane association or session filename is inherited. The new session path is
`sessionDirectory/<sessionId>.jsonl` and must not exist. The session directory
must already exist; the resolver makes no files or directories.

`materializeProfileEnvironment(profile, credentials, source)` constructs a fresh
environment from the explicit name allowlist plus credential names. There is no
spread of `process.env`. Missing required values or changed protection setting
fingerprints fail. Node/dynamic-loader injection variables, inherited process
and pane identifiers, and caller-controlled `PI_CODING_AGENT_DIR` are forbidden.
The latter is set from `profile.agentDir`. The allowlist itself is trusted policy:
only include variables actually needed; values such as HOME and PATH can affect
configuration discovery and must agree with the protection adapter's evidence.
The returned environment contains secrets and must never be logged or persisted.

`verifyProfileFiles(profile)` rechecks referenced files and session availability
immediately before launch. It is a drift check for a trusted resolved profile,
not a parser or authenticity check for arbitrary JSON. Local files can still
change after this check; readiness verification and appropriate filesystem
controls belong to the runner. Profiles are local-host plans, not portable
bundles or a content-addressed copy of all transitive package dependencies.

## Required runner integration

The companion SDK host supplies the actual parent ResourceLoader and consumes
the Guard/Sandbox snapshot-v1 adapters from their owning packages. Missing or
unsupported adapters refuse delegation. Merely passing
`protectionInventory: "complete"` is not evidence. See
[the host contract](process-runner.md) for its productive entrypoint, strict
classification, and child readiness checks.

Before allowing the child to process a task, the runner must:

1. Recheck references, materialize the allowlisted environment, and atomically
   reserve a private session file with its planned version-3 header/session ID.
   Keep the directory and file inaccessible to other users. Record the actual OS
   PID separately after spawn. Resumption needs its own ownership validation;
   this API resolves fresh launches only.
2. Load the declared resource order and effective settings without ambient
   rediscovery silently adding, replacing or dropping resources. Translate
   parent project references for a worktree only after the protection adapter
   verifies that exact cwd. Do not fetch missing packages or clone credentials.
3. Bind the referenced credential storage explicitly through Pi's AuthStorage
   and model registry. Replay extension-registered providers and validate model
   availability without exposing keys. Do not pass keys on the CLI.
4. Compare child-loaded resource identities, protection enablement/configuration
   and active tool policy with the profile. Extension registration or loading
   errors block readiness. Apply the complete tool restriction after extension
   binding and prevent later widening. Limits and broker identity also need
   enforcement. No task prompt may run before this acknowledgement.

## Diagnostics and tests

Only `diagnoseProcessProfile(profile)` is intended for logs. It returns numeric
counts and booleans, excluding paths, IDs, names, prompts and environment values.
Treat raw profiles and context/configuration files as private data, even though
credential values are not inserted by the resolver. `ProcessProfileError`
messages contain fixed error codes and the reference path, never the failing
input or underlying filesystem/loader error.

Useful failure codes include `PROTECTION_INVENTORY_REQUIRED`,
`EXTENSION_CLASSIFICATION_REQUIRED`, `REQUIRED_PROTECTION_MISSING`,
`NON_REPRODUCIBLE_PROTECTION`, `PROTECTION_CWD_NOT_VERIFIED`,
`PROTECTION_ENVIRONMENT_CHANGED`, `RESOURCE_CHANGED`, `TOOL_ESCALATION`,
`LIMIT_ESCALATION`, `DEPTH_EXCEEDED`, `UNKNOWN_MODEL`, `SESSION_COLLISION`, and
`NON_SERIALIZABLE_CONFIGURATION`. Fix the capture/configuration source; do not
retry with protection disabled.

`src/process-profile.test.ts` runs in the existing `pnpm test` / `test:unit`
path. Fixtures use the pinned Pi loader with temporary global/project and
explicit resources. They use fake provider and environment credentials and
never start a productive child. Passing these tests proves the profile checks,
not process integration or Guard/Sandbox parity.
