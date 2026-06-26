import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { RepoRuntime } from "./repo-runtime.ts";
import { SqliteStoreManager } from "./sqlite-store.ts";
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

export interface DaemonServerOptions {
  cacheDir?: string;
  socketPath: string;
  version?: string;
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

class SocketDaemonServer implements DaemonServer {
  private readonly instanceId = randomUUID();
  private readonly version: string;
  private readonly startedAt = new Date().toISOString();
  private readonly runtimePaths: ReturnType<typeof buildRuntimePaths>;
  private readonly storeManager: SqliteStoreManager;
  private readonly runtimes = new Map<string, RepoRuntime>();
  private readonly options: DaemonServerOptions;
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
    return runtime.toOpenRepoResponse();
  }

  async enableRepoIndexing(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    runtime.enable();
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
  }

  async disableRepoIndexing(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    runtime.disable();
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
  }

  async getStatus(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
  }

  async getRepoDiagnostics(locator: RepoLocator): Promise<RepoDiagnostics> {
    const runtime = await this.ensureRuntime(locator);
    const storageSummary = await this.storeManager.getStorageSummary(runtime.repoId, runtime.overlay);

    return runtime.toDiagnostics({
      health: this.health(),
      transport: asUnixTransport(this.options.socketPath),
      storageSummary,
    });
  }

  async reindexRepo(locator: RepoLocator): Promise<RepoStatus> {
    const runtime = await this.ensureRuntime(locator);
    runtime.reindex();
    return runtime.toStatus(this.health(), asUnixTransport(this.options.socketPath));
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
