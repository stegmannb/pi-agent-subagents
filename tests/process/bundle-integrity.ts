/** Integrity check for all preinstalled dependency bytes in an offline VM input. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = join(repo, ".pasa-bundle-dependencies.json");
function inventory(roots: string[]) {
  const entries: Array<[string, string, string | number]> = [];
  function walk(path: string) {
    const stat = lstatSync(path);
    const key = relative(repo, path);
    if (stat.isSymbolicLink()) entries.push([key, "link", readlinkSync(path)]);
    else if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (stat.isFile()) {
      entries.push([
        key,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
        stat.mode & 0o111,
      ]);
    } else throw new Error("UNSUPPORTED_BUNDLE_DEPENDENCY_ENTRY");
  }
  for (const root of roots) walk(join(root, "node_modules"));
  return JSON.stringify(entries);
}
export function verifyInstalledDependencies(roots: string[]) {
  if (readFileSync(manifest, "utf8") !== inventory(roots))
    throw new Error("PREPARED_DEPENDENCY_GRAPH_CHANGED");
}
export function recordInstalledDependencies(roots: string[]) {
  writeFileSync(manifest, inventory(roots));
}
