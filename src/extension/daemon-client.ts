import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DAEMON_PROTOCOL_VERSION,
  buildRuntimePaths,
  createWorktreeId,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonWireError,
  type FileSummaryParams,
  type FileSummaryResponse,
  type HealthResponse,
  type ImpactAnalysisParams,
  type ImpactAnalysisResponse,
  type OpenRepoResponse,
  type RepoDiagnostics,
  type RepoLocator,
  type RepoStatus,
  type SymbolLookupParams,
  type SymbolLookupResponse,
} from "../shared/protocol.ts";

const execFileAsync = promisify(execFile);

export interface DaemonClientOptions {
  cacheDir?: string;
  socketPath?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

export interface DaemonCallOptions {
  startIfNeeded?: boolean;
}

export type RepoContextErrorCode = "git_unavailable" | "not_git_repo" | "git_error";

export class UnsupportedPlatformError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(
      `pi-code-index currently supports daemon lazy-start only on local POSIX hosts (darwin/linux). Current platform: ${platform}.`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

export class RepoContextError extends Error {
  readonly code: RepoContextErrorCode;

  constructor(code: RepoContextErrorCode, message: string) {
    super(message);
    this.name = "RepoContextError";
    this.code = code;
  }
}

export class ProtocolMismatchError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(
      `pi-code-index protocol mismatch: extension expects protocol ${expected}, but daemon reported ${received}. Restart the daemon after upgrading the package.`,
    );
    this.name = "ProtocolMismatchError";
    this.expected = expected;
    this.received = received;
  }
}

export class DaemonUnavailableError extends Error {
  readonly socketPath: string;
  readonly cause?: unknown;

  constructor(socketPath: string, message: string, cause?: unknown) {
    super(message);
    this.name = "DaemonUnavailableError";
    this.socketPath = socketPath;
    this.cause = cause;
  }
}

export class DaemonRemoteError extends Error {
  readonly remote: DaemonWireError;

  constructor(remote: DaemonWireError) {
    super(remote.message);
    this.name = "DaemonRemoteError";
    this.remote = remote;
  }
}

export function defaultSocketPath(): string {
  return buildRuntimePaths().socketPath;
}

export async function resolveRepoLocator(cwd: string): Promise<RepoLocator> {
  const repoRoot = await runGitForPath(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = await runGitForPath(cwd, ["rev-parse", "--absolute-git-dir"]);
  const [canonicalRepoRoot, canonicalGitDir] = await Promise.all([realpath(repoRoot), realpath(gitDir)]);
  const headCommit = await runGitForPath(cwd, ["rev-parse", "HEAD"], { allowFailure: true });

  return {
    repoRoot: canonicalRepoRoot,
    repoName: basename(canonicalRepoRoot),
    gitDir: canonicalGitDir,
    worktreeId: createWorktreeId(canonicalRepoRoot, canonicalGitDir),
    headCommit: headCommit.length > 0 ? headCommit : null,
  };
}

export class DaemonClient {
  readonly cacheDir: string;
  readonly socketPath: string;
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(options: DaemonClientOptions = {}) {
    const runtimePaths = buildRuntimePaths({
      cacheDir: options.cacheDir,
      socketPath: options.socketPath,
    });

    this.cacheDir = runtimePaths.cacheDir;
    this.socketPath = runtimePaths.socketPath;
    this.startTimeoutMs = options.startTimeoutMs ?? 2_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.platform = options.platform ?? process.platform;
  }

  async health(options: DaemonCallOptions = {}): Promise<HealthResponse> {
    return this.ensureDaemon(options.startIfNeeded ?? true);
  }

  async openRepo(locator: RepoLocator, options: DaemonCallOptions = {}): Promise<OpenRepoResponse> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<RepoLocator, OpenRepoResponse>("openRepo", locator);
  }

  async enableRepoIndexing(locator: RepoLocator, options: DaemonCallOptions = {}): Promise<RepoStatus> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<RepoLocator, RepoStatus>("enableRepoIndexing", locator);
  }

  async disableRepoIndexing(locator: RepoLocator, options: DaemonCallOptions = {}): Promise<RepoStatus> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<RepoLocator, RepoStatus>("disableRepoIndexing", locator);
  }

  async getStatus(locator: RepoLocator, options: DaemonCallOptions = {}): Promise<RepoStatus> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<RepoLocator, RepoStatus>("getStatus", locator);
  }

  async getRepoDiagnostics(
    locator: RepoLocator,
    options: DaemonCallOptions = {},
  ): Promise<RepoDiagnostics> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<RepoLocator, RepoDiagnostics>("getRepoDiagnostics", locator);
  }

  async reindexRepo(locator: RepoLocator, options: DaemonCallOptions = {}): Promise<RepoStatus> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<RepoLocator, RepoStatus>("reindexRepo", locator);
  }

  async symbolLookup(params: SymbolLookupParams, options: DaemonCallOptions = {}): Promise<SymbolLookupResponse> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<SymbolLookupParams, SymbolLookupResponse>("symbolLookup", params);
  }

  async fileSummary(params: FileSummaryParams, options: DaemonCallOptions = {}): Promise<FileSummaryResponse> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<FileSummaryParams, FileSummaryResponse>("fileSummary", params);
  }

  async impactAnalysis(
    params: ImpactAnalysisParams,
    options: DaemonCallOptions = {},
  ): Promise<ImpactAnalysisResponse> {
    await this.ensureCompatibleDaemon(options.startIfNeeded ?? true);
    return this.rawRequest<ImpactAnalysisParams, ImpactAnalysisResponse>("impactAnalysis", params);
  }

  private async ensureCompatibleDaemon(startIfNeeded: boolean): Promise<HealthResponse> {
    const health = await this.ensureDaemon(startIfNeeded);

    if (health.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw new ProtocolMismatchError(DAEMON_PROTOCOL_VERSION, health.protocolVersion);
    }

    return health;
  }

  private async ensureDaemon(startIfNeeded: boolean): Promise<HealthResponse> {
    try {
      return await this.rawRequest<Record<string, never>, HealthResponse>("health", {});
    } catch (error) {
      if (!startIfNeeded || !isAvailabilityError(error)) {
        throw error;
      }
    }

    this.assertSupportedPlatform();
    this.spawnDaemon();

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this.rawRequest<Record<string, never>, HealthResponse>("health", {});
      } catch (error) {
        if (!isAvailabilityError(error)) {
          throw error;
        }
      }

      await delay(50);
    }

    throw new DaemonUnavailableError(
      this.socketPath,
      `Timed out waiting for the pi-code-index daemon to become reachable at ${this.socketPath}.`,
    );
  }

  private spawnDaemon(): void {
    const daemonEntryPath = fileURLToPath(new URL("../daemon/main.ts", import.meta.url));

    const child = spawn(process.execPath, ["--experimental-strip-types", daemonEntryPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PI_CODE_INDEX_CACHE_DIR: this.cacheDir,
        PI_CODE_INDEX_SOCKET_PATH: this.socketPath,
      },
    });

    child.unref();
  }

  private assertSupportedPlatform(): void {
    if (this.platform !== "darwin" && this.platform !== "linux") {
      throw new UnsupportedPlatformError(this.platform);
    }
  }

  private async rawRequest<TParams, TResult>(method: string, params: TParams): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const request: DaemonRequest<TParams> = {
        id: randomUUID(),
        method: method as DaemonRequest<TParams>["method"],
        params,
      };
      const socket = createConnection(this.socketPath);
      let settled = false;
      let buffer = "";

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        reject(error);
      };

      const succeed = (result: TResult) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.removeAllListeners();
        socket.end();
        resolve(result);
      };

      socket.setEncoding("utf8");
      socket.setTimeout(this.requestTimeoutMs, () => {
        fail(
          new DaemonUnavailableError(
            this.socketPath,
            `Timed out waiting for a daemon response from ${this.socketPath}.`,
          ),
        );
      });

      socket.once("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });

      socket.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }

        const line = buffer.slice(0, newlineIndex);
        let response: DaemonResponse<TResult>;
        try {
          response = JSON.parse(line) as DaemonResponse<TResult>;
        } catch (error) {
          fail(new Error(`Daemon returned invalid JSON: ${String(error)}`));
          return;
        }

        if (!response.ok) {
          if (response.error.code === "protocol_mismatch") {
            const details = (response.error.details ?? {}) as { expected?: number; received?: number };
            fail(
              new ProtocolMismatchError(
                details.expected ?? DAEMON_PROTOCOL_VERSION,
                details.received ?? Number.NaN,
              ),
            );
            return;
          }

          fail(new DaemonRemoteError(response.error));
          return;
        }

        succeed(response.result);
      });

      socket.once("error", (error) => {
        fail(
          new DaemonUnavailableError(
            this.socketPath,
            `Unable to reach the pi-code-index daemon at ${this.socketPath}.`,
            error,
          ),
        );
      });
    });
  }
}

function isAvailabilityError(error: unknown): boolean {
  return error instanceof DaemonUnavailableError;
}

async function runGitForPath(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };

    if (err.code === "ENOENT") {
      throw new RepoContextError(
        "git_unavailable",
        "Git is required for pi-code-index, but `git` is not available on PATH.",
      );
    }

    if (options.allowFailure) {
      return "";
    }

    const stderr = err.stderr?.trim();
    if (stderr && /not a git repository/i.test(stderr)) {
      throw new RepoContextError(
        "not_git_repo",
        "The current working directory is not inside a Git repository. Run `/index enable` from a Git repo root or subdirectory.",
      );
    }

    throw new RepoContextError(
      "git_error",
      stderr && stderr.length > 0 ? stderr : `Git command failed: git ${args.join(" ")}`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
