import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ProcessRpc } from "../../src/process-rpc.ts";
import type { ProcessObservation } from "../../src/process-contract.ts";
import type { WorktreeStatus } from "../../src/worktree.ts";

test(
  "actual Agent snapshot selection and explicit integration preserve parent changes and refuse conflicts",
  {
    timeout: 90_000,
  },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pasa-workspace-tools-")));
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir);
    const git = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args]);
    const commit = (path: string) =>
      git(
        path,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      );
    git(cwd, "init", "-q");
    await writeFile(join(cwd, "staged.txt"), "base staged\n");
    await writeFile(join(cwd, "unstaged.txt"), "base unstaged\n");
    git(cwd, "add", ".");
    commit(cwd);
    const base = git(cwd, "rev-parse", "HEAD").toString().trim();
    git(cwd, "branch", "explicit-base", base);
    await writeFile(join(cwd, "staged.txt"), "parent staged\n");
    git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "unstaged.txt"), "parent unstaged\n");
    await writeFile(join(cwd, "selected.txt"), "selected new file\n");
    await writeFile(join(cwd, "unselected.txt"), "leave in parent\n");
    const parentIndex = await readFile(join(cwd, ".git/index"));
    const parentBranch = git(cwd, "symbolic-ref", "HEAD");
    const config = join(root, "host.json");
    await writeFile(
      config,
      JSON.stringify({
        cwd,
        agentDir,
        model: { provider: "role-test", id: "role-test" },
        policy: {
          sessionDirectory: join(root, "children"),
          extensions: [
            {
              path: fileURLToPath(new URL("./fixtures/role-provider.ts", import.meta.url)),
              protectionId: null,
            },
          ],
          environmentAllowlist: ["HOME", "PATH", "PASA_ROLE_TRACE"],
          credentials: { authFile: join(agentDir, "auth.json"), environmentNames: [] },
          limits: { maxConcurrent: 4, maxDepth: 2, maxTurns: 4, timeoutSeconds: 20 },
        },
      }),
    );
    const outcomes: Array<{
      tool: string;
      result: { content: Array<{ text?: string }>; details?: any };
      isError: boolean;
    }> = [];
    let client: ProcessRpc | undefined;
    try {
      client = await ProcessRpc.start({
        executable: process.execPath,
        args: [fileURLToPath(new URL("../../src/process-host.ts", import.meta.url)), config, "rpc"],
        cwd,
        environment: {
          HOME: root,
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDir,
          PASA_ROLE_TRACE: join(root, "trace.jsonl"),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        verifyReady: async (state) => {
          assert.equal(state.model?.provider, "role-test");
        },
        onEvent: (event) => {
          const e = event as any;
          if (e.type === "tool_execution_end")
            outcomes.push({ tool: e.toolName, result: e.result, isError: e.isError });
        },
      });
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const before = outcomes.length;
        await client!.prompt(`HOST:${JSON.stringify([{ name, arguments: args }])}`, {
          maxTurns: 4,
          timeoutMs: 25_000,
        });
        const events = outcomes.slice(before).filter((e) => e.tool === name);
        assert.equal(events.length, 1, JSON.stringify(outcomes.slice(before)));
        return { ...events[0].result, isError: events[0].isError };
      };
      const agent = (args: Record<string, unknown> = {}) =>
        invoke("Agent", {
          description: "Workspace tool probe",
          subagent_type: "general-purpose",
          runner: "rpc",
          prompt: "CHILD:[]",
          isolation: "worktree",
          ...args,
        });
      for (const selection of [{}, { worktree_base: "explicit-base" }]) {
        const result = await agent(selection);
        assert.equal(result.details?.status, "completed", JSON.stringify(result));
        const worktree = result.details.worktree as WorktreeStatus;
        assert.equal(worktree.baseCommit, base);
        assert.equal(worktree.snapshot, undefined);
        assert.equal(await readFile(join(worktree.path, "staged.txt"), "utf8"), "base staged\n");
        const refusal = await invoke("integrate_subagent_worktree", {
          agent_id: result.details.agentId,
        });
        assert.match(JSON.stringify(refusal.content), /requires a working-changes snapshot/);
      }
      for (const [selection, expected] of [
        [{ isolation: undefined, worktree_snapshot: {} }, /worktree_snapshot requires isolation/],
        [
          { worktree_base: "HEAD", worktree_snapshot: {} },
          /worktree_base and worktree_snapshot are mutually exclusive/,
        ],
        [
          { resume: "unknown", worktree_snapshot: {} },
          /worktree_snapshot cannot be combined with resume/,
        ],
      ] as const) {
        const result = await agent(selection);
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.match(JSON.stringify(result.content), expected);
      }
      const result = await agent({ worktree_snapshot: { untracked_paths: ["selected.txt"] } });
      assert.equal(result.details?.status, "completed", JSON.stringify(result));
      const { agentId } = result.details;
      const worktree = result.details.worktree as WorktreeStatus;
      const first = result.details.process as ProcessObservation;
      assert.ok(first.pid && first.pid !== client.pid);
      assert.ok(worktree.snapshot);
      assert.equal(worktree.snapshot.parentHead, base);
      assert.deepEqual(worktree.snapshot.untrackedPaths, ["selected.txt"]);
      assert.equal(await readFile(join(first.cwd, "staged.txt"), "utf8"), "parent staged\n");
      assert.equal(await readFile(join(first.cwd, "unstaged.txt"), "utf8"), "parent unstaged\n");
      assert.equal(await readFile(join(first.cwd, "selected.txt"), "utf8"), "selected new file\n");
      await assert.rejects(readFile(join(first.cwd, "unselected.txt")), { code: "ENOENT" });
      assert.deepEqual(await readFile(join(cwd, ".git/index")), parentIndex);
      assert.deepEqual(git(cwd, "symbolic-ref", "HEAD"), parentBranch);
      assert.equal(git(cwd, "rev-parse", "HEAD").toString().trim(), base);
      const excluded = await agent({
        worktree_snapshot: { exclude_paths: ["custom-private"], untracked_paths: ["selected.txt"] },
      });
      assert.equal(excluded.details.status, "completed", JSON.stringify(excluded));
      const owned = excluded.details.worktree as WorktreeStatus;
      await mkdir(join(owned.path, "custom-private"));
      await writeFile(join(owned.path, "custom-private/new.txt"), "excluded child bytes\n");
      git(owned.path, "add", "custom-private/new.txt");
      commit(owned.path);
      const ordinaryRefusal = await invoke("integrate_subagent_worktree", {
        agent_id: excluded.details.agentId,
      });
      assert.equal(ordinaryRefusal.details.integrated, false);
      assert.match(
        JSON.stringify(ordinaryRefusal.details.conflicts),
        /Excluded secret or ignored resource/,
      );
      const registrationFile = join(owned.id, "pi-subagents.json");
      const registration = JSON.parse(await readFile(registrationFile, "utf8"));
      registration.snapshot.excludePaths = [];
      await writeFile(registrationFile, JSON.stringify(registration));
      const tamperedRefusal = await invoke("integrate_subagent_worktree", {
        agent_id: excluded.details.agentId,
      });
      assert.equal(tamperedRefusal.details.integrated, false);
      assert.match(JSON.stringify(tamperedRefusal.details.conflicts), /registration mismatch/);
      await assert.rejects(readFile(join(cwd, "custom-private/new.txt")), { code: "ENOENT" });
      assert.deepEqual(await readFile(join(cwd, ".git/index")), parentIndex);
      assert.deepEqual(git(cwd, "symbolic-ref", "HEAD"), parentBranch);
      assert.equal(git(cwd, "rev-parse", "HEAD").toString().trim(), base);
      for (const [path, content] of [
        ["staged.txt", "parent staged\n"],
        ["unstaged.txt", "parent unstaged\n"],
        ["selected.txt", "selected new file\n"],
        ["unselected.txt", "leave in parent\n"],
      ])
        assert.equal(await readFile(join(cwd, path), "utf8"), content);

      const resumed = await agent({
        resume: agentId,
        prompt: `CHILD:${JSON.stringify([
          { name: "write", arguments: { path: "child.txt", content: "child delta\n" } },
        ])}`,
      });
      assert.equal(resumed.details?.status, "completed", JSON.stringify(resumed));
      assert.equal(resumed.details.process.sessionId, first.sessionId);
      assert.equal(resumed.details.process.cwd, first.cwd);
      assert.notEqual(resumed.details.process.pid, first.pid);
      const dirty = await invoke("integrate_subagent_worktree", { agent_id: agentId });
      assert.equal(dirty.details.integrated, false);
      assert.match(
        JSON.stringify(dirty.details.conflicts),
        /Commit or remove child working changes/,
      );
      await assert.rejects(readFile(join(cwd, "child.txt")), { code: "ENOENT" });
      // Set up a clean committed child revision; the actual integration goes through the model tool.
      git(first.cwd, "add", "child.txt");
      commit(first.cwd);
      const childHead = git(first.cwd, "rev-parse", "HEAD").toString().trim();
      await writeFile(join(cwd, "child.txt"), "concurrent parent edit\n");
      const conflict = await invoke("integrate_subagent_worktree", { agent_id: agentId });
      assert.equal(conflict.details.integrated, false);
      assert.equal(await readFile(join(cwd, "child.txt"), "utf8"), "concurrent parent edit\n");
      await rm(join(cwd, "child.txt"));
      const integrated = await invoke("integrate_subagent_worktree", { agent_id: agentId });
      assert.equal(integrated.details.integrated, true, JSON.stringify(integrated));
      assert.equal(integrated.details.childHead, childHead);
      assert.deepEqual(integrated.details.changedPaths, ["child.txt"]);
      assert.equal(await readFile(join(cwd, "child.txt"), "utf8"), "child delta\n");
      assert.equal(await readFile(join(cwd, "staged.txt"), "utf8"), "parent staged\n");
      assert.equal(await readFile(join(cwd, "unstaged.txt"), "utf8"), "parent unstaged\n");
      assert.equal(await readFile(join(cwd, "selected.txt"), "utf8"), "selected new file\n");
      assert.equal(await readFile(join(cwd, "unselected.txt"), "utf8"), "leave in parent\n");
      assert.deepEqual(await readFile(join(cwd, ".git/index")), parentIndex);
      assert.deepEqual(git(cwd, "symbolic-ref", "HEAD"), parentBranch);
      assert.equal(git(cwd, "rev-parse", "HEAD").toString().trim(), base);
    } finally {
      await client?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
