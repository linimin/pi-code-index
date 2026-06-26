import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { registerIndexCommand } from "../src/extension/commands/index-command.ts";
import { DaemonClient, DaemonUnavailableError, resolveRepoLocator } from "../src/extension/daemon-client.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  baselineKeyForHead,
  createRepoId,
  type RepoLocator,
} from "../src/shared/protocol.ts";

interface Notification {
  level: "info" | "warn" | "error";
  message: string;
}

interface RegisteredCommand {
  handler: (args: string, ctx: { hasUI: boolean; cwd: string; ui: { notify(message: string, level?: Notification["level"]): void } }) => Promise<void>;
}

test("daemon lazy-starts and handshakes over the Unix socket", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-test-"));
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const client = new DaemonClient({ cacheDir, socketPath, startTimeoutMs: 4_000, requestTimeoutMs: 2_000 });

  t.after(async () => {
    await stopDaemon(client);
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await client.health();

  assert.equal(health.protocolVersion, DAEMON_PROTOCOL_VERSION);
  assert.equal(typeof health.daemonVersion, "string");
  assert.ok(health.capabilities.includes("openRepo"));
  assert.ok(health.capabilities.includes("getRepoDiagnostics"));
  assert.match(health.instanceId, /^[0-9a-f-]+$/i);
  assert.equal(await pathExists(socketPath), true);
});


test("daemon idles out after the last enabled repo is disabled and cleanly restarts on demand", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-idle-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const client = new DaemonClient({ cacheDir, socketPath, startTimeoutMs: 4_000, requestTimeoutMs: 2_000 });

  t.after(async () => {
    await stopDaemon(client);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await setupGitRepo(repoDir);
  const repo = await resolveRepoLocator(repoDir);
  await client.enableRepoIndexing(repo);
  await waitFor(async () => (await client.getStatus(repo)).enabled, 3_000);

  const disableStatus = await client.disableRepoIndexing(repo);
  assert.equal(disableStatus.enabled, false);
  assert.equal(disableStatus.state, "disabled");

  await waitFor(async () => !(await pathExists(socketPath)), 3_000);
  assert.equal(await pathExists(socketPath), false);
  assert.equal(await pathExists(join(cacheDir, "daemon.pid")), false);

  const restartedHealth = await client.health();
  assert.equal(restartedHealth.protocolVersion, DAEMON_PROTOCOL_VERSION);
  assert.equal(await pathExists(socketPath), true);

  const restartedStatus = await client.getStatus(repo);
  assert.equal(restartedStatus.enabled, false);
  assert.equal(restartedStatus.state, "disabled");
});

test("/index status and /index doctor preserve unloaded runtime observability across disable and idle restart", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-observe-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const clientOptions = { cacheDir, socketPath, startTimeoutMs: 4_000, requestTimeoutMs: 2_000 };
  const client = new DaemonClient(clientOptions);
  const indexCommand = createRegisteredIndexCommand(clientOptions);

  t.after(async () => {
    await stopDaemon(client);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await setupGitRepo(repoDir);
  const repo = await resolveRepoLocator(repoDir);
  await client.enableRepoIndexing(repo);
  await waitFor(async () => (await client.getStatus(repo)).enabled, 3_000);

  const disableStatus = await client.disableRepoIndexing(repo);
  assert.equal(disableStatus.runtimeLoaded, false);
  assert.equal(disableStatus.daemonLifecycle.loadedRuntimeCount, 0);

  const statusAfterDisable = await runIndexCommand(indexCommand, "status", repoDir);
  assert.match(statusAfterDisable[0]?.message ?? "", /Runtime loaded: no/);
  assert.match(statusAfterDisable[0]?.message ?? "", /Daemon lifecycle: enabledRepos=0, loadedRuntimes=0, activeRequests=1, activeJobs=0/);

  const doctorAfterDisable = await runIndexCommand(indexCommand, "doctor", repoDir);
  assert.match(doctorAfterDisable[0]?.message ?? "", /Runtime loaded: no/);
  assert.match(doctorAfterDisable[0]?.message ?? "", /Daemon lifecycle: enabledRepos=0, loadedRuntimes=0, activeRequests=1, activeJobs=0/);

  const observedStatus = await client.getStatus(repo);
  assert.equal(observedStatus.runtimeLoaded, false);
  assert.equal(observedStatus.daemonLifecycle.loadedRuntimeCount, 0);

  await waitFor(async () => !(await pathExists(socketPath)), 3_000);

  const statusAfterRestart = await runIndexCommand(indexCommand, "status", repoDir);
  assert.match(statusAfterRestart[0]?.message ?? "", /Runtime loaded: no/);
  assert.match(statusAfterRestart[0]?.message ?? "", /Daemon lifecycle: enabledRepos=0, loadedRuntimes=0, activeRequests=1, activeJobs=0/);

  const doctorAfterRestart = await runIndexCommand(indexCommand, "doctor", repoDir);
  assert.match(doctorAfterRestart[0]?.message ?? "", /Runtime loaded: no/);
  assert.match(doctorAfterRestart[0]?.message ?? "", /Daemon lifecycle: enabledRepos=0, loadedRuntimes=0, activeRequests=1, activeJobs=0/);

  const restartedStatus = await client.getStatus(repo);
  assert.equal(restartedStatus.runtimeLoaded, false);
  assert.equal(restartedStatus.daemonLifecycle.loadedRuntimeCount, 0);
});

test("/index enable refuses to run outside a git repository", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-test-"));
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const clientOptions = { cacheDir, socketPath, startTimeoutMs: 4_000, requestTimeoutMs: 2_000 };
  const indexCommand = createRegisteredIndexCommand(clientOptions);

  t.after(async () => {
    await stopDaemon(new DaemonClient(clientOptions));
    await rm(tempRoot, { recursive: true, force: true });
  });

  const notifications = await runIndexCommand(indexCommand, "enable", tempRoot);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "error");
  assert.match(notifications[0]?.message ?? "", /not inside a Git repository/i);
  assert.equal(await pathExists(socketPath), false);
});

test("/index enable -> /index status -> /index doctor uses real daemon state and SQLite anchors", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-code-index-test-"));
  const repoDir = join(tempRoot, "repo");
  const cacheDir = join(tempRoot, "cache");
  const socketPath = join(cacheDir, "daemon.sock");
  const clientOptions = { cacheDir, socketPath, startTimeoutMs: 4_000, requestTimeoutMs: 2_000 };
  const client = new DaemonClient(clientOptions);
  const indexCommand = createRegisteredIndexCommand(clientOptions);

  t.after(async () => {
    await stopDaemon(client);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await setupGitRepo(repoDir);
  const repo = await resolveRepoLocator(repoDir);
  const expectedRepoId = createRepoId(repo.repoRoot);
  const expectedBaselinePath = join(
    cacheDir,
    "repos",
    expectedRepoId,
    "baselines",
    `${baselineKeyForHead(repo.headCommit)}.sqlite`,
  );
  const expectedOverlayPath = join(cacheDir, "repos", expectedRepoId, "overlays", `${repo.worktreeId}.sqlite`);

  const enableNotifications = await runIndexCommand(indexCommand, "enable", repoDir);
  assert.equal(enableNotifications.length, 1);
  assert.equal(enableNotifications[0]?.level, "info");
  assert.match(enableNotifications[0]?.message ?? "", /pi-code-index enabled for repo/i);
  assert.match(enableNotifications[0]?.message ?? "", /State: initializing/);
  assert.match(enableNotifications[0]?.message ?? "", new RegExp(escapeRegExp(expectedBaselinePath)));
  assert.match(enableNotifications[0]?.message ?? "", new RegExp(escapeRegExp(expectedOverlayPath)));

  const statusNotifications = await runIndexCommand(indexCommand, "status", repoDir);
  assert.equal(statusNotifications.length, 1);
  assert.match(statusNotifications[0]?.message ?? "", /pi-code-index status/);
  assert.match(statusNotifications[0]?.message ?? "", /Enabled: yes/);
  assert.match(statusNotifications[0]?.message ?? "", /Runtime loaded: yes/);
  assert.match(statusNotifications[0]?.message ?? "", /Daemon lifecycle: /);
  assert.match(statusNotifications[0]?.message ?? "", /Idle shutdown: /);
  assert.match(statusNotifications[0]?.message ?? "", /Registry: registered=1, enabled=1, disabled=0/);
  assert.match(statusNotifications[0]?.message ?? "", new RegExp(escapeRegExp(repo.repoRoot)));
  assert.match(statusNotifications[0]?.message ?? "", new RegExp(escapeRegExp(repo.worktreeId)));
  assert.match(statusNotifications[0]?.message ?? "", /Transport: unix:\/\//);

  const doctorNotifications = await runIndexCommand(indexCommand, "doctor", repoDir);
  assert.equal(doctorNotifications.length, 1);
  assert.match(doctorNotifications[0]?.message ?? "", /pi-code-index doctor/);
  assert.match(doctorNotifications[0]?.message ?? "", new RegExp(`Protocol version: ${DAEMON_PROTOCOL_VERSION}`));
  assert.match(doctorNotifications[0]?.message ?? "", new RegExp(`Repo ID: ${expectedRepoId}`));
  assert.match(doctorNotifications[0]?.message ?? "", /Daemon running: yes/);
  assert.match(doctorNotifications[0]?.message ?? "", /Runtime loaded: yes/);
  assert.match(doctorNotifications[0]?.message ?? "", /Daemon lifecycle: /);
  assert.match(doctorNotifications[0]?.message ?? "", /Idle shutdown: /);
  assert.match(doctorNotifications[0]?.message ?? "", /Registry: db=.*repo-registry\.sqlite, registered=1, enabled=1, disabled=0/);
  assert.match(doctorNotifications[0]?.message ?? "", /Registry states: /);
  assert.match(doctorNotifications[0]?.message ?? "", /Storage usage: baselines=1/);

  const status = await client.getStatus(repo);
  assert.equal(status.enabled, true);
  assert.equal(status.runtimeLoaded, true);
  assert.equal(["initializing", "indexing", "ready"].includes(status.state), true);
  assert.equal(status.daemonLifecycle.enabledRepoCount, 1);
  assert.equal(status.daemonLifecycle.loadedRuntimeCount, 1);
  assert.equal(status.repoId, expectedRepoId);
  assert.equal(status.baseline.dbPath, expectedBaselinePath);
  assert.equal(status.overlay.dbPath, expectedOverlayPath);
  assert.equal(await pathExists(expectedBaselinePath), true);
  assert.equal(await pathExists(expectedOverlayPath), true);

  const baselineMetadata = readMetadata(expectedBaselinePath);
  const overlayMetadata = readMetadata(expectedOverlayPath);
  assert.equal(baselineMetadata.get("schemaVersion"), "1");
  assert.equal(overlayMetadata.get("schemaVersion"), "1");
  assert.equal(baselineMetadata.get("repoId"), expectedRepoId);
  assert.equal(overlayMetadata.get("repoId"), expectedRepoId);
  assert.equal(baselineMetadata.get("anchorKind"), "baseline");
  assert.equal(overlayMetadata.get("anchorKind"), "overlay");
  assert.equal(baselineMetadata.get("headCommit"), repo.headCommit ?? "");
  assert.equal(overlayMetadata.get("worktreeId"), repo.worktreeId);
  assert.equal(JSON.parse(baselineMetadata.get("languageAdapterSet") ?? "[]").includes("typescript"), true);
});

function createRegisteredIndexCommand(clientOptions: ConstructorParameters<typeof DaemonClient>[0]): RegisteredCommand {
  let registeredCommand: RegisteredCommand | undefined;

  registerIndexCommand(
    {
      registerCommand(_name, options) {
        registeredCommand = options as RegisteredCommand;
      },
    } as never,
    {
      createClient: () => new DaemonClient(clientOptions),
      resolveRepo: resolveRepoLocator,
    },
  );

  assert.ok(registeredCommand, "expected /index command registration");
  return registeredCommand;
}

async function runIndexCommand(command: RegisteredCommand, args: string, cwd: string): Promise<Notification[]> {
  const notifications: Notification[] = [];

  await command.handler(args, {
    hasUI: true,
    cwd,
    ui: {
      notify(message: string, level: Notification["level"] = "info") {
        notifications.push({ message, level });
      },
    },
  });

  return notifications;
}

async function setupGitRepo(repoDir: string): Promise<RepoLocator> {
  await mkdir(repoDir, { recursive: true });
  execGit(repoDir, ["init"]);
  const cwd = repoDir;
  execGit(cwd, ["config", "user.email", "test@example.com"]);
  execGit(cwd, ["config", "user.name", "Test User"]);
  await writeFile(join(cwd, "index.ts"), "export const answer = 42;\n", "utf8");
  execGit(cwd, ["add", "."]);
  execGit(cwd, ["commit", "-m", "initial"]);
  return resolveRepoLocator(cwd);
}

function execGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function readMetadata(dbPath: string): Map<string, string> {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });

  try {
    const rows = db.prepare("SELECT key, value FROM metadata ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>;
    return new Map(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
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

    await waitFor(async () => !(await pathExists(client.socketPath)), 3_000);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return;
    }

    throw error;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
