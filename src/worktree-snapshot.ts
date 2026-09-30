/** Raw working-content snapshots and explicit, conservative child integration. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createWorktree, loadWorktree } from "./worktree.ts";
import type { WorktreeInfo, SnapshotInfo } from "./worktree.ts";

export interface SnapshotOptions {
  /** Exact repository-relative file paths; directories and globs are rejected. */
  untrackedPaths?: string[];
  /** Additional repository-relative files or directory prefixes to omit. */
  excludePaths?: string[];
}

export interface IntegrationResult {
  integrated: boolean;
  childHead?: string;
  changedPaths: string[];
  conflicts: { path: string; reason: string }[];
  /** Only populated if an external writer prevented safe rollback. */
  recoveryPaths?: string[];
}

type Entry = { mode: string; data: Buffer };
type Files = Map<string, Entry>;
type Identity = { head: string; branch: string; index: Buffer; status: Buffer };

// Never inherit routing to another repository/index from a parent process.
async function git(
  cwd: string,
  args: string[],
  input?: Buffer | string,
  allowNoMatch = false,
): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("Git operation timed out");
      child.kill();
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        failure = new Error("Git output exceeds snapshot limit");
        child.kill();
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure || (code !== 0 && !(allowNoMatch && code === 1)))
        reject(failure ?? new Error(Buffer.concat(err).toString().trim()));
      else resolve(Buffer.concat(out));
    });
    child.stdin.end(input);
  });
}

async function text(cwd: string, args: string[], input?: string | Buffer): Promise<string> {
  return (await git(cwd, args, input)).toString().trim();
}

function validPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error(`Unsafe repository-relative path: ${JSON.stringify(path)}`);
  }
  return path;
}

function excluded(path: string, excludes: string[]): boolean {
  return (
    path
      .split("/")
      .some(
        (part) =>
          /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.kube|\.?secrets?(?:\..*)?|\.?credentials?(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|node_modules|\.devenv|\.direnv)$/i.test(
            part,
          ) || /\.(?:pem|key|p12|pfx)$/i.test(part),
      ) || excludes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}

async function ignored(cwd: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  // Exit 1 means no matches; other Git failures must abort.
  const result = await git(
    cwd,
    ["check-ignore", "--no-index", "--stdin", "-z", "-v", "--non-matching"],
    `${paths.join("\0")}\0`,
    true,
  );
  const fields = result.toString().split("\0");
  const matches = new Set<string>();
  for (let i = 0; i + 3 < fields.length; i += 4) {
    if (fields[i + 2] && !fields[i + 2].startsWith("!")) matches.add(fields[i + 3]);
  }
  return matches;
}

async function root(cwd: string): Promise<string> {
  return realpath(await text(cwd, ["rev-parse", "--show-toplevel"]));
}

async function identity(cwd: string): Promise<Identity> {
  const indexPath = await text(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  return {
    head: await text(cwd, ["rev-parse", "--verify", "HEAD"]),
    branch: await text(cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]),
    index: await readFile(indexPath),
    status: await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.head === b.head &&
    a.branch === b.branch &&
    a.index.equals(b.index) &&
    a.status.equals(b.status)
  );
}

function same(a: Entry | undefined, b: Entry | undefined): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined && a.mode === b.mode && a.data.equals(b.data);
}

function sameFiles(a: Files, b: Files): boolean {
  return a.size === b.size && [...a].every(([path, entry]) => same(entry, b.get(path)));
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Check every ancestor before opening, including nested Git worktrees. */
async function safeParents(cwd: string, path: string): Promise<void> {
  let dir = cwd;
  for (const part of validPath(path).split("/").slice(0, -1)) {
    dir = join(dir, part);
    const info = await stat(dir);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe ancestor: ${path}`);
    if (await stat(join(dir, ".git")))
      throw new Error(`Nested repositories are unsupported: ${path}`);
  }
}

async function readEntry(cwd: string, path: string): Promise<Entry | undefined> {
  await safeParents(cwd, path);
  const absolute = join(cwd, path);
  const info = await stat(absolute);
  if (!info) return undefined;
  if (info.isSymbolicLink())
    return { mode: "120000", data: await readlink(absolute, { encoding: "buffer" }) };
  if (!info.isFile()) throw new Error(`Unsupported file type or directory: ${path}`);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev)
      throw new Error(`Concurrent change: ${path}`);
    return { mode: info.mode & 0o111 ? "100755" : "100644", data: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function rejectNested(cwd: string, excludes: string[], relative = ""): Promise<void> {
  const children = await readdir(join(cwd, relative), { withFileTypes: true });
  const dirs = children
    .filter((child) => child.isDirectory() && child.name !== ".git")
    .map((child) => (relative ? `${relative}/${child.name}` : child.name));
  const skip = await ignored(cwd, dirs);
  for (const path of dirs) {
    if (excluded(path, excludes) || skip.has(path)) continue;
    const nested = join(cwd, path);
    const bare =
      (await stat(join(nested, "HEAD")))?.isFile() &&
      (await stat(join(nested, "objects")))?.isDirectory() &&
      (await stat(join(nested, "refs")))?.isDirectory();
    if (bare || (await stat(join(nested, ".git"))))
      throw new Error(`Nested repositories are unsupported: ${path}`);
    await rejectNested(cwd, excludes, path);
  }
}

async function tree(cwd: string, commit: string): Promise<Files> {
  const files: Files = new Map();
  const records = new TextDecoder("utf-8", { fatal: true })
    .decode(await git(cwd, ["ls-tree", "-rz", "--full-tree", commit]))
    .split("\0")
    .filter(Boolean);
  for (const record of records) {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const path = validPath(record.slice(tab + 1));
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode))
      throw new Error(`Submodules or unsupported tree entries: ${path}`);
    files.set(path, { mode, data: await git(cwd, ["cat-file", "blob", oid]) });
  }
  return files;
}

async function capture(
  cwd: string,
  options: SnapshotOptions,
): Promise<{ files: Files; identity: Identity }> {
  const before = await identity(cwd);
  const excludes = (options.excludePaths ?? []).map(validPath);
  await rejectNested(cwd, excludes);
  const base = await tree(cwd, before.head);
  const index = new TextDecoder("utf-8", { fatal: true })
    .decode(await git(cwd, ["ls-files", "--stage", "-z"]))
    .split("\0")
    .filter(Boolean);
  const tracked = new Set(base.keys());
  for (const record of index) {
    const tab = record.indexOf("\t");
    const [mode, , stage] = record.slice(0, tab).split(" ");
    const path = validPath(record.slice(tab + 1));
    if (mode === "160000") throw new Error(`Submodules are unsupported: ${path}`);
    if (stage !== "0") throw new Error(`Unmerged index entry: ${path}`);
    tracked.add(path);
  }
  const selected = (options.untrackedPaths ?? []).map(validPath);
  const paths = [...new Set([...tracked, ...selected])].sort();
  const skip = await ignored(cwd, paths);
  for (const path of selected) {
    if (tracked.has(path)) throw new Error(`Selected untracked path is tracked: ${path}`);
    if (excluded(path, excludes) || skip.has(path))
      throw new Error(`Selected path is excluded: ${path}`);
  }
  const files: Files = new Map();
  for (const path of paths) {
    if (excluded(path, excludes) || skip.has(path)) continue;
    const entry = await readEntry(cwd, path);
    if (entry) files.set(path, entry);
    else if (selected.includes(path)) throw new Error(`Selected path is missing: ${path}`);
  }
  if (!sameIdentity(before, await identity(cwd)))
    throw new Error("Concurrent parent HEAD/index/status change during snapshot");
  return { files, identity: before };
}

async function writeTree(cwd: string, files: Files): Promise<string> {
  type Node = Map<string, Entry | Node>;
  const top: Node = new Map();
  for (const [path, entry] of files) {
    const parts = path.split("/");
    let node = top;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      const child = node.get(part)!;
      if (!(child instanceof Map)) throw new Error(`Conflicting paths: ${path}`);
      node = child;
    }
    node.set(parts.at(-1)!, entry);
  }
  async function write(node: Node): Promise<string> {
    const records: string[] = [];
    for (const [name, entry] of node) {
      if (entry instanceof Map) records.push(`040000 tree ${await write(entry)}\t${name}\0`);
      else
        records.push(
          `${entry.mode} blob ${await text(cwd, ["hash-object", "-w", "--stdin"], entry.data)}\t${name}\0`,
        );
    }
    return text(cwd, ["mktree", "-z"], records.join(""));
  }
  return write(top);
}

/** Creates a retained worktree whose base contains selected current parent bytes. */
export async function createSnapshotWorktree(
  cwd: string,
  agentId: string,
  options: SnapshotOptions = {},
): Promise<WorktreeInfo> {
  options = {
    untrackedPaths: [...(options.untrackedPaths ?? [])],
    excludePaths: [...(options.excludePaths ?? [])],
  };
  cwd = await root(cwd);
  const first = await capture(cwd, options);
  const treeId = await writeTree(cwd, first.files);
  const second = await capture(cwd, options);
  if (!sameIdentity(first.identity, second.identity) || !sameFiles(first.files, second.files)) {
    throw new Error("Concurrent parent change during snapshot; no worktree created");
  }
  const commit = await text(
    cwd,
    [
      "-c",
      "user.name=Pi snapshot",
      "-c",
      "user.email=pi-snapshot@localhost",
      "commit-tree",
      treeId,
      "-p",
      first.identity.head,
    ],
    "Immutable working-content snapshot\n",
  );
  // Check after object creation too; no parent index/ref is ever written.
  const final = await capture(cwd, options);
  if (!sameIdentity(first.identity, final.identity) || !sameFiles(first.files, final.files))
    throw new Error("Concurrent parent change during snapshot; no worktree created");
  const ref = `refs/pi-subagents/snapshots/${randomUUID()}`;
  await git(cwd, ["update-ref", ref, commit, ""]);
  const snapshot: SnapshotInfo = {
    parentPath: cwd,
    parentHead: first.identity.head,
    ref,
    excludePaths: options.excludePaths ?? [],
    untrackedPaths: options.untrackedPaths ?? [],
  };
  const worktree = await createWorktree(cwd, agentId, commit);
  const registrationPath = join(worktree.id, "pi-subagents.json");
  const registration = JSON.parse(await readFile(registrationPath, "utf8"));
  await writeFile(registrationPath, JSON.stringify({ ...registration, snapshot }));
  // Checkout filters can alter bytes. Refuse a usable snapshot when checkout did so.
  for (const [path, expected] of first.files) {
    if (!same(expected, await readEntry(worktree.path, path)))
      throw new Error(`Snapshot checkout changed bytes: ${path}; retained at ${worktree.path}`);
  }
  const after = await capture(cwd, options);
  if (!sameIdentity(first.identity, after.identity) || !sameFiles(first.files, after.files))
    throw new Error(
      `Concurrent parent change during snapshot; partial worktree retained at ${worktree.path}`,
    );
  return { ...worktree, snapshot };
}

async function install(
  cwd: string,
  path: string,
  entry: Entry | undefined,
  madeDirs: string[],
  expected: Entry | undefined,
): Promise<void> {
  await safeParents(cwd, path);
  if (!entry) {
    if (!same(await readEntry(cwd, path), expected))
      throw new Error(`Concurrent parent content change: ${path}`);
    await unlink(join(cwd, path));
    return;
  }
  let directory = cwd;
  for (const part of path.split("/").slice(0, -1)) {
    directory = join(directory, part);
    if (!(await stat(directory))) {
      await mkdir(directory);
      madeDirs.push(directory);
    }
  }
  const temp = join(dirname(join(cwd, path)), `.pi-integration-${randomUUID()}`);
  try {
    if (entry.mode === "120000") await symlink(entry.data, temp);
    else
      await writeFile(temp, entry.data, {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
    if (!same(await readEntry(cwd, path), expected))
      throw new Error(`Concurrent parent content change: ${path}`);
    await rename(temp, join(cwd, path));
  } finally {
    await rm(temp, { force: true });
  }
}

/** Explicit committed child delta only. Parent index and HEAD are never updated. */
export async function integrateSnapshotWorktree(
  cwd: string,
  info: WorktreeInfo,
): Promise<IntegrationResult> {
  const result: IntegrationResult = { integrated: false, changedPaths: [], conflicts: [] };
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  const applied: string[] = [];
  const madeDirs: string[] = [];
  const originals: Files = new Map();
  let desired: Files = new Map();
  try {
    const original = structuredClone(info);
    if (!original.snapshot) throw new Error("Integration requires a working-content snapshot");
    const snapshot = original.snapshot;
    const sameRegistration = (actual: WorktreeInfo) => {
      if (
        actual.id !== original.id ||
        actual.path !== original.path ||
        actual.baseCommit !== original.baseCommit ||
        !actual.snapshot ||
        (["parentPath", "parentHead", "ref", "excludePaths", "untrackedPaths"] as const).some(
          (key) => JSON.stringify(actual.snapshot![key]) !== JSON.stringify(snapshot[key]),
        )
      )
        throw new Error("Worktree snapshot registration mismatch");
    };
    const worktree = await loadWorktree(original.path);
    sameRegistration(worktree);
    cwd = await root(cwd);
    if (cwd !== snapshot.parentPath)
      throw new Error("Integration requires the original parent checkout");
    const common = await text(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    lockPath = join(common, "pi-subagents-integration.lock");
    lock = await open(lockPath, "wx", 0o600);
    const before = await identity(cwd);
    const childBefore = await identity(worktree.path);
    if (childBefore.status.length)
      throw new Error("Commit or remove child working changes explicitly before integration");
    await git(worktree.path, [
      "merge-base",
      "--is-ancestor",
      worktree.baseCommit,
      childBefore.head,
    ]);
    result.childHead = childBefore.head;
    const base = await tree(cwd, worktree.baseCommit);
    desired = await tree(worktree.path, childBefore.head);
    result.changedPaths = [...new Set([...base.keys(), ...desired.keys()])]
      .filter((path) => !same(base.get(path), desired.get(path)))
      .sort();
    await rejectNested(cwd, snapshot.excludePaths);
    await rejectNested(worktree.path, snapshot.excludePaths);
    const skip = await ignored(cwd, result.changedPaths);
    for (const path of await ignored(worktree.path, result.changedPaths)) skip.add(path);
    for (const path of result.changedPaths) {
      try {
        if (excluded(path, snapshot.excludePaths) || skip.has(path))
          throw new Error("Excluded secret or ignored resource");
        const actual = await readEntry(cwd, path);
        if (!same(actual, base.get(path)) && !same(actual, desired.get(path)))
          throw new Error("Parent differs from snapshot and child");
        if (actual) originals.set(path, actual);
      } catch (error) {
        result.conflicts.push({ path, reason: (error as Error).message });
      }
    }
    if (result.conflicts.length) return result;
    // Preserve unrelated files and index entries, including concurrent staged edits.
    if (
      !sameIdentity(before, await identity(cwd)) ||
      !sameIdentity(childBefore, await identity(worktree.path))
    )
      throw new Error("Concurrent parent or child change before integration");
    // Recheck immediately before mutation. All decisions above use the retained selection.
    sameRegistration(await loadWorktree(original.path));
    for (const path of result.changedPaths) {
      const now = await identity(cwd);
      if (
        now.head !== before.head ||
        now.branch !== before.branch ||
        !now.index.equals(before.index)
      )
        throw new Error("Concurrent parent HEAD/index change");
      for (const check of result.changedPaths) {
        const expected = applied.includes(check) ? desired.get(check) : originals.get(check);
        if (!same(await readEntry(cwd, check), expected))
          throw new Error(`Concurrent parent content change: ${check}`);
      }
      if (!same(originals.get(path), desired.get(path))) {
        await install(cwd, path, desired.get(path), madeDirs, originals.get(path));
        applied.push(path);
      }
    }
    const after = await identity(cwd);
    if (
      after.head !== before.head ||
      after.branch !== before.branch ||
      !after.index.equals(before.index)
    )
      throw new Error("Concurrent parent HEAD/index change");
    for (const path of result.changedPaths)
      if (!same(await readEntry(cwd, path), desired.get(path)))
        throw new Error(`Concurrent parent content change: ${path}`);
    result.integrated = true;
    return result;
  } catch (error) {
    result.conflicts.push({ path: "", reason: (error as Error).message });
    for (const path of applied.reverse()) {
      try {
        if (!same(await readEntry(cwd, path), desired.get(path)))
          throw new Error("External writer changed integrated file");
        await install(cwd, path, originals.get(path), madeDirs, desired.get(path));
      } catch {
        (result.recoveryPaths ??= []).push(path);
      }
    }
    return result;
  } finally {
    for (const directory of madeDirs.reverse()) await rmdir(directory).catch(() => {});
    if (lock) {
      await lock.close();
      await unlink(lockPath!);
    }
  }
}
