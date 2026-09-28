/** Prepare only Root-reviewed immutable sources, without network repository credentials. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyInstalledDependencies } from "./bundle-integrity.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export interface ProtectionTestSource {
  url: string;
  base: string;
  revision: string;
  tree: string;
  archiveSha256: string;
  license: string;
  licenseFile: "LICENSE" | null;
  archive: string;
  path: string;
}
export function protectionSources(): Record<"guard" | "sandbox", ProtectionTestSource> {
  const manifest = JSON.parse(
    readFileSync(join(repo, "tests/process/protection-sources.json"), "utf8"),
  ) as Record<string, Omit<ProtectionTestSource, "path">>;
  if (Object.keys(manifest).sort().join(",") !== "guard,sandbox")
    throw new Error("INCOMPLETE_PROTECTION_TEST_SOURCES");
  const cache = join(repo, "test-results/protection-sources");
  return Object.fromEntries(
    Object.entries(manifest).map(([name, source]) => {
      if (
        !/^[a-f0-9]{40}$/.test(source.revision) ||
        !/^[a-f0-9]{40}$/.test(source.base) ||
        !/^[a-f0-9]{40}$/.test(source.tree) ||
        !/^[a-f0-9]{64}$/.test(source.archiveSha256) ||
        source.url !== `https://git.forest-arowana.ts.net/Bastian/pi-agent-${name}.git` ||
        source.archive !== `sources/${name}-${source.revision}.tar` ||
        source.license !== "MIT" ||
        (source.licenseFile !== null && source.licenseFile !== "LICENSE")
      )
        throw new Error("INVALID_PROTECTION_TEST_SOURCE");
      return [
        name,
        {
          ...source,
          archive: join(repo, "tests/process", source.archive),
          path: join(cache, `${name}-${source.revision}`),
        },
      ];
    }),
  ) as Record<"guard" | "sandbox", ProtectionTestSource>;
}
function git(path: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "core.fileMode=true", "-C", path, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
function verifyArchive(source: ProtectionTestSource) {
  const bytes = readFileSync(source.archive);
  if (createHash("sha256").update(bytes).digest("hex") !== source.archiveSha256)
    throw new Error("PROTECTION_ARCHIVE_HASH_MISMATCH");
  const commit = execFileSync("git", ["get-tar-commit-id"], {
    // Git reads only the two leading tar blocks and exits without draining stdin.
    input: bytes.subarray(0, 1024),
    encoding: "utf8",
  }).trim();
  if (commit !== source.revision) throw new Error("PROTECTION_ARCHIVE_COMMIT_MISMATCH");
  const names = execFileSync("tar", ["-tf", source.archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  if (
    (source.licenseFile !== null && !names.includes(source.licenseFile)) ||
    names.some(
      (name) =>
        !name ||
        name.startsWith("/") ||
        name.split("/").some((part) => part === ".." || part === ".git"),
    )
  )
    throw new Error("PROTECTION_ARCHIVE_PATH_INVALID");
  // These source archives need only regular files/directories. Reject links and devices.
  const listing = execFileSync("tar", ["-tvf", source.archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  if (listing.some((line) => !/^[d-]/.test(line)))
    throw new Error("PROTECTION_ARCHIVE_ENTRY_UNSUPPORTED");
}
export function verifyProtectionSources() {
  const sources = protectionSources();
  for (const source of Object.values(sources)) {
    verifyArchive(source);
    if (
      !existsSync(source.path) ||
      git(source.path, "write-tree") !== source.tree ||
      git(source.path, "diff", "--no-ext-diff", "--name-only", source.tree, "--") !== "" ||
      git(source.path, "ls-files", "--others", "--exclude=node_modules/") !== ""
    )
      throw new Error("PROTECTION_TEST_SOURCE_UNVERIFIED");
    source.path = realpathSync(source.path);
    if (
      JSON.parse(readFileSync(join(source.path, "package.json"), "utf8")).license !== source.license
    )
      throw new Error("PROTECTION_LICENSE_MISMATCH");
  }
  return sources;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.PASA_PROTECTION_PREPARED === "1") {
    const sources = verifyProtectionSources();
    verifyInstalledDependencies([repo, sources.guard.path, sources.sandbox.path]);
  } else {
    for (const source of Object.values(protectionSources())) {
      verifyArchive(source);
      if (!existsSync(source.path)) {
        mkdirSync(dirname(source.path), { recursive: true });
        const staging = mkdtempSync(join(dirname(source.path), ".extract-"));
        try {
          execFileSync("tar", ["--no-same-owner", "-xf", source.archive, "-C", staging]);
          git(staging, "init", "-q");
          git(staging, "add", "--force", "--all");
          if (git(staging, "write-tree") !== source.tree)
            throw new Error("PROTECTION_ARCHIVE_TREE_MISMATCH");
          renameSync(staging, source.path);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      }
    }
    for (const [name, source] of Object.entries(verifyProtectionSources())) {
      // Preserve a source's own workspace settings, but never discover the outer repo's.
      const workspace = existsSync(join(source.path, "pnpm-workspace.yaml"))
        ? []
        : ["--ignore-workspace"];
      const offlineRoot = process.env.PASA_PROTECTION_OFFLINE_STORES;
      const temporaryStore = offlineRoot
        ? mkdtempSync(join(tmpdir(), "pasa-offline-store-"))
        : undefined;
      try {
        if (temporaryStore) {
          execFileSync("tar", [
            "--zstd",
            "-xf",
            join(offlineRoot!, name, "pnpm-store.tar.zst"),
            "-C",
            temporaryStore,
          ]);
          execFileSync("chmod", ["-R", "u+w", temporaryStore]);
        }
        execFileSync(
          "pnpm",
          [
            "--dir",
            source.path,
            ...workspace,
            "--config.manage-package-manager-versions=false",
            "install",
            "--prod",
            "--frozen-lockfile",
            "--ignore-scripts",
            ...(temporaryStore ? ["--offline", "--store-dir", temporaryStore] : []),
          ],
          {
            cwd: source.path,
            env: { ...process.env, CI: "true" },
            stdio: "inherit",
          },
        );
      } finally {
        if (temporaryStore) rmSync(temporaryStore, { recursive: true, force: true });
      }
    }
    verifyProtectionSources();
  }
}
