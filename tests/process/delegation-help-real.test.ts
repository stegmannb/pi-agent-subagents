import { test } from "node:test";
import { nestedScenario } from "./nested-scenario.ts";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
for (const mode of ["async", "group", "smart"] as const)
  test(
    `actual ${mode} retains a parent with pending background help and wakes it to reply`,
    { timeout: protectionCaseTimeoutMs },
    () => nestedScenario(false, mode, "help-background"),
  );
