import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { withPi, type PiFixture } from "./harness.ts";

const projectFile = (app: PiFixture, name: string) =>
  join(app.projectDir, ".pi", "agents", `${name}.md`);
const personalFile = (app: PiFixture, name: string) => join(app.agentDir, "agents", `${name}.md`);
const markdown = (description: string) =>
  `---\ndescription: ${description}\ntools: none\nprompt_mode: replace\n---\n\nOriginal prompt\n`;

async function types(app: PiFixture) {
  await app.openAgents();
  await app.choose("Agent types (");
  await app.expect("general-purpose");
}
async function detail(app: PiFixture, name: string) {
  await types(app);
  await app.choose(`${name} ·`);
  await app.expect(name);
}
async function create(
  app: PiFixture,
  name: string,
  location: "Project" | "Personal",
  tool: string,
  prompt = "Created prompt",
) {
  await app.openAgents();
  await app.choose("Create new agent");
  await app.expect("Choose location");
  await app.choose(location);
  await app.expect("Agent name (filename, no spaces)");
  await app.input(name);
  await app.expect("Description (one line)");
  await app.input(`${name} description`);
  await app.expect("Tools");
  await app.choose(tool);
  if (tool === "custom...") {
    await app.expect("Tools (comma-separated)");
    await app.input("read, grep");
  }
  await app.expect("System prompt");
  await app.editor(prompt);
  await app.waitFor(
    () => existsSync(location === "Project" ? projectFile(app, name) : personalFile(app, name)),
    `${name} created`,
  );
}

test("/agents lists built-in types, supports Back and Escape", { timeout: 60_000 }, async (t) => {
  await withPi(t, {}, async (app) => {
    await types(app);
    for (const name of ["general-purpose", "Explore", "Plan", "code-review"])
      await app.expect(name);
    await app.choose("Explore ·");
    await app.expect("Eject (export as .md)");
    await app.expect("Disable");
    await app.choose("Back");
    await app.expect("Agent types");
    await app.escape();
    await app.expect("Create new agent");
    await app.escape();
  });
});

for (const [location, tool, expected] of [
  ["Project", "all", "tools: read, bash, edit, write, grep, find, ls"],
  ["Project", "none", "tools: none"],
  ["Personal", "read-only", "tools: read, bash, grep, find, ls"],
  ["Project", "custom...", "tools: read, grep"],
] as const) {
  test(`wizard creates ${location} agent with ${tool} tools`, { timeout: 60_000 }, async (t) => {
    await withPi(t, {}, async (app) => {
      const name = `created-${tool.replace(/\W/g, "")}`;
      await create(app, name, location, tool);
      const path = location === "Project" ? projectFile(app, name) : personalFile(app, name);
      const text = readFileSync(path, "utf8");
      assert.match(text, new RegExp(expected));
      assert.match(text, /description: created-/);
      assert.match(text, /prompt_mode: replace/);
      assert.match(text, /Created prompt/);
      await types(app);
      await app.expect(name);
    });
  });
}

test(
  "wizard rejects traversal and invalid names without writing a file",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      for (const name of ["../escape", "two words", "a..b"]) {
        await app.openAgents();
        await app.choose("Create new agent");
        await app.choose("Project");
        await app.input(name);
        await app.expect("Invalid agent name");
        assert.equal(existsSync(projectFile(app, name)), false);
      }
    });
  },
);

test(
  "wizard cancellation at location, name, description, tools, and editor leaves no file",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, {}, async (app) => {
      for (const stage of ["location", "name", "description", "tools", "editor"]) {
        const name = `cancel-${stage}`;
        await app.openAgents();
        await app.choose("Create new agent");
        await app.expect("Choose location");
        if (stage !== "location") {
          await app.choose("Project");
          await app.expect("Agent name (filename, no spaces)");
        }
        if (!["location", "name"].includes(stage)) {
          await app.input(name);
          await app.expect("Description (one line)");
        }
        if (["tools", "editor"].includes(stage)) {
          await app.input("A description");
          await app.expect("Tools");
        }
        if (stage === "editor") {
          await app.choose("none");
          await app.expect("System prompt");
          await app.terminal.type("Unsaved prompt text");
          await app.expect("Unsaved prompt text");
        }
        await app.escape();
        await app.waitFor(
          async () => !(await app.terminal.text()).includes("cancel"),
          `${stage} wizard closes`,
        );
        assert.equal(existsSync(projectFile(app, name)), false);
        const dir = join(app.projectDir, ".pi", "agents");
        assert.deepEqual(
          existsSync(dir) ? readdirSync(dir) : [],
          [],
          `${stage} cancellation wrote an agent`,
        );
        await app.editorReady();
      }
    });
  },
);

test(
  "duplicate agent overwrite requires confirmation and preserves original on cancel",
  { timeout: 60_000 },
  async (t) => {
    const original = markdown("Original helper");
    await withPi(t, { projectAgents: { duplicate: original } }, async (app) => {
      const path = projectFile(app, "duplicate");
      for (const replacement of ["Cancelled replacement", "Confirmed replacement"]) {
        await app.openAgents();
        await app.choose("Create new agent");
        await app.expect("Choose location");
        await app.choose("Project");
        await app.expect("Agent name (filename, no spaces)");
        await app.input("duplicate");
        await app.expect("Description (one line)");
        await app.input("Replacement description");
        await app.expect("Tools");
        await app.choose("none");
        await app.expect("System prompt");
        await app.editor(replacement);
        await app.expect("Overwrite");
        if (replacement.startsWith("Cancelled")) {
          await app.escape();
          assert.equal(readFileSync(path, "utf8"), original);
        } else {
          await app.choose("Yes");
          await app.waitFor(
            () => readFileSync(path, "utf8").includes(replacement),
            "overwrite confirmed",
          );
          assert.match(readFileSync(path, "utf8"), /Replacement description/);
        }
      }
    });
  },
);

test(
  "custom agent edit saves content; cancelled edit preserves it",
  { timeout: 60_000 },
  async (t) => {
    await withPi(t, { projectAgents: { helper: markdown("Helper") } }, async (app) => {
      const path = projectFile(app, "helper");
      await detail(app, "helper");
      await app.choose("Edit");
      await app.editor(markdown("Edited helper"));
      await app.waitFor(() => readFileSync(path, "utf8").includes("Edited helper"), "edited file");
      const saved = readFileSync(path, "utf8");
      await detail(app, "helper");
      await app.choose("Edit");
      await app.expect("Edit helper");
      await app.terminal.type("UNSAVED-EDIT");
      await app.expect("UNSAVED-EDIT");
      await app.escape();
      assert.equal(readFileSync(path, "utf8"), saved);
    });
  },
);

test("custom agent disable, enable, and delete confirmation", { timeout: 60_000 }, async (t) => {
  await withPi(t, { projectAgents: { helper: markdown("Helper") } }, async (app) => {
    const path = projectFile(app, "helper");
    await detail(app, "helper");
    await app.choose("Disable");
    await app.waitFor(() => readFileSync(path, "utf8").includes("enabled: false"), "disabled file");
    await detail(app, "helper");
    await app.choose("Enable");
    await app.waitFor(() => !readFileSync(path, "utf8").includes("enabled: false"), "enabled file");
    await detail(app, "helper");
    await app.choose("Delete");
    await app.escape();
    assert.equal(existsSync(path), true);
    await detail(app, "helper");
    await app.choose("Delete");
    await app.choose("Yes");
    await app.waitFor(() => !existsSync(path), "deleted file");
  });
});

test("built-in disable and enable use a removable override", { timeout: 60_000 }, async (t) => {
  await withPi(t, {}, async (app) => {
    const path = projectFile(app, "Explore");
    await detail(app, "Explore");
    await app.choose("Disable");
    await app.choose("Project");
    await app.waitFor(() => existsSync(path), "disabled override");
    assert.match(readFileSync(path, "utf8"), /enabled: false/);
    await detail(app, "Explore");
    await app.choose("Enable");
    await app.waitFor(() => !existsSync(path), "removed override");
  });
});

test("built-in eject and reset preserve default agent", { timeout: 60_000 }, async (t) => {
  await withPi(t, {}, async (app) => {
    const path = projectFile(app, "Explore");
    await detail(app, "Explore");
    await app.choose("Eject (export as .md)");
    await app.choose("Project");
    await app.waitFor(() => existsSync(path), "ejected file");
    assert.match(readFileSync(path, "utf8"), /Fast codebase exploration agent/);
    await detail(app, "Explore");
    await app.choose("Reset to default");
    await app.escape();
    assert.equal(existsSync(path), true);
    await detail(app, "Explore");
    await app.choose("Reset to default");
    await app.choose("Yes");
    await app.waitFor(() => !existsSync(path), "reset override");
    await detail(app, "Explore");
    await app.expect("Eject (export as .md)");
  });
});
