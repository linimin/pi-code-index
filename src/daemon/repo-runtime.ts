import {
  DEFAULT_ANALYZER_CAPABILITIES,
  createRepoRuntimeKey,
  type CoverageMetadata,
  type HealthResponse,
  type OpenRepoResponse,
  type RepoDiagnostics,
  type RepoFreshness,
  type RepoIndexingState,
  type RepoLocator,
  type RepoStatus,
  type StoreAnchor,
} from "../shared/protocol.ts";

export interface RepoRuntimeDescriptor {
  repoId: string;
  repoName: string;
  repoRoot: string;
  gitDir: string;
  worktreeId: string;
  headCommit: string | null;
  enabled: boolean;
  state: RepoIndexingState;
  baseline: StoreAnchor;
  overlay: StoreAnchor;
  createdAt: string;
  lastUpdated: string;
  lastSuccessfulIndexAt?: string;
  lastError?: string;
}

export interface RepoDiagnosticsOptions {
  health: HealthResponse;
  transport: string;
  storageSummary: {
    baselineCount: number;
    overlayBytes: number;
    totalBytes: number;
  };
  queueDepth: number;
  activeJobs: string[];
}

const EMPTY_COVERAGE: CoverageMetadata = {
  eligibleFiles: 0,
  indexedFiles: 0,
  indexedPercent: 0,
  omittedFiles: 0,
};

export class RepoRuntime {
  readonly repoId: string;
  readonly createdAt: string;

  repoName: string;
  repoRoot: string;
  gitDir: string;
  worktreeId: string;
  headCommit: string | null;
  enabled: boolean;
  state: RepoIndexingState;
  baseline: StoreAnchor;
  overlay: StoreAnchor;
  lastUpdated: string;
  lastSuccessfulIndexAt?: string;
  lastError?: string;
  coverage: CoverageMetadata;
  filesPending: number;

  constructor(descriptor: RepoRuntimeDescriptor) {
    this.repoId = descriptor.repoId;
    this.createdAt = descriptor.createdAt;
    this.repoName = descriptor.repoName;
    this.repoRoot = descriptor.repoRoot;
    this.gitDir = descriptor.gitDir;
    this.worktreeId = descriptor.worktreeId;
    this.headCommit = descriptor.headCommit;
    this.enabled = descriptor.enabled;
    this.state = descriptor.state;
    this.baseline = descriptor.baseline;
    this.overlay = descriptor.overlay;
    this.lastUpdated = descriptor.lastUpdated;
    this.lastSuccessfulIndexAt = descriptor.lastSuccessfulIndexAt;
    this.lastError = descriptor.lastError;
    this.coverage = { ...EMPTY_COVERAGE };
    this.filesPending = 0;
  }

  get key(): string {
    return createRepoRuntimeKey(this);
  }

  refresh(locator: RepoLocator, anchors: { baseline: StoreAnchor; overlay: StoreAnchor }): void {
    const changed =
      this.repoName !== locator.repoName ||
      this.repoRoot !== locator.repoRoot ||
      this.gitDir !== locator.gitDir ||
      this.worktreeId !== locator.worktreeId ||
      this.headCommit !== locator.headCommit ||
      this.baseline.dbPath !== anchors.baseline.dbPath ||
      this.overlay.dbPath !== anchors.overlay.dbPath;

    this.repoName = locator.repoName;
    this.repoRoot = locator.repoRoot;
    this.gitDir = locator.gitDir;
    this.worktreeId = locator.worktreeId;
    this.headCommit = locator.headCommit;
    this.baseline = anchors.baseline;
    this.overlay = anchors.overlay;

    if (changed) {
      this.lastUpdated = new Date().toISOString();
      if (this.enabled && this.state === "ready") {
        this.state = "stale";
      }
    }
  }

  enable(): void {
    this.enabled = true;
    this.state = "initializing";
    this.filesPending = 0;
    this.lastError = undefined;
    this.lastUpdated = new Date().toISOString();
  }

  disable(): void {
    this.enabled = false;
    this.state = "disabled";
    this.filesPending = 0;
    this.lastUpdated = new Date().toISOString();
  }

  reindex(): void {
    if (!this.enabled) {
      throw new Error("Enable indexing before requesting a reindex.");
    }

    this.state = "indexing";
    this.lastError = undefined;
    this.lastUpdated = new Date().toISOString();
  }

  markIndexing(pendingFiles: number): void {
    if (!this.enabled) {
      return;
    }

    this.state = this.lastSuccessfulIndexAt ? "indexing" : "initializing";
    this.filesPending = pendingFiles;
    this.lastUpdated = new Date().toISOString();
  }

  markReady(input: {
    baseline: StoreAnchor;
    overlay: StoreAnchor;
    indexedFiles: number;
    eligibleFiles: number;
    omittedFiles: number;
    pendingFiles: number;
    indexedAt: string;
  }): void {
    this.baseline = input.baseline;
    this.overlay = input.overlay;
    this.coverage = buildCoverage(input.eligibleFiles, input.indexedFiles, input.omittedFiles);
    this.filesPending = input.pendingFiles;
    this.lastSuccessfulIndexAt = input.indexedAt;
    this.lastError = undefined;
    this.state = input.pendingFiles > 0 ? "stale" : "ready";
    this.lastUpdated = new Date().toISOString();
  }

  markStale(pendingFiles: number): void {
    if (!this.enabled || this.state === "disabled") {
      return;
    }

    this.state = "stale";
    this.filesPending = pendingFiles;
    this.lastUpdated = new Date().toISOString();
  }

  markError(message: string): void {
    this.state = "error";
    this.lastError = message;
    this.lastUpdated = new Date().toISOString();
  }

  syncCoverage(input: {
    baseline: StoreAnchor;
    overlay: StoreAnchor;
    indexedFiles: number;
    eligibleFiles: number;
    omittedFiles: number;
    pendingFiles: number;
    lastIndexedAt?: string;
  }): void {
    this.baseline = input.baseline;
    this.overlay = input.overlay;
    this.coverage = buildCoverage(input.eligibleFiles, input.indexedFiles, input.omittedFiles);
    this.filesPending = input.pendingFiles;
    this.lastSuccessfulIndexAt = input.lastIndexedAt ?? this.lastSuccessfulIndexAt;
  }

  toOpenRepoResponse(): OpenRepoResponse {
    return {
      repoId: this.repoId,
      repoRoot: this.repoRoot,
      repoName: this.repoName,
      worktreeId: this.worktreeId,
      headCommit: this.headCommit,
      enabled: this.enabled,
      state: this.state,
      baseline: this.baseline,
      overlay: this.overlay,
    };
  }

  toStatus(health: HealthResponse, transport: string): RepoStatus {
    return {
      repoId: this.repoId,
      repoRoot: this.repoRoot,
      repoName: this.repoName,
      worktreeId: this.worktreeId,
      enabled: this.enabled,
      state: this.state,
      mode: "local-daemon",
      transport,
      protocolVersion: health.protocolVersion,
      daemonVersion: health.daemonVersion,
      headCommit: this.headCommit,
      indexedFiles: this.coverage.indexedFiles,
      filesPending: this.filesPending,
      coverage: this.coverage,
      lastUpdated: this.lastUpdated,
      lastError: this.lastError,
      baseline: this.baseline,
      overlay: this.overlay,
      recommendedAction: this.recommendedAction(),
    };
  }

  toDiagnostics(options: RepoDiagnosticsOptions): RepoDiagnostics {
    const status = this.toStatus(options.health, options.transport);

    return {
      ...status,
      instanceId: options.health.instanceId,
      pid: options.health.pid,
      startedAt: options.health.startedAt,
      freshness: this.freshness(),
      repoIdentity: {
        repoId: this.repoId,
        repoRoot: this.repoRoot,
        gitDir: this.gitDir,
        worktreeId: this.worktreeId,
      },
      analyzerCapabilities: { ...DEFAULT_ANALYZER_CAPABILITIES },
      queueDepth: options.queueDepth,
      activeJobs: options.activeJobs,
      storageSummary: options.storageSummary,
      lastSuccessfulIndexAt: this.lastSuccessfulIndexAt,
      actionableErrors: this.lastError ? [this.lastError] : [],
    };
  }

  private recommendedAction(): string {
    switch (this.state) {
      case "disabled":
        return "Run `/index enable` to start background indexing for this repository.";
      case "initializing":
        return "Initial indexing is queued. Wait for background analysis to complete, then run `/index status` again.";
      case "indexing":
        return "A soft rebuild is in progress. Wait for indexing to complete, then run `/index status` again.";
      case "stale":
        return "Run `/index reindex` after git or filesystem changes settle.";
      case "error":
        return "Run `/index doctor`, fix the reported issue, then retry `/index enable` or `/index reindex`.";
      case "ready":
      default:
        return "No action needed.";
    }
  }

  private freshness(): RepoFreshness {
    switch (this.state) {
      case "error":
        return "error";
      case "stale":
        return "stale";
      case "ready":
        return "current";
      case "disabled":
      case "initializing":
      case "indexing":
      default:
        return "not-yet-indexed";
    }
  }
}

function buildCoverage(eligibleFiles: number, indexedFiles: number, omittedFiles: number): CoverageMetadata {
  return {
    eligibleFiles,
    indexedFiles,
    indexedPercent: eligibleFiles === 0 ? 0 : Math.round((indexedFiles / eligibleFiles) * 100),
    omittedFiles,
  };
}
