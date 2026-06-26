import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createDaemonServer } from "../src/daemon/server.ts";
import { resolveRepoLocator } from "../src/extension/daemon-client.ts";
import { buildRuntimePaths, type RepoIndexingState, type RepoLocator } from "../src/shared/protocol.ts";

test("indexing pipeline persists structural and fallback analysis with truthful readiness, stale, reindex, and disable transitions", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-storage-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const server = await createDaemonServer({ socketPath, cacheDir, indexingDebounceMs: 80 });

  await server.start();
  await seedIndexedRepo(repoDir);
  const repo = await resolveRepoLocator(repoDir);

  t.after(async () => {
    await server.stop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  let status = await server.enableRepoIndexing(repo);
  assert.equal(status.state, "initializing");

  status = await waitForState(server, repo, ["ready"], 5_000);
  assert.equal(status.enabled, true);
  assert.equal(status.state, "ready");
  assert.equal(status.filesPending, 0);
  assert.equal(status.coverage.indexedFiles, 5);
  assert.equal(status.coverage.eligibleFiles, 10);
  assert.equal(status.coverage.omittedFiles, 5);
  assert.equal(status.coverage.indexedPercent, 50);

  const diagnostics = await server.getRepoDiagnostics(repo);
  assert.equal(diagnostics.freshness, "current");
  assert.equal(diagnostics.storageSummary.baselineCount, 1);
  assert.equal(diagnostics.storageSummary.overlayBytes > 0, true);

  const baselineFacts = readIndexedFacts(status.baseline.dbPath);
  const overlayFacts = readIndexedFacts(status.overlay.dbPath);

  assert.deepEqual([...baselineFacts.files.keys()].sort(), ["notes.py", "src/main.ts"]);
  assert.deepEqual([...overlayFacts.files.keys()].sort(), ["draft.js", "draft.py", "src/main.ts"]);
  assert.equal(baselineFacts.files.get("src/main.ts")?.analysis_quality, "structural");
  assert.equal(baselineFacts.files.get("notes.py")?.analysis_quality, "basic");
  assert.equal(overlayFacts.files.get("draft.js")?.analysis_quality, "structural");
  assert.equal(overlayFacts.files.get("draft.py")?.analysis_quality, "basic");
  assert.equal(baselineFacts.symbols.some((row) => row.repo_relative_path === "src/main.ts" && row.name === "greet"), true);
  assert.equal(overlayFacts.imports.some((row) => row.repo_relative_path === "draft.js" && row.module_specifier === "./src/main.js"), true);
  assert.equal(overlayFacts.exports.some((row) => row.repo_relative_path === "draft.js" && row.exported_name === "draft"), true);
  assert.equal(overlayFacts.references.some((row) => row.repo_relative_path === "draft.js" && row.name === "greet"), true);
  assert.deepEqual(
    new Set([...baselineFacts.omitted, ...overlayFacts.omitted].map((row) => `${row.repo_relative_path}:${row.reason}`)),
    new Set([
      ".env:sensitive-file",
      "binary.dat:binary",
      "node_modules/ignored.js:default-excluded",
      "secret.pem:sensitive-file",
      "too-large.txt:too-large",
    ]),
  );

  await writeFile(join(repoDir, "draft.py"), "print('changed after ready')\n", "utf8");
  await utimes(join(repoDir, "draft.py"), new Date(Date.now() - 4_000), new Date(Date.now() - 4_000));

  status = await waitForState(server, repo, ["stale"], 5_000);
  assert.equal(status.filesPending, 6);

  status = await server.reindexRepo(repo);
  assert.equal(status.state, "indexing");

  status = await waitForState(server, repo, ["ready"], 5_000);
  assert.equal(status.filesPending, 0);

  status = await server.disableRepoIndexing(repo);
  assert.equal(status.state, "disabled");
  assert.equal(await pathExists(status.baseline.dbPath), true);
  assert.equal(await pathExists(status.overlay.dbPath), true);
});

test("registry persists enabled repo lifecycle across daemon restart", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-registry-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const firstServer = await createDaemonServer({ socketPath, cacheDir, indexingDebounceMs: 80 });

  await firstServer.start();
  await seedIndexedRepo(repoDir);
  const repo = await resolveRepoLocator(repoDir);

  await firstServer.enableRepoIndexing(repo);
  const readyStatus = await waitForState(firstServer, repo, ["ready"], 5_000);
  await firstServer.stop();

  const secondServer = await createDaemonServer({ socketPath, cacheDir, indexingDebounceMs: 80 });
  await secondServer.start();

  t.after(async () => {
    await secondServer.stop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const restoredOpen = await secondServer.openRepo(repo);
  const restoredStatus = await secondServer.getStatus(repo);
  const runtimePaths = buildRuntimePaths({ cacheDir, socketPath });
  const registryRow = readRegistryRow(runtimePaths.registryDbPath, repo.worktreeId);

  assert.equal(restoredOpen.enabled, true);
  assert.equal(restoredStatus.enabled, true);
  assert.notEqual(restoredStatus.state, "disabled");
  assert.equal(restoredStatus.repoId, readyStatus.repoId);
  assert.equal(restoredStatus.baseline.dbPath, readyStatus.baseline.dbPath);
  assert.equal(restoredStatus.overlay.dbPath, readyStatus.overlay.dbPath);
  assert.equal(await pathExists(runtimePaths.registryDbPath), true);
  assert.equal(registryRow?.enabled, 1);
  assert.equal(registryRow?.repo_id, readyStatus.repoId);
  assert.equal(registryRow?.worktree_id, repo.worktreeId);
  assert.match(registryRow?.last_successful_index_at ?? "", /T/);

  const otherRepoDir = join(tempRoot, "other-repo");
  await setupSimpleRepo(otherRepoDir);
  const otherRepo = await resolveRepoLocator(otherRepoDir);
  const otherStatus = await secondServer.getStatus(otherRepo);
  assert.equal(otherStatus.enabled, false);
  assert.equal(otherStatus.state, "disabled");
});

test("failed reindex transitions to error when repo access breaks", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-error-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const server = await createDaemonServer({ socketPath, cacheDir, indexingDebounceMs: 120 });

  await server.start();
  await mkdir(repoDir, { recursive: true });
  execGit(repoDir, ["init"]);
  execGit(repoDir, ["config", "user.email", "test@example.com"]);
  execGit(repoDir, ["config", "user.name", "Test User"]);
  await writeFile(join(repoDir, "index.ts"), "export const ok = 1;\n", "utf8");
  execGit(repoDir, ["add", "."]);
  execGit(repoDir, ["commit", "-m", "initial"]);

  const repo = await resolveRepoLocator(repoDir);

  t.after(async () => {
    await server.stop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  await server.enableRepoIndexing(repo);
  await waitForState(server, repo, ["ready"], 5_000);

  const reindexStatus = await server.reindexRepo(repo);
  assert.equal(reindexStatus.state, "indexing");

  await rm(repoDir, { recursive: true, force: true });

  const errorStatus = await waitForState(server, repo, ["error"], 5_000);
  assert.match(errorStatus.lastError ?? "", /no such file|git/i);
});

async function seedIndexedRepo(repoDir: string): Promise<void> {
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "node_modules"), { recursive: true });
  execGitInit(repoDir);

  await writeFile(
    join(repoDir, "src", "main.ts"),
    [
      "export function greet(name: string) {",
      "  return `hello ${name}`;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(repoDir, "notes.py"), "def fallback():\n    return 'baseline'\n", "utf8");
  await writeFile(join(repoDir, ".env"), "TOKEN=secret\n", "utf8");
  await writeFile(join(repoDir, "secret.pem"), "-----BEGIN KEY-----\nsecret\n", "utf8");
  execGit(repoDir, ["add", "."]);
  execGit(repoDir, ["commit", "-m", "initial"]);

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
  await writeFile(
    join(repoDir, "draft.js"),
    [
      "import { greet } from './src/main.js';",
      "export const draft = (name) => greet(name.toUpperCase());",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(repoDir, "draft.py"), "print('overlay')\n", "utf8");
  await writeFile(join(repoDir, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(repoDir, "too-large.txt"), "x".repeat(2 * 1024 * 1024 + 16), "utf8");
  await writeFile(join(repoDir, "node_modules", "ignored.js"), "console.log('skip');\n", "utf8");
}

async function setupSimpleRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  execGitInit(repoDir);
  await writeFile(join(repoDir, "index.ts"), "export const value = 1;\n", "utf8");
  execGit(repoDir, ["add", "."]);
  execGit(repoDir, ["commit", "-m", "initial"]);
}

function execGitInit(repoDir: string): void {
  execGit(repoDir, ["init"]);
  execGit(repoDir, ["config", "user.email", "test@example.com"]);
  execGit(repoDir, ["config", "user.name", "Test User"]);
}

function execGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

async function waitForState(
  server: Awaited<ReturnType<typeof createDaemonServer>>,
  repo: RepoLocator,
  states: RepoIndexingState[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await server.getStatus(repo);
    if (states.includes(status.state)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for states: ${states.join(", ")}`);
}

function readRegistryRow(dbPath: string, worktreeId: string) {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    return db.prepare("SELECT repo_id, worktree_id, enabled, last_successful_index_at FROM repo_registry WHERE worktree_id = ?").get(worktreeId) as {
      repo_id: string;
      worktree_id: string;
      enabled: number;
      last_successful_index_at: string | null;
    } | undefined;
  } finally {
    db.close();
  }
}

function readIndexedFacts(dbPath: string) {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const files = new Map(
      (
        db.prepare("SELECT repo_relative_path, analysis_quality FROM file_index ORDER BY repo_relative_path").all() as Array<{
          repo_relative_path: string;
          analysis_quality: string;
        }>
      ).map((row) => [row.repo_relative_path, row]),
    );

    const omitted = db.prepare("SELECT repo_relative_path, reason FROM omitted_files ORDER BY repo_relative_path").all() as Array<{
      repo_relative_path: string;
      reason: string;
    }>;
    const symbols = db.prepare("SELECT repo_relative_path, name FROM symbols ORDER BY repo_relative_path, name").all() as Array<{
      repo_relative_path: string;
      name: string;
    }>;
    const imports = db.prepare("SELECT repo_relative_path, module_specifier FROM imports ORDER BY repo_relative_path, module_specifier").all() as Array<{
      repo_relative_path: string;
      module_specifier: string;
    }>;
    const exports = db.prepare("SELECT repo_relative_path, exported_name FROM exports ORDER BY repo_relative_path, exported_name").all() as Array<{
      repo_relative_path: string;
      exported_name: string;
    }>;
    const references = db.prepare("SELECT repo_relative_path, name FROM references_idx ORDER BY repo_relative_path, name").all() as Array<{
      repo_relative_path: string;
      name: string;
    }>;

    return { files, omitted, symbols, imports, exports, references };
  } finally {
    db.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
