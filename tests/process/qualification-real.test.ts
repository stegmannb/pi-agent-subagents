import { test } from "node:test";
import { qualificationScenario } from "./qualification-scenario.ts";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";

for (const mode of ["async", "group", "smart"] as const)
  test(
    `qualification: headless ${mode} reviewer, sibling, correlated help and exhausted budget`,
    { timeout: protectionCaseTimeoutMs },
    () => qualificationScenario(mode),
  );
test(
  "qualification: interactive parent without Herdr continues the same task after findings",
  { timeout: protectionCaseTimeoutMs },
  () => qualificationScenario("smart", true),
);
test(
  "qualification: protected nested review preserves the result and lifecycle contracts",
  { timeout: protectionCaseTimeoutMs },
  () => qualificationScenario("smart", false, true),
);
