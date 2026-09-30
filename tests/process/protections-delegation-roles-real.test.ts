import { test } from "node:test";
import { nestedScenario } from "./nested-scenario.ts";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
for (const phase of ["startup", "continuation"] as const)
  test(
    `actual Guard and OS Sandbox reject role file drift at ${phase}`,
    { timeout: protectionCaseTimeoutMs },
    () => nestedScenario(true, undefined, `role-${phase}`),
  );
