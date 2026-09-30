import { test } from "node:test";
import { nestedScenario } from "./nested-scenario.ts";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
test(
  "actual correlated host reply unblocks foreground request_help without waiting for the parent model",
  { timeout: protectionCaseTimeoutMs },
  () => nestedScenario(false, undefined, "help"),
);
test(
  "actual sibling agents discover authenticated addresses and steer during a running tool",
  { timeout: protectionCaseTimeoutMs },
  () => nestedScenario(false, undefined, "siblings"),
);
for (const phase of ["startup", "continuation"] as const)
  test(
    `actual role file drift at ${phase} refuses model execution and releases its reservation`,
    { timeout: protectionCaseTimeoutMs },
    () => nestedScenario(false, undefined, `role-${phase}`),
  );
