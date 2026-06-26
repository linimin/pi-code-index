import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extensionEntrypoint from "../extensions/index.ts";
import { DaemonClient, resolveRepoLocator } from "../src/extension/daemon-client.ts";
import type { RepoIndexingState, RepoLocator } from "../src/shared/protocol.ts";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

interface BeforeAgentStartHandler {
  (_event: unknown, ctx: { cwd: string; hasUI: boolean; ui: { notify(message: string, level?: string): void } }): Promise<void> | void;
}

test("extension registers only the approved Phase 1 tools and activates them only for enabled healthy repos", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-tools-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const client = new DaemonClient({ cacheDir, socketPath, startTimeoutMs: 8_000, requestTimeoutMs: 2_000 });
  const previousCacheDir = process.env.PI_CODE_INDEX_CACHE_DIR;
  const previousSocketPath = process.env.PI_CODE_INDEX_SOCKET_PATH;
  process.env.PI_CODE_INDEX_CACHE_DIR = cacheDir;
  process.env.PI_CODE_INDEX_SOCKET_PATH = socketPath;

  const registeredTools: RegisteredTool[] = [];
  const handlers = new Map<string, BeforeAgentStartHandler>();
  let activeTools = ["read"];

  extensionEntrypoint({
    registerCommand() {},
    registerTool(tool: RegisteredTool) {
      registeredTools.push(tool);
    },
    on(event: string, handler: BeforeAgentStartHandler) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
  } as never);

  t.after(async () => {
    process.env.PI_CODE_INDEX_CACHE_DIR = previousCacheDir;
    process.env.PI_CODE_INDEX_SOCKET_PATH = previousSocketPath;
    await stopDaemon(client);
    await rm(tempRoot, { recursive: true, force: true });
  });

  assert.deepEqual(
    registeredTools.map((tool) => tool.name).sort(),
    ["file_summary", "impact_analysis", "symbol_lookup"],
  );
  assert.equal(handlers.has("before_agent_start"), true);

  await handlers.get("before_agent_start")?.({}, createEventContext(tempRoot));
  assert.deepEqual(activeTools, ["read"]);

  await seedToolRepo(repoDir);
  assert.equal(await pathExists(socketPath), false);
  await handlers.get("before_agent_start")?.({}, createEventContext(repoDir));
  assert.deepEqual(activeTools, ["read"]);
  assert.equal(await pathExists(socketPath), false);

  const repo = await resolveRepoLocator(repoDir);
  await client.openRepo(repo);
  await client.enableRepoIndexing(repo);
  await waitForState(client, repo, ["ready", "indexing", "initializing"], 5_000);

  await handlers.get("before_agent_start")?.({}, createEventContext(repoDir));
  assert.deepEqual(activeTools, ["read", "symbol_lookup", "file_summary", "impact_analysis"]);

  await client.disableRepoIndexing(repo);
  await waitFor(() => pathExists(socketPath).then((exists) => !exists), 3_000);
  activeTools = ["read"];

  await handlers.get("before_agent_start")?.({}, createEventContext(repoDir));
  assert.deepEqual(activeTools, ["read"]);
  assert.equal(await pathExists(socketPath), false);
});

test("tool queries surface deterministic structural and fallback results with Phase 1 metadata and caps", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-query-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const client = new DaemonClient({ cacheDir, socketPath, startTimeoutMs: 8_000, requestTimeoutMs: 2_000 });
  const previousCacheDir = process.env.PI_CODE_INDEX_CACHE_DIR;
  const previousSocketPath = process.env.PI_CODE_INDEX_SOCKET_PATH;
  process.env.PI_CODE_INDEX_CACHE_DIR = cacheDir;
  process.env.PI_CODE_INDEX_SOCKET_PATH = socketPath;

  t.after(async () => {
    process.env.PI_CODE_INDEX_CACHE_DIR = previousCacheDir;
    process.env.PI_CODE_INDEX_SOCKET_PATH = previousSocketPath;
    await stopDaemon(client);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await seedToolRepo(repoDir);
  const repo = await resolveRepoLocator(repoDir);
  await client.openRepo(repo);
  await client.enableRepoIndexing(repo);
  await waitForState(client, repo, ["ready"], 5_000);

  const symbolResult = await client.symbolLookup({ repo, symbol: "batchThing" });
  assert.equal(symbolResult.freshness, "current");
  assert.equal(symbolResult.provenance, "local");
  assert.equal(symbolResult.analysisQuality, "structural");
  assert.equal(symbolResult.truncated, true);
  assert.equal(symbolResult.returnedCount, 10);
  assert.equal(symbolResult.totalCount, 12);
  assert.deepEqual(
    symbolResult.matches.map((match) => match.symbol),
    Array.from({ length: 10 }, (_, index) => `batchThing${index + 1}`),
  );
  assert.equal(symbolResult.matches.every((match) => match.analysisQuality === "structural"), true);

  const structuralSummary = await client.fileSummary({ repo, path: "src/main.ts" });
  assert.equal(structuralSummary.path, "src/main.ts");
  assert.equal(structuralSummary.analysisQuality, "structural");
  assert.equal(structuralSummary.mainExports.some((entry) => entry.name === "greet"), true);
  assert.equal(structuralSummary.relatedFiles.some((entry) => entry.path === "draft.js"), true);
  assert.equal(structuralSummary.freshness, "current");

  const fallbackSummary = await client.fileSummary({ repo, path: "notes.py" });
  assert.equal(fallbackSummary.analysisQuality, "basic");
  assert.equal(fallbackSummary.mainExports.length, 0);
  assert.equal(fallbackSummary.importantRanges[0]?.startLine, 1);
  assert.equal(fallbackSummary.freshness, "current");

  const impact = await client.impactAnalysis({ repo, target: "greet" });
  assert.equal(impact.analysisQuality, "structural");
  assert.equal(impact.freshness, "current");
  assert.equal(impact.areas.length > 0, true);
  assert.equal(impact.areas.some((area) => area.path === "src/main.ts"), true);
  assert.equal(impact.suggestedNextRead.length <= 5, true);

  const registeredTools: RegisteredTool[] = [];
  extensionEntrypoint({
    registerCommand() {},
    registerTool(tool: RegisteredTool) {
      registeredTools.push(tool);
    },
    on() {},
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  } as never);

  const fileSummaryTool = registeredTools.find((tool) => tool.name === "file_summary");
  assert.ok(fileSummaryTool, "expected file_summary tool registration");
  const toolResult = await fileSummaryTool.execute(
    "call-1",
    { path: "notes.py" },
    undefined,
    undefined,
    createEventContext(repoDir),
  );
  assert.match(toolResult.content[0]?.text ?? "", /file_summary: notes.py/);
  assert.match(toolResult.content[0]?.text ?? "", /analysisQuality=basic/);
});

function createEventContext(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify() {},
    },
  };
}

async function seedToolRepo(repoDir: string): Promise<void> {
  await mkdir(join(repoDir, "src"), { recursive: true });
  execGit(repoDir, ["init"]);
  execGit(repoDir, ["config", "user.email", "test@example.com"]);
  execGit(repoDir, ["config", "user.name", "Test User"]);

  await writeFile(
    join(repoDir, "src", "main.ts"),
    [
      "import { draft } from '../draft.js';",
      "export function greet(name: string) {",
      "  return draft(name);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(repoDir, "notes.py"), "def fallback():\n    return 'basic'\n", "utf8");

  const batchLines = Array.from({ length: 12 }, (_, index) => `export function batchThing${index + 1}() { return ${index + 1}; }`);
  await writeFile(join(repoDir, "src", "batch.ts"), `${batchLines.join("\n")}\n`, "utf8");
  execGit(repoDir, ["add", "."]);
  execGit(repoDir, ["commit", "-m", "initial"]);

  await writeFile(join(repoDir, "draft.js"), "import { greet } from './src/main.js';\nexport const draft = (name) => greet(name.toUpperCase());\n", "utf8");
}

function execGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

async function waitForState(
  client: DaemonClient,
  repo: RepoLocator,
  states: RepoIndexingState[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.getStatus(repo);
    if (states.includes(status.state)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for states: ${states.join(", ")}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function stopDaemon(client: DaemonClient): Promise<void> {
  try {
    const health = await client.health({ startIfNeeded: false });
    try {
      process.kill(health.pid, "SIGTERM");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        throw error;
      }
    }
  } catch {
    // no-op
  }
}
