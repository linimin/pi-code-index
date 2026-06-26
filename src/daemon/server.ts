import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { RepoRuntime } from "./repo-runtime.ts";
import { SqliteStoreManager, type FileAnalysisRecord, type OmittedFileRecord } from "./sqlite-store.ts";
import { TsJsAnalyzer } from "./tsjs-analyzer.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  asUnixTransport,
  buildRuntimePaths,
  createRepoId,
  createRepoRuntimeKey,
  type DaemonErrorResponse,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSuccessResponse,
  type HealthResponse,
  type OpenRepoResponse,
  type RepoDiagnostics,
  type RepoLocator,
  type RepoStatus,
} from "../shared/protocol.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", "target", ".venv"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const STALE_SETTLE_MS = 2_000;

export interface DaemonServerOptions {
  cacheDir?: string;
  socketPath: string;
  version?: string;
  indexingDebounceMs?: number;
}

export interface DaemonServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): HealthResponse;
  openRepo(locator: RepoLocator): Promise<OpenRepoResponse>;
  enableRepoIndexing(locator: RepoLocator): Promise<RepoStatus>;
  disableRepoIndexing(locator: RepoLocator): Promise<RepoStatus>;
  getStatus(locator: RepoLocator): Promise<RepoStatus>;
  getRepoDiagnostics(locator: RepoLocator): Promise<RepoDiagnostics>;
  reindexRepo(locator: RepoLocator): Promise<RepoStatus>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(message = "pi-code-index daemon is already running") {
    super(message);
    this.name = "DaemonAlreadyRunningError";
  }
}

class RequestError extends Error {
  readonly code:
    | "invalid_request"
    | "unknown_method"
    | "repo_not_open"
    | "repo_not_enabled"
    | "internal_error";
  readonly details?: unknown;

  constructor(
    code:
      | "invalid_request"
      | "unknown_method"
      | "repo_not_open"
      | "repo_not_enabled"
      | "internal_error",
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.details = details;
  }
}

interface IndexJobState {
  active: boolean;
  queued: boolean;
  timer?: NodeJS.Timeout;
}

interface DirtySnapshot {
  files: string[];
  signature: string;
  oldestAgeMs: number;
}

interface BaselineCandidate {
  repoRelativePath: string;
  content: string;
}

interface OverlayCandidate {
  repoRelativePath: string;
  content: string;
}

interface DiscoveryResult<TFile> {
  files: TFile[];
  omitted: OmittedFileRecord[];
}

class SocketDaemonServer implements DaemonServer {
  private readonly instanceId = randomUUID();
  private readonly version: string;
  private readonly startedAt = new Date().toISOString();
  private readonly runtimePaths: ReturnType<typeof buildRuntimePaths>;
  private readonly storeManager: SqliteStoreManager;
  private readonly analyzer = new TsJsAnalyzer();
  private readonly runtimes = new Map<string, RepoRuntime>();
  private readonly jobs = new Map<string, IndexJobState>();
  private readonly options: DaemonServerOptions;
  private readonly indexingDebounceMs: number;
  private server?: Server;
  private started = false;

  constructor(options: DaemonServerOptions) {
    this.options = options;
    this.version = options.version ?? "0.1.0";
    this.runtimePaths = buildRuntimePaths({
      cacheDir: options.cacheDir,
      socketPath: options.socketPath,
    });
    this.storeManager = new SqliteStoreManager({
      cacheDir: this.runtimePaths.cacheDir,
      indexerVersion: this.version,
    });
    this.indexingDebounceMs = options.indexingDebounceMs ?? 50;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.ensureRuntimeDirectories();

    const server = createServer((socket) => {
      void this.handleSocket(socket);
    });

    server.on("error", (error) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") {
        return;
      }

      // eslint-disable-next-line no-console
      console.error("pi-code-index daemon socket error", error);
    });

    await this.listen(server);
    await chmod(this.options.socketPath, 0o600).catch(() => undefined);
    await writeFile(
      this.runtimePaths.pidFile,
      JSON.stringify(
        {
          pid: process.pid,
          instanceId: this.instanceId,
          startedAt: this.startedAt,
          socketPath: this.options.socketPath,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await chmod(this.runtimePaths.pidFile, 0o600).catch(() => undefined);

    this.server = server;
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.timer) {
        clearTimeout(job.timer);
      }
    }
    this.jobs.clear();

    if (!this.server) {
      await this.cleanupSocketArtifacts();
      this.started = false;
      return;
    }

    const server = this.server;
    this.server = undefined;
    this.started = false;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }).catch(() => undefined);

    await this.cleanupSocketArtifacts();
  }

  health(): HealthResponse {
    return {
      daemonVersion: this.version,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      pid: process.pid,
      startedAt: this.startedAt,
      capabilities: [
        "health",
        "openRepo",
        "enableRepoIndexing",
        "disableRepoIndexing",
        "getStatus",
        "getRepoDiagnostics",
        "reindexRepo",
      ],
    };
  }

  async openRepo(locator: RepoLocator): Promise<OpenRepoResponse> {
    const runtime = await this.ensureRuntime(locator);
    await this.refreshRuntimeProjection(runtime, locator);
    return runtime.toOpenRepoResponse();
  }

  async enableRepoIndexing(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    runtime.enable();
    this.scheduleIndex(runtime, locator, "enable");
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
  }

  async disableRepoIndexing(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    runtime.disable();
    const job = this.jobs.get(runtime.key);
    if (job?.timer) {
      clearTimeout(job.timer);
      job.timer = undefined;
      job.queued = false;
      job.active = false;
    }
    await this.refreshRuntimeProjection(runtime, locator);
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
  }

  async getStatus(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    await this.refreshRuntimeProjection(runtime, locator);
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
  }

  async getRepoDiagnostics(locator: RepoLocator): Promise<RepoDiagnostics> {
    const runtime = await this.ensureRuntime(locator);
    await this.refreshRuntimeProjection(runtime, locator);
    const storageSummary = await this.storeManager.getStorageSummary(runtime.repoId, runtime.overlay);
    const job = this.jobs.get(runtime.key);

    return runtime.toDiagnostics({
      health: this.health(),
      transport: asUnixTransport(this.options.socketPath),
      storageSummary,
      queueDepth: job?.active || job?.queued ? 1 : 0,
      activeJobs: job?.active ? ["index-rebuild"] : [],
    });
  }

  async reindexRepo(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    runtime.reindex();
    this.scheduleIndex(runtime, locator, "reindex");
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
  }

  private scheduleIndex(runtime: RepoRuntime, locator: RepoLocator, trigger: "enable" | "reindex"): void {
    const job = this.jobs.get(runtime.key) ?? { active: false, queued: false };
    if (job.active) {
      job.queued = true;
      this.jobs.set(runtime.key, job);
      return;
    }

    if (job.timer) {
      clearTimeout(job.timer);
    }

    job.queued = true;
    job.timer = setTimeout(() => {
      job.timer = undefined;
      void this.runIndexJob(runtime, locator, trigger);
    }, this.indexingDebounceMs);
    this.jobs.set(runtime.key, job);
  }

  private async runIndexJob(runtime: RepoRuntime, locator: RepoLocator, trigger: "enable" | "reindex"): Promise<void> {
    const job = this.jobs.get(runtime.key) ?? { active: false, queued: false };
    if (!runtime.enabled) {
      job.active = false;
      job.queued = false;
      this.jobs.set(runtime.key, job);
      return;
    }

    job.active = true;
    job.queued = false;
    this.jobs.set(runtime.key, job);

    try {
      const refreshedRuntime = await this.ensureRuntime(locator);
      const dirtySnapshot = await this.computeDirtySnapshot(locator);
      refreshedRuntime.markIndexing(dirtySnapshot.files.length);

      const baselineDiscovery = await this.discoverBaselineFiles(locator);
      const overlayDiscovery = await this.discoverOverlayFiles(locator);
      const [baselineRecords, overlayRecords] = await Promise.all([
        Promise.all(baselineDiscovery.files.map((file) => this.analyzeFile(file.repoRelativePath, file.content))),
        Promise.all(overlayDiscovery.files.map((file) => this.analyzeFile(file.repoRelativePath, file.content))),
      ]);

      const indexedAt = new Date().toISOString();
      const baseline = await this.storeManager.replaceBaselineIndex({
        anchor: refreshedRuntime.baseline,
        repoId: refreshedRuntime.repoId,
        headCommit: locator.headCommit,
        worktreeId: locator.worktreeId,
        indexedFiles: baselineRecords,
        omittedFiles: baselineDiscovery.omitted,
        pendingFiles: [],
        indexedAt,
        dirtySignature: "baseline",
      });
      const overlay = await this.storeManager.replaceOverlayIndex({
        anchor: refreshedRuntime.overlay,
        repoId: refreshedRuntime.repoId,
        headCommit: locator.headCommit,
        worktreeId: locator.worktreeId,
        indexedFiles: overlayRecords,
        omittedFiles: overlayDiscovery.omitted,
        pendingFiles: dirtySnapshot.files,
        indexedAt,
        dirtySignature: dirtySnapshot.signature,
      });

      refreshedRuntime.markReady({
        baseline,
        overlay,
        indexedFiles: baselineRecords.length + overlayRecords.length,
        eligibleFiles:
          baselineRecords.length +
          overlayRecords.length +
          baselineDiscovery.omitted.length +
          overlayDiscovery.omitted.length,
        omittedFiles: baselineDiscovery.omitted.length + overlayDiscovery.omitted.length,
        pendingFiles: 0,
        indexedAt,
      });

      await this.refreshRuntimeProjection(refreshedRuntime, locator);
    } catch (error) {
      runtime.markError(error instanceof Error ? error.message : String(error));
    } finally {
      job.active = false;
      const rerun = job.queued;
      job.queued = false;
      this.jobs.set(runtime.key, job);
      if (rerun && runtime.enabled) {
        this.scheduleIndex(runtime, locator, trigger);
      }
    }
  }

  private async refreshRuntimeProjection(runtime: RepoRuntime, locator: RepoLocator): Promise<void> {
    const currentRuntime = await this.ensureRuntime(locator);
    const [baselineSnapshot, overlaySnapshot] = await Promise.all([
      this.storeManager.readSnapshot(currentRuntime.baseline),
      this.storeManager.readSnapshot(currentRuntime.overlay),
    ]);
    const baselineIndexed = baselineSnapshot.indexedFiles;
    const overlayIndexed = overlaySnapshot.indexedFiles;
    const eligibleFiles = baselineIndexed + overlayIndexed + baselineSnapshot.omittedFiles + overlaySnapshot.omittedFiles;

    let currentDirty: DirtySnapshot;
    try {
      currentDirty = await this.computeDirtySnapshot(locator);
    } catch (error) {
      currentRuntime.syncCoverage({
        baseline: currentRuntime.baseline,
        overlay: currentRuntime.overlay,
        indexedFiles: baselineIndexed + overlayIndexed,
        eligibleFiles,
        omittedFiles: baselineSnapshot.omittedFiles + overlaySnapshot.omittedFiles,
        pendingFiles: 0,
        lastIndexedAt: overlaySnapshot.lastIndexedAt ?? baselineSnapshot.lastIndexedAt,
      });
      if (currentRuntime.enabled) {
        currentRuntime.markError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    currentRuntime.syncCoverage({
      baseline: currentRuntime.baseline,
      overlay: currentRuntime.overlay,
      indexedFiles: baselineIndexed + overlayIndexed,
      eligibleFiles,
      omittedFiles: baselineSnapshot.omittedFiles + overlaySnapshot.omittedFiles,
      pendingFiles: currentDirty.files.length,
      lastIndexedAt: overlaySnapshot.lastIndexedAt ?? baselineSnapshot.lastIndexedAt,
    });

    const job = this.jobs.get(currentRuntime.key);
    if (!currentRuntime.enabled) {
      currentRuntime.state = "disabled";
      return;
    }

    if (job?.active || job?.queued) {
      currentRuntime.markIndexing(currentDirty.files.length);
      return;
    }

    if (currentRuntime.lastError) {
      currentRuntime.state = "error";
      return;
    }

    const snapshotMatches = currentDirty.signature === (overlaySnapshot.dirtySignature ?? "");
    if (currentRuntime.lastSuccessfulIndexAt && snapshotMatches) {
      currentRuntime.state = "ready";
      currentRuntime.filesPending = 0;
      return;
    }

    if (currentRuntime.lastSuccessfulIndexAt && currentDirty.files.length > 0 && currentDirty.oldestAgeMs >= STALE_SETTLE_MS) {
      currentRuntime.markStale(currentDirty.files.length);
      return;
    }

    if (!currentRuntime.lastSuccessfulIndexAt) {
      currentRuntime.state = "initializing";
      currentRuntime.filesPending = currentDirty.files.length;
      return;
    }

    currentRuntime.state = "ready";
    currentRuntime.filesPending = currentDirty.files.length;
  }

  private async analyzeFile(repoRelativePath: string, content: string): Promise<FileAnalysisRecord> {
    if (isPrimaryTsJsFile(repoRelativePath)) {
      const analysis = await this.analyzer.analyze({
        path: repoRelativePath,
        content,
      });
      return this.storeManager.createStructuralRecord(repoRelativePath, content, analysis);
    }

    return this.storeManager.createFallbackRecord(repoRelativePath, content);
  }

  private async discoverBaselineFiles(locator: RepoLocator): Promise<DiscoveryResult<BaselineCandidate>> {
    if (!locator.headCommit) {
      return { files: [], omitted: [] };
    }

    const trackedOutput = await runGit(locator.repoRoot, ["ls-tree", "-rz", "--full-tree", locator.headCommit]);
    const files: BaselineCandidate[] = [];
    const omitted: OmittedFileRecord[] = [];

    for (const entry of trackedOutput.split("\0")) {
      if (!entry) {
        continue;
      }

      const match = entry.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/s);
      if (!match) {
        continue;
      }

      const [, mode, type, , repoRelativePath] = match;
      if (type !== "blob" || mode === "120000") {
        omitted.push({ repoRelativePath, reason: mode === "120000" ? "symlink" : "special-file" });
        continue;
      }

      const blob = await runGit(locator.repoRoot, ["show", `${locator.headCommit}:${repoRelativePath}`], {
        encoding: "buffer",
        maxBuffer: MAX_FILE_BYTES + 64 * 1024,
      });
      const decision = evaluateBuffer(repoRelativePath, blob);
      if (decision.reason) {
        omitted.push({ repoRelativePath, reason: decision.reason });
        continue;
      }

      files.push({
        repoRelativePath,
        content: blob.toString("utf8"),
      });
    }

    return { files, omitted };
  }

  private async discoverOverlayFiles(locator: RepoLocator): Promise<DiscoveryResult<OverlayCandidate>> {
    const modified = await runGit(locator.repoRoot, ["ls-files", "-m", "-z"]);
    const untracked = await runGit(locator.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const unique = new Set([...splitNullSeparated(modified), ...splitNullSeparated(untracked)]);
    const files: OverlayCandidate[] = [];
    const omitted: OmittedFileRecord[] = [];

    for (const repoRelativePath of [...unique].sort()) {
      const absolutePath = join(locator.repoRoot, repoRelativePath);
      const safePath = normalizeRepoRelative(locator.repoRoot, absolutePath);
      if (!safePath) {
        omitted.push({ repoRelativePath, reason: "outside-repo-root" });
        continue;
      }

      const entry = await lstat(absolutePath).catch(() => null);
      if (!entry) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        omitted.push({ repoRelativePath, reason: "symlink" });
        continue;
      }

      if (!entry.isFile()) {
        omitted.push({ repoRelativePath, reason: "special-file" });
        continue;
      }

      const buffer = await readFile(absolutePath);
      const decision = evaluateBuffer(safePath, buffer);
      if (decision.reason) {
        omitted.push({ repoRelativePath: safePath, reason: decision.reason });
        continue;
      }

      files.push({
        repoRelativePath: safePath,
        content: buffer.toString("utf8"),
      });
    }

    return { files, omitted };
  }

  private async computeDirtySnapshot(locator: RepoLocator): Promise<DirtySnapshot> {
    const modified = await runGit(locator.repoRoot, ["ls-files", "-m", "-z"]);
    const untracked = await runGit(locator.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const files = [...new Set([...splitNullSeparated(modified), ...splitNullSeparated(untracked)])].sort();

    let oldestAgeMs = 0;
    const signatureParts: string[] = [];
    for (const repoRelativePath of files) {
      const entry = await stat(join(locator.repoRoot, repoRelativePath)).catch(() => null);
      if (!entry) {
        signatureParts.push(`${repoRelativePath}:missing`);
        continue;
      }

      const age = Date.now() - entry.mtimeMs;
      if (age > oldestAgeMs) {
        oldestAgeMs = age;
      }
      signatureParts.push(`${repoRelativePath}:${entry.size}:${Math.floor(entry.mtimeMs)}`);
    }

    return {
      files,
      signature: signatureParts.join("\n"),
      oldestAgeMs,
    };
  }

  private async handleSocket(socket: Socket): Promise<void> {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      void this.flushBuffer(socket, () => {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return null;
        }

        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        return line;
      });
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  private async flushBuffer(socket: Socket, nextLine: () => string | null): Promise<void> {
    while (true) {
      const line = nextLine();
      if (line === null) {
        return;
      }

      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const response = await this.dispatch(trimmed);
      socket.write(`${JSON.stringify(response)}\n`);
    }
  }

  private async dispatch(rawRequest: string): Promise<DaemonResponse> {
    let request: DaemonRequest;

    try {
      request = JSON.parse(rawRequest) as DaemonRequest;
    } catch (error) {
      return this.errorResponse("unknown", new RequestError("invalid_request", "Request body is not valid JSON.", error));
    }

    if (!request || typeof request.id !== "string" || typeof request.method !== "string") {
      return this.errorResponse(
        typeof request?.id === "string" ? request.id : "unknown",
        new RequestError("invalid_request", "Request must include string `id` and `method` fields."),
      );
    }

    try {
      const result = await this.dispatchMethod(request.method as DaemonMethod, request.params);
      return this.successResponse(request.id, result);
    } catch (error) {
      if (error instanceof RequestError) {
        return this.errorResponse(request.id, error);
      }

      return this.errorResponse(
        request.id,
        new RequestError("internal_error", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async dispatchMethod(method: DaemonMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case "health":
        return this.health();
      case "openRepo":
        return this.openRepo(this.assertRepoLocator(params));
      case "enableRepoIndexing":
        return this.enableRepoIndexing(this.assertRepoLocator(params));
      case "disableRepoIndexing":
        return this.disableRepoIndexing(this.assertRepoLocator(params));
      case "getStatus":
        return this.getStatus(this.assertRepoLocator(params));
      case "getRepoDiagnostics":
        return this.getRepoDiagnostics(this.assertRepoLocator(params));
      case "reindexRepo":
        return this.reindexRepo(this.assertRepoLocator(params));
      default:
        throw new RequestError("unknown_method", `Unknown daemon method: ${String(method)}`);
    }
  }

  private assertRepoLocator(params: unknown): RepoLocator {
    if (!params || typeof params !== "object") {
      throw new RequestError("invalid_request", "Repo request must include a repo locator object.");
    }

    const candidate = params as Partial<RepoLocator>;
    if (
      typeof candidate.repoRoot !== "string" ||
      typeof candidate.repoName !== "string" ||
      typeof candidate.gitDir !== "string" ||
      typeof candidate.worktreeId !== "string"
    ) {
      throw new RequestError(
        "invalid_request",
        "Repo locator must include `repoRoot`, `repoName`, `gitDir`, and `worktreeId` strings.",
      );
    }

    return {
      repoRoot: candidate.repoRoot,
      repoName: candidate.repoName,
      gitDir: candidate.gitDir,
      worktreeId: candidate.worktreeId,
      headCommit: typeof candidate.headCommit === "string" ? candidate.headCommit : null,
    };
  }

  private successResponse<TResult>(id: string, result: TResult): DaemonSuccessResponse<TResult> {
    return {
      id,
      ok: true,
      result,
    };
  }

  private errorResponse(id: string, error: RequestError): DaemonErrorResponse {
    return {
      id,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  private async ensureRuntime(locator: RepoLocator): Promise<RepoRuntime> {
    const repoId = createRepoId(locator.repoRoot);
    const runtimeKey = createRepoRuntimeKey(locator);
    const anchors = await this.storeManager.ensureRepoStores(locator);
    const existing = this.runtimes.get(runtimeKey);

    if (existing) {
      existing.refresh(locator, anchors);
      return existing;
    }

    const runtime = new RepoRuntime({
      repoId,
      repoName: locator.repoName,
      repoRoot: locator.repoRoot,
      gitDir: locator.gitDir,
      worktreeId: locator.worktreeId,
      headCommit: locator.headCommit,
      enabled: false,
      state: "disabled",
      baseline: anchors.baseline,
      overlay: anchors.overlay,
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });

    this.runtimes.set(runtime.key, runtime);
    return runtime;
  }

  private async listen(server: Server): Promise<void> {
    const listenOnce = async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.socketPath);
      });
    };

    try {
      await listenOnce();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EADDRINUSE") {
        throw err;
      }

      const active = await canConnect(this.options.socketPath);
      if (active) {
        throw new DaemonAlreadyRunningError();
      }

      await rm(this.options.socketPath, { force: true }).catch(() => undefined);
      await listenOnce();
    }
  }

  private async ensureRuntimeDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.runtimePaths.cacheDir, { recursive: true, mode: 0o700 }),
      mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(this.runtimePaths.cacheDir, 0o700).catch(() => undefined),
      chmod(dirname(this.options.socketPath), 0o700).catch(() => undefined),
    ]);
  }

  private async cleanupSocketArtifacts(): Promise<void> {
    await Promise.all([
      rm(this.options.socketPath, { force: true }).catch(() => undefined),
      rm(this.runtimePaths.pidFile, { force: true }).catch(() => undefined),
    ]);
  }
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

export async function createDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  return new SocketDaemonServer(options);
}

function isPrimaryTsJsFile(path: string): boolean {
  return /\.(cts|cjs|js|jsx|mjs|mts|ts|tsx)$/i.test(path);
}

function splitNullSeparated(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

function normalizeRepoRelative(repoRoot: string, absolutePath: string): string | null {
  const rel = relative(repoRoot, absolutePath);
  if (rel.startsWith("..") || rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return null;
  }

  return rel.replace(/\\/g, "/");
}

function evaluateBuffer(repoRelativePath: string, buffer: Buffer): { reason?: string } {
  if (isDefaultExcluded(repoRelativePath)) {
    return { reason: "default-excluded" };
  }

  if (isSensitivePath(repoRelativePath)) {
    return { reason: "sensitive-file" };
  }

  if (buffer.byteLength > MAX_FILE_BYTES) {
    return { reason: "too-large" };
  }

  if (isBinaryBuffer(buffer)) {
    return { reason: "binary" };
  }

  return {};
}

function isDefaultExcluded(repoRelativePath: string): boolean {
  const parts = repoRelativePath.split("/");
  return parts.some((part) => DEFAULT_EXCLUDED_DIRS.has(part));
}

function isSensitivePath(repoRelativePath: string): boolean {
  const base = repoRelativePath.split("/").at(-1)?.toLowerCase() ?? repoRelativePath.toLowerCase();
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    /\.(pem|key|p12|pfx)$/i.test(base)
  );
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    return true;
  }

  const decoded = sample.toString("utf8");
  return decoded.includes("\ufffd");
}

async function runGit(
  cwd: string,
  args: string[],
  options: { encoding?: "utf8" | "buffer"; maxBuffer?: number } = {},
): Promise<string | Buffer> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  });
  return result.stdout;
}
