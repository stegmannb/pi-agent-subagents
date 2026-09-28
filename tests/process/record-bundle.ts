/** Nix build step, after all frozen dependency installations have completed. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProtectionSources } from "./protection-sources.ts";
import { recordInstalledDependencies } from "./bundle-integrity.ts";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = verifyProtectionSources();
recordInstalledDependencies([repo, sources.guard.path, sources.sandbox.path]);
