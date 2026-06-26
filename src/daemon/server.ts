import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { RepoRuntime } from "./repo-runtime.ts";
import { RepoRegistry } from "./repo-registry.ts";
import { SqliteStoreManager, type FileAnalysisRecord, type OmittedFileRecord } from "./sqlite-store.ts";
import { TsJsAnalyzer } from "./tsjs-analyzer.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  FILE_SUMMARY_RELATED_FILE_LIMIT,
  IMPACT_ANALYSIS_AREA_LIMIT,
  IMPACT_ANALYSIS_SUGGESTED_READ_LIMIT,
  SYMBOL_LOOKUP_MATCH_LIMIT,
  asUnixTransport,
  buildRuntimePaths,
  createRepoRuntimeKey,
  type AnalysisQuality,
  type DaemonErrorResponse,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSuccessResponse,
  type FileSummaryParams,
  type FileSummaryResponse,
  type HealthResponse,
  type ImpactAnalysisParams,
  type ImpactAnalysisResponse,
  type ImpactArea,
  type OpenRepoResponse,
  type QueryMetadata,
  type QueryRange,
  type RepoDiagnostics,
  type RepoFreshness,
  type RepoLocator,
  type RepoStatus,
  type ResultProvenance,
  type SymbolLookupMatch,
  type SymbolLookupParams,
  type SymbolLookupResponse,
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
  symbolLookup(params: SymbolLookupParams): Promise<SymbolLookupResponse>;
  fileSummary(params: FileSummaryParams): Promise<FileSummaryResponse>;
  impactAnalysis(params: ImpactAnalysisParams): Promise<ImpactAnalysisResponse>;
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

interface IndexedFileView {
  repoRelativePath: string;
  language: string;
  analysisQuality: AnalysisQuality;
  lineCount: number;
  summary: {
    lineCount: number;
    byteCount: number;
    preview: string;
  };
  symbols: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    exported: boolean;
  }>;
  imports: Array<{
    moduleSpecifier: string;
    importedName: string;
    localName: string;
    isTypeOnly: boolean;
  }>;
  exports: Array<{
    exportedName: string;
    kind: string;
    moduleSpecifier?: string;
  }>;
  references: Array<{
    name: string;
    line: number;
    column: number;
  }>;
}

class SocketDaemonServer implements DaemonServer {
  private readonly instanceId = randomUUID();
  private readonly version: string;
  private readonly startedAt = new Date().toISOString();
  private readonly runtimePaths: ReturnType<typeof buildRuntimePaths>;
  private readonly storeManager: SqliteStoreManager;
  private readonly registry: RepoRegistry;
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
    this.registry = new RepoRegistry({
      cacheDir: this.runtimePaths.cacheDir,
    });
    this.indexingDebounceMs = options.indexingDebounceMs ?? 50;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.ensureRuntimeDirectories();
    await this.registry.initialize();

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
        "symbolLookup",
        "fileSummary",
        "impactAnalysis",
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
    await this.registry.markEnabled(locator, runtime.repoId);
    await this.syncRegistryFromRuntime(locator, runtime);
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
    await this.registry.markDisabled(locator, runtime.repoId);
    await this.syncRegistryFromRuntime(locator, runtime);
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

  async symbolLookup(params: SymbolLookupParams): Promise<SymbolLookupResponse> {
    const status = await this.assertHealthyRepo(params.repo);
    const files = this.readMergedIndexedFiles(status);
    const query = params.symbol.trim();
    const requestedLimit = clampPositiveInt(params.limit, SYMBOL_LOOKUP_MATCH_LIMIT);
    const candidates = files.flatMap((file) =>
      file.symbols.map((symbol) => ({
        matchClass: classifySymbolMatch(query, symbol.name),
        file,
        symbol,
      })),
    ).filter((candidate) => candidate.matchClass.score > 0);

    candidates.sort((left, right) => {
      if (right.matchClass.score !== left.matchClass.score) {
        return right.matchClass.score - left.matchClass.score;
      }
      if (left.matchClass.rank !== right.matchClass.rank) {
        return left.matchClass.rank - right.matchClass.rank;
      }
      if (analysisQualityRank(right.file.analysisQuality) !== analysisQualityRank(left.file.analysisQuality)) {
        return analysisQualityRank(right.file.analysisQuality) - analysisQualityRank(left.file.analysisQuality);
      }
      if (left.file.repoRelativePath !== right.file.repoRelativePath) {
        return left.file.repoRelativePath.localeCompare(right.file.repoRelativePath);
      }
      if (left.symbol.startLine !== right.symbol.startLine) {
        return left.symbol.startLine - right.symbol.startLine;
      }
      return left.symbol.name.localeCompare(right.symbol.name);
    });

    const totalCount = candidates.length;
    const matches = candidates.slice(0, requestedLimit).map<SymbolLookupMatch>(({ matchClass, file, symbol }) => ({
      symbol: symbol.name,
      kind: symbol.kind,
      path: file.repoRelativePath,
      range: { startLine: symbol.startLine, endLine: symbol.endLine },
      summary: summarizeSymbol(file, symbol.name, symbol.kind),
      reason: matchClass.reason,
      suggestedNextRead: buildSymbolSuggestedReads(file),
      ...createQueryMetadata(status, file.analysisQuality),
    }));

    return {
      query,
      matches,
      truncated: totalCount > requestedLimit,
      returnedCount: matches.length,
      totalCount,
      ...createQueryMetadata(status, pickAggregateQuality(matches.map((match) => match.analysisQuality))),
    };
  }

  async fileSummary(params: FileSummaryParams): Promise<FileSummaryResponse> {
    const status = await this.assertHealthyRepo(params.repo);
    const files = this.readMergedIndexedFiles(status);
    const normalizedPath = normalizeRequestedRepoPath(status.repoRoot, params.path);
    const file = files.find((entry) => entry.repoRelativePath === normalizedPath);

    if (!file) {
      throw new RequestError("invalid_request", `No indexed file summary is available for ${params.path}.`);
    }

    const relatedCandidates = collectRelatedFiles(file)
      .sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
    const relatedFiles = relatedCandidates.slice(0, FILE_SUMMARY_RELATED_FILE_LIMIT);
    const mainExports = file.exports
      .map((entry) => ({ name: entry.exportedName, kind: entry.kind }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
    const importantRanges = file.symbols.length > 0
      ? file.symbols
          .map<QueryRange>((symbol) => ({ startLine: symbol.startLine, endLine: symbol.endLine }))
          .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
      : [{ startLine: 1, endLine: Math.max(1, Math.min(file.lineCount, 3)) }];

    return {
      path: file.repoRelativePath,
      summary: summarizeFile(file),
      mainExports,
      importantRanges,
      relatedFiles,
      relatedFilesTruncated: relatedCandidates.length > FILE_SUMMARY_RELATED_FILE_LIMIT,
      relatedFilesReturnedCount: relatedFiles.length,
      relatedFilesTotalCount: relatedCandidates.length,
      ...createQueryMetadata(status, file.analysisQuality),
    };
  }

  async impactAnalysis(params: ImpactAnalysisParams): Promise<ImpactAnalysisResponse> {
    const status = await this.assertHealthyRepo(params.repo);
    const files = this.readMergedIndexedFiles(status);
    const target = params.target.trim();
    const requestedLimit = clampPositiveInt(params.limit, IMPACT_ANALYSIS_AREA_LIMIT);
    const targetPath = tryNormalizeRequestedRepoPath(status.repoRoot, target);
    const normalizedTargetPath = targetPath ? files.find((file) => file.repoRelativePath === targetPath)?.repoRelativePath : null;

    const areaCandidates = new Map<string, ImpactArea & { score: number }>();
    const addArea = (candidate: ImpactArea & { score: number }) => {
      const key = `${candidate.path}:${candidate.range?.startLine ?? 0}:${candidate.reason}`;
      const existing = areaCandidates.get(key);
      if (!existing || candidate.score > existing.score) {
        areaCandidates.set(key, candidate);
      }
    };

    for (const file of files) {
      if (normalizedTargetPath && file.repoRelativePath === normalizedTargetPath) {
        addArea({
          path: file.repoRelativePath,
          reason: "Target path matches this indexed file.",
          summary: summarizeFile(file),
          analysisQuality: file.analysisQuality,
          freshness: freshnessFromStatus(status),
          coverage: status.coverage,
          provenance: "local",
          score: 5,
        });
      }

      for (const symbol of file.symbols) {
        const match = classifySymbolMatch(target, symbol.name);
        if (match.score === 0) {
          continue;
        }

        addArea({
          path: file.repoRelativePath,
          range: { startLine: symbol.startLine, endLine: symbol.endLine },
          reason: `Symbol ${symbol.name} ${match.reason.toLowerCase()}`,
          summary: summarizeSymbol(file, symbol.name, symbol.kind),
          analysisQuality: file.analysisQuality,
          freshness: freshnessFromStatus(status),
          coverage: status.coverage,
          provenance: "local",
          score: 10 + match.score,
        });
      }

      const importsTarget = normalizedTargetPath
        ? file.imports.some((entry) => resolveModulePath(file.repoRelativePath, entry.moduleSpecifier) === normalizedTargetPath)
        : false;
      if (importsTarget) {
        addArea({
          path: file.repoRelativePath,
          reason: `Imports ${normalizedTargetPath}.`,
          summary: summarizeFile(file),
          analysisQuality: file.analysisQuality,
          freshness: freshnessFromStatus(status),
          coverage: status.coverage,
          provenance: "local",
          score: 7,
        });
      }

      const referencesTarget = file.references.some((entry) => entry.name.toLowerCase() === target.toLowerCase());
      if (referencesTarget) {
        addArea({
          path: file.repoRelativePath,
          reason: `Contains references to ${target}.`,
          summary: summarizeFile(file),
          analysisQuality: file.analysisQuality,
          freshness: freshnessFromStatus(status),
          coverage: status.coverage,
          provenance: "local",
          score: 6,
        });
      }
    }

    const sortedAreas = [...areaCandidates.values()]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (analysisQualityRank(right.analysisQuality) !== analysisQualityRank(left.analysisQuality)) {
          return analysisQualityRank(right.analysisQuality) - analysisQualityRank(left.analysisQuality);
        }
        if (left.path !== right.path) {
          return left.path.localeCompare(right.path);
        }
        return (left.range?.startLine ?? 0) - (right.range?.startLine ?? 0);
      })
      .map(({ score: _score, ...area }) => area);

    const areas = sortedAreas.slice(0, requestedLimit);
    const suggestedReadsAll = dedupeStrings(areas.map((area) => area.path));
    const suggestedNextRead = suggestedReadsAll.slice(0, IMPACT_ANALYSIS_SUGGESTED_READ_LIMIT);
    const quality = pickAggregateQuality(areas.map((area) => area.analysisQuality));

    return {
      target,
      areas,
      reason: buildImpactReason(target, normalizedTargetPath, areas.length),
      risk: classifyImpactRisk(areas.length, quality),
      suggestedNextRead,
      areasTruncated: sortedAreas.length > requestedLimit,
      areasReturnedCount: areas.length,
      areasTotalCount: sortedAreas.length,
      suggestedNextReadTruncated: suggestedReadsAll.length > IMPACT_ANALYSIS_SUGGESTED_READ_LIMIT,
      suggestedNextReadReturnedCount: suggestedNextRead.length,
      suggestedNextReadTotalCount: suggestedReadsAll.length,
      ...createQueryMetadata(status, quality),
    };
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
      await this.syncRegistryFromRuntime(locator, refreshedRuntime);

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
      await this.syncRegistryFromRuntime(locator, refreshedRuntime);

      await this.refreshRuntimeProjection(refreshedRuntime, locator);
    } catch (error) {
      runtime.markError(error instanceof Error ? error.message : String(error));
      await this.syncRegistryFromRuntime(locator, runtime);
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
      await this.syncRegistryFromRuntime(locator, currentRuntime);
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
      await this.syncRegistryFromRuntime(locator, currentRuntime);
      return;
    }

    if (job?.active || job?.queued) {
      currentRuntime.markIndexing(currentDirty.files.length);
      await this.syncRegistryFromRuntime(locator, currentRuntime);
      return;
    }

    if (currentRuntime.lastError) {
      currentRuntime.state = "error";
      await this.syncRegistryFromRuntime(locator, currentRuntime);
      return;
    }

    const snapshotMatches = currentDirty.signature === (overlaySnapshot.dirtySignature ?? "");
    if (currentRuntime.lastSuccessfulIndexAt && snapshotMatches) {
      currentRuntime.state = "ready";
      currentRuntime.filesPending = 0;
      await this.syncRegistryFromRuntime(locator, currentRuntime);
      return;
    }

    if (currentRuntime.lastSuccessfulIndexAt && currentDirty.files.length > 0 && currentDirty.oldestAgeMs >= STALE_SETTLE_MS) {
      currentRuntime.markStale(currentDirty.files.length);
      await this.syncRegistryFromRuntime(locator, currentRuntime);
      return;
    }

    if (!currentRuntime.lastSuccessfulIndexAt) {
      currentRuntime.state = "initializing";
      currentRuntime.filesPending = currentDirty.files.length;
      await this.syncRegistryFromRuntime(locator, currentRuntime);
      return;
    }

    currentRuntime.state = "ready";
    currentRuntime.filesPending = currentDirty.files.length;
    await this.syncRegistryFromRuntime(locator, currentRuntime);
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
      case "symbolLookup":
        return this.symbolLookup(this.assertSymbolLookupParams(params));
      case "fileSummary":
        return this.fileSummary(this.assertFileSummaryParams(params));
      case "impactAnalysis":
        return this.impactAnalysis(this.assertImpactAnalysisParams(params));
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

  private assertSymbolLookupParams(params: unknown): SymbolLookupParams {
    if (!params || typeof params !== "object") {
      throw new RequestError("invalid_request", "symbolLookup requires a repo locator and non-empty symbol.");
    }

    const candidate = params as Partial<SymbolLookupParams>;
    if (typeof candidate.symbol !== "string" || candidate.symbol.trim().length === 0) {
      throw new RequestError("invalid_request", "symbolLookup requires a non-empty `symbol` string.");
    }

    return {
      repo: this.assertRepoLocator(candidate.repo),
      symbol: candidate.symbol,
      limit: typeof candidate.limit === "number" ? candidate.limit : undefined,
    };
  }

  private assertFileSummaryParams(params: unknown): FileSummaryParams {
    if (!params || typeof params !== "object") {
      throw new RequestError("invalid_request", "fileSummary requires a repo locator and file path.");
    }

    const candidate = params as Partial<FileSummaryParams>;
    if (typeof candidate.path !== "string" || candidate.path.trim().length === 0) {
      throw new RequestError("invalid_request", "fileSummary requires a non-empty `path` string.");
    }

    return {
      repo: this.assertRepoLocator(candidate.repo),
      path: candidate.path,
    };
  }

  private assertImpactAnalysisParams(params: unknown): ImpactAnalysisParams {
    if (!params || typeof params !== "object") {
      throw new RequestError("invalid_request", "impactAnalysis requires a repo locator and non-empty target.");
    }

    const candidate = params as Partial<ImpactAnalysisParams>;
    if (typeof candidate.target !== "string" || candidate.target.trim().length === 0) {
      throw new RequestError("invalid_request", "impactAnalysis requires a non-empty `target` string.");
    }

    return {
      repo: this.assertRepoLocator(candidate.repo),
      target: candidate.target,
      limit: typeof candidate.limit === "number" ? candidate.limit : undefined,
    };
  }

  private async assertHealthyRepo(locator: RepoLocator): Promise<RepoStatus> {
    await this.openRepo(locator);
    const status = await this.getStatus(locator);
    if (!status.enabled || status.state === "disabled" || status.state === "error") {
      throw new RequestError(
        "repo_not_enabled",
        "The current working directory is not inside an enabled, healthy indexed repository. Run `/index enable`, or `/index doctor` if the repo is in error.",
      );
    }
    return status;
  }

  private readMergedIndexedFiles(status: RepoStatus): IndexedFileView[] {
    const merged = new Map<string, IndexedFileView>();
    for (const file of readIndexedFiles(status.baseline.dbPath)) {
      merged.set(file.repoRelativePath, file);
    }
    for (const file of readIndexedFiles(status.overlay.dbPath)) {
      merged.set(file.repoRelativePath, file);
    }
    return [...merged.values()].sort((left, right) => left.repoRelativePath.localeCompare(right.repoRelativePath));
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

  private async syncRegistryFromRuntime(locator: RepoLocator, runtime: RepoRuntime): Promise<void> {
    await this.registry.upsertFromLocator(locator);
    this.registry.updateLifecycle({
      worktreeId: runtime.worktreeId,
      repoId: runtime.repoId,
      headCommit: runtime.headCommit,
      enabled: runtime.enabled,
      state: runtime.enabled ? runtime.state : "disabled",
      lastSuccessfulIndexAt: runtime.lastSuccessfulIndexAt,
      lastError: runtime.lastError,
    });
  }

  private async ensureRuntime(locator: RepoLocator): Promise<RepoRuntime> {
    const persisted = await this.registry.upsertFromLocator(locator);
    const runtimeKey = createRepoRuntimeKey(locator);
    const anchors = await this.storeManager.ensureRepoStores(locator);
    const existing = this.runtimes.get(runtimeKey);

    if (existing) {
      existing.refresh(locator, anchors);
      existing.enabled = persisted.enabled;
      existing.restoreState(persisted.enabled ? persisted.state : "disabled", {
        lastSuccessfulIndexAt: persisted.lastSuccessfulIndexAt,
        lastError: persisted.lastError,
      });
      return existing;
    }

    const runtime = new RepoRuntime({
      repoId: persisted.repoId,
      repoName: locator.repoName,
      repoRoot: locator.repoRoot,
      gitDir: locator.gitDir,
      worktreeId: locator.worktreeId,
      headCommit: locator.headCommit,
      enabled: persisted.enabled,
      state: persisted.enabled ? persisted.state : "disabled",
      baseline: anchors.baseline,
      overlay: anchors.overlay,
      createdAt: persisted.createdAt,
      lastUpdated: persisted.lastUpdated,
      lastSuccessfulIndexAt: persisted.lastSuccessfulIndexAt,
      lastError: persisted.lastError,
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

function readIndexedFiles(dbPath: string): IndexedFileView[] {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });

  try {
    const files = new Map<string, IndexedFileView>();
    const fileRows = db.prepare("SELECT repo_relative_path, language, analysis_quality, line_count, summary_json FROM file_index ORDER BY repo_relative_path").all() as Array<{
      repo_relative_path: string;
      language: string;
      analysis_quality: AnalysisQuality;
      line_count: number;
      summary_json: string;
    }>;

    for (const row of fileRows) {
      files.set(row.repo_relative_path, {
        repoRelativePath: row.repo_relative_path,
        language: row.language,
        analysisQuality: row.analysis_quality,
        lineCount: row.line_count,
        summary: JSON.parse(row.summary_json) as IndexedFileView["summary"],
        symbols: [],
        imports: [],
        exports: [],
        references: [],
      });
    }

    const symbolRows = db.prepare("SELECT repo_relative_path, name, kind, start_line, end_line, exported FROM symbols ORDER BY repo_relative_path, start_line, name").all() as Array<{
      repo_relative_path: string;
      name: string;
      kind: string;
      start_line: number;
      end_line: number;
      exported: number;
    }>;
    for (const row of symbolRows) {
      files.get(row.repo_relative_path)?.symbols.push({
        name: row.name,
        kind: row.kind,
        startLine: row.start_line,
        endLine: row.end_line,
        exported: row.exported === 1,
      });
    }

    const importRows = db.prepare("SELECT repo_relative_path, module_specifier, imported_name, local_name, is_type_only FROM imports ORDER BY repo_relative_path, module_specifier, imported_name, local_name").all() as Array<{
      repo_relative_path: string;
      module_specifier: string;
      imported_name: string;
      local_name: string;
      is_type_only: number;
    }>;
    for (const row of importRows) {
      files.get(row.repo_relative_path)?.imports.push({
        moduleSpecifier: row.module_specifier,
        importedName: row.imported_name,
        localName: row.local_name,
        isTypeOnly: row.is_type_only === 1,
      });
    }

    const exportRows = db.prepare("SELECT repo_relative_path, exported_name, kind, module_specifier FROM exports ORDER BY repo_relative_path, exported_name, kind").all() as Array<{
      repo_relative_path: string;
      exported_name: string;
      kind: string;
      module_specifier: string | null;
    }>;
    for (const row of exportRows) {
      files.get(row.repo_relative_path)?.exports.push({
        exportedName: row.exported_name,
        kind: row.kind,
        moduleSpecifier: row.module_specifier ?? undefined,
      });
    }

    const referenceRows = db.prepare("SELECT repo_relative_path, name, line, column FROM references_idx ORDER BY repo_relative_path, line, column, name").all() as Array<{
      repo_relative_path: string;
      name: string;
      line: number;
      column: number;
    }>;
    for (const row of referenceRows) {
      files.get(row.repo_relative_path)?.references.push({
        name: row.name,
        line: row.line,
        column: row.column,
      });
    }

    return [...files.values()].sort((left, right) => left.repoRelativePath.localeCompare(right.repoRelativePath));
  } finally {
    db.close();
  }
}

function createQueryMetadata(status: RepoStatus, analysisQuality: AnalysisQuality): QueryMetadata {
  return {
    freshness: freshnessFromStatus(status),
    coverage: status.coverage,
    provenance: "local" satisfies ResultProvenance,
    analysisQuality,
  };
}

function freshnessFromStatus(status: RepoStatus): RepoFreshness {
  switch (status.state) {
    case "ready":
      return "current";
    case "stale":
      return "stale";
    case "error":
      return "error";
    default:
      return "not-yet-indexed";
  }
}

function analysisQualityRank(quality: AnalysisQuality): number {
  switch (quality) {
    case "semantic":
      return 3;
    case "structural":
      return 2;
    case "basic":
    default:
      return 1;
  }
}

function pickAggregateQuality(qualities: AnalysisQuality[]): AnalysisQuality {
  return qualities.sort((left, right) => analysisQualityRank(right) - analysisQualityRank(left))[0] ?? "basic";
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(value), fallback);
}

function classifySymbolMatch(query: string, symbol: string): { score: number; rank: number; reason: string } {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedSymbol = symbol.toLowerCase();

  if (normalizedQuery.length === 0) {
    return { score: 0, rank: 99, reason: "No symbol query was provided." };
  }
  if (normalizedSymbol === normalizedQuery) {
    return { score: 3, rank: 1, reason: `Matched symbol name exactly for ${symbol}.` };
  }
  if (normalizedSymbol.startsWith(normalizedQuery)) {
    return { score: 2, rank: 2, reason: `Matched symbol name prefix for ${symbol}.` };
  }
  if (normalizedSymbol.includes(normalizedQuery)) {
    return { score: 1, rank: 3, reason: `Matched symbol name substring for ${symbol}.` };
  }

  return { score: 0, rank: 99, reason: `No symbol match for ${symbol}.` };
}

function summarizeSymbol(file: IndexedFileView, symbol: string, kind: string): string {
  return `${kind} ${symbol} in ${file.repoRelativePath} (${file.language}, ${file.summary.lineCount} lines).`;
}

function buildSymbolSuggestedReads(file: IndexedFileView): string[] {
  const reads = [
    file.repoRelativePath,
    ...collectRelatedFiles(file).map((entry) => entry.path),
  ];
  return dedupeStrings(reads).slice(0, IMPACT_ANALYSIS_SUGGESTED_READ_LIMIT);
}

function summarizeFile(file: IndexedFileView): string {
  if (file.analysisQuality === "structural") {
    return `${file.language} file with ${file.symbols.length} symbols, ${file.imports.length} imports, and ${file.exports.length} exports. Preview: ${file.summary.preview || "n/a"}`;
  }

  return `${file.language} fallback summary (${file.summary.lineCount} lines). Preview: ${file.summary.preview || "n/a"}`;
}

function collectRelatedFiles(file: IndexedFileView): Array<{ path: string; reason: string }> {
  const related = new Map<string, { path: string; reason: string }>();
  for (const entry of file.imports) {
    const resolvedPath = resolveModulePath(file.repoRelativePath, entry.moduleSpecifier);
    if (!resolvedPath) {
      continue;
    }
    related.set(`${resolvedPath}:import`, { path: resolvedPath, reason: `Imports ${entry.moduleSpecifier}.` });
  }
  for (const entry of file.exports) {
    if (!entry.moduleSpecifier) {
      continue;
    }
    const resolvedPath = resolveModulePath(file.repoRelativePath, entry.moduleSpecifier);
    if (!resolvedPath) {
      continue;
    }
    related.set(`${resolvedPath}:export`, { path: resolvedPath, reason: `Re-exports ${entry.moduleSpecifier}.` });
  }
  return [...related.values()];
}

function resolveModulePath(fromRepoPath: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith(".")) {
    return null;
  }

  const baseDir = fromRepoPath.includes("/") ? fromRepoPath.slice(0, fromRepoPath.lastIndexOf("/")) : "";
  const segments = `${baseDir}/${moduleSpecifier}`.split("/");
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }

  const normalized = normalizedSegments.join("/");
  return /\.[a-z0-9]+$/i.test(normalized) ? normalized : `${normalized}.ts`;
}

function normalizeRequestedRepoPath(repoRoot: string, requestedPath: string): string {
  const normalized = tryNormalizeRequestedRepoPath(repoRoot, requestedPath);
  if (!normalized) {
    throw new RequestError("invalid_request", `Path ${requestedPath} is outside the repository boundary.`);
  }
  return normalized;
}

function tryNormalizeRequestedRepoPath(repoRoot: string, requestedPath: string): string | null {
  if (requestedPath.startsWith("/")) {
    return normalizeRepoRelative(repoRoot, requestedPath);
  }

  const sanitized = requestedPath.replace(/^\.\//, "");
  if (sanitized.startsWith("../")) {
    return null;
  }

  return sanitized.replace(/\\/g, "/");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function buildImpactReason(target: string, normalizedTargetPath: string | null, areaCount: number): string {
  if (normalizedTargetPath) {
    return `Impact analysis traced ${areaCount} indexed area(s) related to path ${normalizedTargetPath}.`;
  }
  return `Impact analysis traced ${areaCount} indexed area(s) related to symbol or target ${target}.`;
}

function classifyImpactRisk(areaCount: number, quality: AnalysisQuality): "low" | "medium" | "high" {
  if (areaCount >= 6 || quality === "basic") {
    return "high";
  }
  if (areaCount >= 3) {
    return "medium";
  }
  return "low";
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
