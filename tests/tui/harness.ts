import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { TuiTest } from "@microsoft/tui-test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export interface FixtureOptions {
  cols?: number;
  rows?: number;
  projectAgents?: Record<string, string>;
  globalAgents?: Record<string, string>;
  settings?: Record<string, unknown>;
}
export class PiFixture {
  terminal!: TuiTest;
  private pid: number | null = null;
  readonly projectDir: string;
  readonly agentDir: string;
  readonly controlDir: string;
  readonly artifacts: string;
  readonly root: string;
  readonly options: FixtureOptions;
  constructor(root: string, options: FixtureOptions, name: string) {
    this.root = root;
    this.options = options;
    this.projectDir = join(root, "project");
    this.agentDir = join(root, "agent");
    this.controlDir = join(root, "control");
    this.artifacts = join(
      repo,
      "test-results",
      name.replace(/[^a-z0-9-]/gi, "-").slice(0, 100),
      root.split("-").at(-1)!,
    );
  }
  async start() {
    this.terminal = TuiTest.ephemeral("pi", {
      timeouts: { text: 10000, ready: 15000 },
      artifacts: { dir: this.artifacts, onFailure: "all", includeRecording: true },
      trace: { mode: "on", directory: this.artifacts },
    });
    // env -i removes host credentials, extension settings, proxies and cmux state.
    const opened = await this.terminal.run(
      "env",
      [
        "-i",
        `HOME=${this.root}`,
        `PATH=${process.env.PATH}`,
        "TERM=xterm-256color",
        "LANG=C.UTF-8",
        "PI_OFFLINE=1",
        "PI_SKIP_VERSION_CHECK=1",
        `XDG_CONFIG_HOME=${this.root}/config`,
        `XDG_CACHE_HOME=${this.root}/cache`,
        `PI_CODING_AGENT_DIR=${this.agentDir}`,
        `PI_TUI_TEST_CONTROL_DIR=${this.controlDir}`,
        process.execPath,
        join(repo, "node_modules/@mariozechner/pi-coding-agent/dist/cli.js"),
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "-e",
        join(repo, "tests/tui/fixtures/provider.ts"),
        "-e",
        join(repo, "index.ts"),
        "--model",
        "tui-test/tui-test",
      ],
      {
        cwd: this.projectDir,
        cols: this.options.cols ?? 110,
        rows: this.options.rows ?? 36,
        retries: 0,
      },
    );
    this.pid = opened.shell_pid;
    await this.expect("tui-test");
    await this.editorReady();
  }
  async expect(text: string) {
    await this.terminal.getByText(text).expect({ timeout: 10000 });
  }
  async absent(text: string) {
    await this.terminal.getByText(text).expect({ not: true, timeout: 10000 });
  }
  async waitFor<T>(
    predicate: () => T | Promise<T>,
    label: string,
    timeout = 10000,
  ): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value as NonNullable<T>;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async escape() {
    await this.terminal.press("Escape");
  }
  async openAgents() {
    for (let i = 0; i < 8; i++) {
      const screen = await this.terminal.text();
      if (!/^\s*(?:↑↓ navigate.*cancel|enter select.*cancel|enter submit.*cancel)/m.test(screen))
        break;
      await this.escape();
      await this.waitFor(async () => (await this.terminal.text()) !== screen, "menu closes");
    }
    await this.terminal.submit("/agents");
    await this.expect("Create new agent");
  }
  async choose(label: string) {
    const selected = (text: string) =>
      text
        .split("\n")
        .find((line) => /^\s*→/.test(line))
        ?.replace(/^\s*→\s*/, "") ?? "";
    await this.waitFor(async () => selected(await this.terminal.text()), "menu selection");
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const current = selected(await this.terminal.text());
      if (current.includes(label)) {
        const before = await this.terminal.text();
        await this.terminal.press("Enter");
        await this.waitFor(async () => (await this.terminal.text()) !== before, `select ${label}`);
        return;
      }
      if (seen.has(current))
        throw new Error(
          `Menu option ${JSON.stringify(label)} missing:\n${await this.terminal.text()}`,
        );
      seen.add(current);
      await this.terminal.press("Down");
      await this.waitFor(
        async () => selected(await this.terminal.text()) !== current,
        `selection moves from ${current}`,
      );
    }
    throw new Error(`Menu option not found: ${label}`);
  }
  async input(text: string) {
    await this.terminal.press("Home", "Ctrl+K");
    await this.terminal.type(text);
    await this.expect(text);
    const before = await this.terminal.text();
    await this.terminal.press("Enter");
    await this.waitFor(async () => (await this.terminal.text()) !== before, "input submitted");
  }
  async editor(text: string) {
    // Pi's editor has line deletion, but no select-all binding. Move to its first
    // line, then delete enough lines for these bounded test fixtures.
    await this.terminal.press(
      ...Array<string>(80).fill("Up"),
      "Home",
      ...Array<string>(160).fill("Ctrl+K"),
    );
    await this.terminal.write(`\x1b[200~${text}\x1b[201~`);
    await this.terminal.press("Enter");
  }
  async editorReady() {
    const marker = "editor-ready-marker";
    await this.terminal.type(marker);
    await this.expect(marker);
    await this.terminal.press("Home", "Ctrl+K");
    await this.absent(marker);
  }
  readSettings(): Record<string, unknown> {
    const path = join(this.projectDir, ".pi/subagents.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  readEvents(file = "subagents.ndjson"): Array<any> {
    const path = join(this.controlDir, file);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  async close() {
    await this.terminal?.close();
    if (this.pid !== null) {
      const pid = this.pid;
      await this.waitFor(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
            throw error;
          }
        },
        `pi process ${pid} exits`,
        5000,
      );
      this.pid = null;
    }
  }
  async restart() {
    await this.close();
    await this.start();
  }
  async capture(error: unknown) {
    await mkdir(this.artifacts, { recursive: true });
    await writeFile(
      join(this.artifacts, "failure.txt"),
      String(error instanceof Error ? error.stack : error),
    );
    await writeFile(join(this.artifacts, "terminal.txt"), await this.terminal.text());
    await this.terminal.screenshot(join(this.artifacts, "terminal.svg"));
    for (const file of ["events.ndjson", "subagents.ndjson"]) {
      if (existsSync(join(this.controlDir, file)))
        await writeFile(join(this.artifacts, file), await readFile(join(this.controlDir, file)));
    }
  }
}
export async function withPi(
  t: TestContext,
  options: FixtureOptions,
  body: (app: PiFixture) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-tui-"));
  const app = new PiFixture(root, options, t.name);
  try {
    for (const dir of [app.projectDir, app.agentDir, app.controlDir])
      await mkdir(dir, { recursive: true });
    await writeFile(
      join(app.agentDir, "settings.json"),
      JSON.stringify({
        lastChangelogVersion: "0.73.0",
        quietStartup: true,
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    for (const [base, agents] of [
      [app.projectDir, options.projectAgents],
      [app.agentDir, options.globalAgents],
    ] as const) {
      const dir = base === app.projectDir ? join(base, ".pi/agents") : join(base, "agents");
      for (const [name, content] of Object.entries(agents ?? {})) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${name}.md`), content);
      }
    }
    if (options.settings) {
      await mkdir(join(app.projectDir, ".pi"), { recursive: true });
      await writeFile(join(app.projectDir, ".pi/subagents.json"), JSON.stringify(options.settings));
    }
    await app.start();
    await body(app);
  } catch (error) {
    try {
      await app.capture(error);
    } catch (captureError) {
      t.diagnostic(`Artifact capture failed: ${captureError}`);
    }
    t.diagnostic(`TUI artifacts: ${app.artifacts}`);
    throw error;
  } finally {
    try {
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    assert(!existsSync(root), "temporary fixture must be removed");
  }
}
