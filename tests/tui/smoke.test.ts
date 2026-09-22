import { test } from "node:test";
import { withPi } from "./harness.ts";
test("real pi opens /agents and returns to its editor", { timeout: 30000 }, async (t) => {
  await withPi(t, {}, async (app) => {
    await app.openAgents();
    await app.expect("Agent types (7)");
    await app.escape();
    await app.editorReady();
  });
});
