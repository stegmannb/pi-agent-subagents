import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { withPi } from "./harness.ts";

test("empty running/custom lists leave a compact usable menu", { timeout: 30000 }, async (t) => {
  let fixtureRoot = "";
  await withPi(t, { cols: 64, rows: 20 }, async (app) => {
    fixtureRoot = app.root;
    await app.openAgents();
    await app.absent("Running agents (");
    // A text snapshot of the menu only avoids volatile paths, cursor and footer.
    const screen = await app.terminal.text();
    const menu = screen
      .slice(screen.indexOf(" Agents\n"), screen.indexOf(" ↑↓ navigate"))
      .trimEnd();
    assert.equal(menu, " Agents\n\n → Agent types (7)\n   Create new agent\n   Settings");
    await app.escape();
    await app.editorReady();
  });
  assert.equal(existsSync(fixtureRoot), false, "successful case removes its isolated data");
});

test(
  "many long custom descriptions scroll and survive terminal resizing",
  { timeout: 60000 },
  async (t) => {
    const projectAgents = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [
        `scroll-${String(i).padStart(2, "0")}`,
        `---\ndescription: ${"A long description ".repeat(15)}\ntools: none\n---\nPrompt\n`,
      ]),
    );
    await withPi(t, { cols: 64, rows: 20, projectAgents }, async (app) => {
      await app.openAgents();
      await app.choose("Agent types (25)");
      await app.choose("scroll-17 ·");
      await app.expect("Edit");
      await app.terminal.resize(100, 32);
      await app.choose("Back");
      await app.expect("Agent types");
      const size = await app.terminal.getSize();
      assert.equal(size.cols, 100);
      assert.equal(size.rows, 32);
      await app.escape();
      await app.expect("Create new agent");
      await app.escape();
      await app.editorReady();
    });
  },
);

test(
  "project agents override personal agents with the same name",
  { timeout: 30000 },
  async (t) => {
    const agent = (description: string) =>
      `---\ndescription: ${description}\ntools: none\n---\nPrompt\n`;
    await withPi(
      t,
      {
        globalAgents: { specialist: agent("PERSONAL precedence marker") },
        projectAgents: { specialist: agent("PROJECT precedence marker") },
      },
      async (app) => {
        await app.openAgents();
        await app.choose("Agent types (");
        await app.choose("specialist ·");
        await app.expect("Edit");
        await app.choose("Back");
        await app.expect("PROJECT precedence marker");
        await app.absent("PERSONAL precedence marker");
      },
    );
  },
);
