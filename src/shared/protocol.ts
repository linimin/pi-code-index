import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DAEMON_PROTOCOL_VERSION = 1 as const;
export const SQLITE_SCHEMA_VERSION = 1 as const;
export const INDEXER_LANGUAGE_ADAPTER_SET = [
  "typescript",
  "javascript",
  "fallback-basic",
] as const;

export type RepoIndexingState =
  | "disabled"
  | "initializing"
  | "indexing"
  | "ready"
  | "stale"
  | "error";

export type RepoFreshness = "not-yet-indexed" | "current" | "stale" | "error";

export type AnalysisQuality = "basic" | "structural" | "semantic";

export type ResultProvenance = "local" | "shared-baseline" | "merged";

export type DaemonMethod =
  | "health"
  | "openRepo"
  | "enableRepoIndexing"
  | "disableRepoIndexing"
  | "getStatus"
  | "getRepoDiagnostics"
  | "reindexRepo";

export interface CoverageMetadata {
  eligibleFiles: number;
  indexedFiles: number;
  indexedPercent: number;
}

export interface RuntimePaths {
  cacheDir: string;
  socketPath: string;
  reposDir: string;
  pidFile: string;
}

export interface RepoLocator {
  repoRoot: string;
  repoName: string;
  gitDir: string;
  worktreeId: string;
  headCommit: string | null;
}

export interface HealthResponse {
  daemonVersion: string;
  protocolVersion: number;
  instanceId: string;
  pid: number;
  startedAt: string;
  capabilities: DaemonMethod[];
}

export interface StoreMetadata {
  schemaVersion: number;
  indexerVersion: string;
  languageAdapterSet: string[];
  createdAt: string;
}

export interface StoreAnchor {
  kind: "baseline" | "overlay";
  dbPath: string;
  exists: boolean;
  bytes: number;
  metadata: StoreMetadata;
  headCommit?: string | null;
  worktreeId?: string;
}

export interface RepoStatus {
  repoId: string;
  repoRoot: string;
  repoName: string;
  worktreeId: string;
  enabled: boolean;
  state: RepoIndexingState;
  mode: "local-daemon";
  transport: string;
  protocolVersion: number;
  daemonVersion: string;
  headCommit: string | null;
  indexedFiles: number;
  filesPending: number;
  coverage: CoverageMetadata;
  lastUpdated: string;
  lastError?: string;
  baseline: StoreAnchor;
  overlay: StoreAnchor;
  recommendedAction: string;
}

export interface RepoDiagnostics extends RepoStatus {
  instanceId: string;
  pid: number;
  startedAt: string;
  freshness: RepoFreshness;
  repoIdentity: {
    repoId: string;
    repoRoot: string;
    gitDir: string;
    worktreeId: string;
  };
  analyzerCapabilities: Record<string, AnalysisQuality>;
  queueDepth: number;
  activeJobs: string[];
  storageSummary: {
    baselineCount: number;
    overlayBytes: number;
    totalBytes: number;
  };
  lastSuccessfulIndexAt?: string;
  actionableErrors: string[];
}

export interface OpenRepoResponse {
  repoId: string;
  repoRoot: string;
  repoName: string;
  worktreeId: string;
  headCommit: string | null;
  enabled: boolean;
  state: RepoIndexingState;
  baseline: StoreAnchor;
  overlay: StoreAnchor;
}

export interface DaemonRequest<TParams = unknown> {
  id: string;
  method: DaemonMethod;
  params: TParams;
}

export interface DaemonWireError {
  code:
    | "invalid_request"
    | "unknown_method"
    | "repo_not_open"
    | "repo_not_enabled"
    | "protocol_mismatch"
    | "internal_error";
  message: string;
  details?: unknown;
}

export interface DaemonSuccessResponse<TResult = unknown> {
  id: string;
  ok: true;
  result: TResult;
}

export interface DaemonErrorResponse {
  id: string;
  ok: false;
  error: DaemonWireError;
}

export type DaemonResponse<TResult = unknown> =
  | DaemonSuccessResponse<TResult>
  | DaemonErrorResponse;

export const DEFAULT_ANALYZER_CAPABILITIES: Record<string, AnalysisQuality> = {
  typescript: "structural",
  javascript: "structural",
  "fallback-file-summary": "basic",
};

export function stableId(input: string, length = 16): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function createRepoId(repoRoot: string): string {
  return stableId(repoRoot, 24);
}

export function createWorktreeId(repoRoot: string, gitDir: string): string {
  return stableId(`${repoRoot}\0${gitDir}`, 24);
}

export function createRepoRuntimeKey(locator: Pick<RepoLocator, "repoRoot" | "worktreeId">): string {
  return `${locator.repoRoot}::${locator.worktreeId}`;
}

export function baselineKeyForHead(headCommit: string | null): string {
  return headCommit ?? "unborn-head";
}

export function defaultCacheDir(): string {
  return process.env.PI_CODE_INDEX_CACHE_DIR ?? join(homedir(), ".cache", "pi-index");
}

export function defaultSocketPath(cacheDir = defaultCacheDir()): string {
  return process.env.PI_CODE_INDEX_SOCKET_PATH ?? join(cacheDir, "daemon.sock");
}

export function buildRuntimePaths(options: { cacheDir?: string; socketPath?: string } = {}): RuntimePaths {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const socketPath = options.socketPath ?? defaultSocketPath(cacheDir);

  return {
    cacheDir,
    socketPath,
    reposDir: join(cacheDir, "repos"),
    pidFile: join(cacheDir, "daemon.pid"),
  };
}

export function asUnixTransport(socketPath: string): string {
  return `unix://${socketPath}`;
}
