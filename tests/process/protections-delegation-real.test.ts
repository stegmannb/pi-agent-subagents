import { test } from "node:test";
import { nestedScenario } from "./nested-scenario.ts";
import { protectionCaseTimeoutMs } from "./parent-startup.ts";
test(
  "actual protected root to task to independent read-only reviewer and correction",
  { timeout: protectionCaseTimeoutMs },
  () => nestedScenario(true),
);
