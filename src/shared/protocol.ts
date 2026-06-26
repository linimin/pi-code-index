export const DAEMON_PROTOCOL_VERSION = 1 as const;

export type RepoIndexingState =
  | "disabled"
  | "initializing"
  | "indexing"
  | "ready"
  | "stale"
  | "error";

export type AnalysisQuality = "basic" | "structural" | "semantic";

export type ResultProvenance = "local" | "shared-baseline" | "merged";

export interface CoverageMetadata {
  eligibleFiles: number;
  indexedFiles: number;
  indexedPercent: number;
}

export interface HealthResponse {
  daemonVersion: string;
  protocolVersion: number;
  instanceId: string;
  pid: number;
  capabilities: string[];
}

export interface RepoStatus {
  repoRoot: string;
  state: RepoIndexingState;
  indexedAt?: string;
  headCommit?: string;
  filesPending?: number;
  overlayState?: string;
  coverage?: CoverageMetadata;
}

export interface RepoDiagnostics extends RepoStatus {
  protocolVersion: number;
  transport: string;
  worktreeId: string;
  analyzerCapabilities: Record<string, AnalysisQuality>;
  queueDepth: number;
  activeJobs: string[];
  storageSummary: {
    baselineCount: number;
    overlayBytes: number;
    totalBytes: number;
  };
  lastError?: string;
  recommendedAction?: string;
}
