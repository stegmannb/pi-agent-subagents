import { test } from "node:test";
import { nestedScenario } from "./nested-scenario.ts";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
for (const mode of ["async", "group", "smart"] as const)
  test(
    `actual ${mode} retains the result and owning session after a real parent append failure`,
    { timeout: protectionCaseTimeoutMs },
    () => nestedScenario(false, mode, "pending-save"),
  );
test(
  "foreground Agent exposes failed persistent ingestion as pending, not completion",
  { timeout: protectionCaseTimeoutMs },
  () => nestedScenario(false, undefined, "pending-save"),
);
