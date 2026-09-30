import { test } from "node:test";
import { nestedScenario } from "./nested-scenario.ts";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
test(
  "actual root to task to independent read-only reviewer and same task correction",
  { timeout: protectionCaseTimeoutMs },
  () => nestedScenario(false),
);
for (const mode of ["async", "group", "smart"] as const)
  test(
    `actual nested ${mode} retains parent after model turn and ingests both background reviewers`,
    { timeout: protectionCaseTimeoutMs },
    () => nestedScenario(false, mode),
  );
