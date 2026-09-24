import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `${directory}${name}`);
for (let run = 1; run <= 3; run++) {
  console.log(`TUI stability run ${run}/3`);
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "--test-concurrency=1", ...files],
    { stdio: "inherit", timeout: 600_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
