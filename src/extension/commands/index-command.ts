import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  DaemonClient,
  DaemonRemoteError,
  ProtocolMismatchError,
  RepoContextError,
  UnsupportedPlatformError,
  resolveRepoLocator,
} from "../daemon-client.ts";
import type { RepoDiagnostics, RepoStatus } from "../../shared/protocol.ts";

type IndexSubcommand =
  | "help"
  | "enable"
  | "disable"
  | "status"
  | "reindex"
  | "doctor";

export interface DaemonClientLike {
  openRepo(locator: Parameters<DaemonClient["openRepo"]>[0]): ReturnType<DaemonClient["openRepo"]>;
  enableRepoIndexing(
    locator: Parameters<DaemonClient["enableRepoIndexing"]>[0],
  ): ReturnType<DaemonClient["enableRepoIndexing"]>;
  disableRepoIndexing(
    locator: Parameters<DaemonClient["disableRepoIndexing"]>[0],
  ): ReturnType<DaemonClient["disableRepoIndexing"]>;
  getStatus(locator: Parameters<DaemonClient["getStatus"]>[0]): ReturnType<DaemonClient["getStatus"]>;
  getRepoDiagnostics(
    locator: Parameters<DaemonClient["getRepoDiagnostics"]>[0],
  ): ReturnType<DaemonClient["getRepoDiagnostics"]>;
  reindexRepo(locator: Parameters<DaemonClient["reindexRepo"]>[0]): ReturnType<DaemonClient["reindexRepo"]>;
}

export interface IndexCommandDeps {
  createClient: () => DaemonClientLike;
  resolveRepo: typeof resolveRepoLocator;
}

const SUBCOMMANDS: readonly string[] = [
  "enable",
  "disable",
  "status",
  "reindex",
  "doctor",
  "help",
];

function parseIndexSubcommand(rawArgs: string | undefined): IndexSubcommand {
  const firstToken = rawArgs?.trim().split(/\s+/, 1)[0]?.toLowerCase();

  switch (firstToken) {
    case undefined:
    case "":
      return "status";
    case "enable":
    case "on":
      return "enable";
    case "disable":
    case "off":
      return "disable";
    case "status":
      return "status";
    case "reindex":
      return "reindex";
    case "doctor":
      return "doctor";
    case "help":
      return "help";
    default:
      return "help";
  }
}

function defaultDeps(): IndexCommandDeps {
  return {
    createClient: () => new DaemonClient(),
    resolveRepo: resolveRepoLocator,
  };
}

export function createIndexCommandHandler(overrides: Partial<IndexCommandDeps> = {}) {
  const deps: IndexCommandDeps = {
    ...defaultDeps(),
    ...overrides,
  };

  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const subcommand = parseIndexSubcommand(args);

    try {
      switch (subcommand) {
        case "help":
          emit(ctx, buildHelpMessage(), "info");
          return;
        case "enable": {
          const repo = await deps.resolveRepo(ctx.cwd);
          const client = deps.createClient();
          await client.openRepo(repo);
          const status = await client.enableRepoIndexing(repo);
          emit(ctx, formatEnableMessage(status), "info");
          return;
        }
        case "disable": {
          const repo = await deps.resolveRepo(ctx.cwd);
          const client = deps.createClient();
          await client.openRepo(repo);
          const status = await client.disableRepoIndexing(repo);
          emit(ctx, formatDisableMessage(status), "info");
          return;
        }
        case "reindex": {
          const repo = await deps.resolveRepo(ctx.cwd);
          const client = deps.createClient();
          await client.openRepo(repo);
          const status = await client.reindexRepo(repo);
          emit(ctx, formatReindexMessage(status), "info");
          return;
        }
        case "doctor": {
          const repo = await deps.resolveRepo(ctx.cwd);
          const client = deps.createClient();
          await client.openRepo(repo);
          const diagnostics = await client.getRepoDiagnostics(repo);
          emit(ctx, formatDoctorMessage(diagnostics), "info");
          return;
        }
        case "status":
        default: {
          const repo = await deps.resolveRepo(ctx.cwd);
          const client = deps.createClient();
          await client.openRepo(repo);
          const status = await client.getStatus(repo);
          emit(ctx, formatStatusMessage(status), "info");
          return;
        }
      }
    } catch (error) {
      emit(ctx, formatErrorMessage(error), "error");
    }
  };
}

function buildHelpMessage(): string {
  return [
    "pi-code-index commands",
    "- /index",
    "- /index enable",
    "- /index disable",
    "- /index status",
    "- /index reindex",
    "- /index doctor",
  ].join("\n");
}

function formatEnableMessage(status: RepoStatus): string {
  return [
    `pi-code-index enabled for ${status.repoName}`,
    `Repo root: ${status.repoRoot}`,
    `Worktree ID: ${status.worktreeId}`,
    `State: ${status.state}`,
    `Daemon: ${status.transport} (protocol ${status.protocolVersion}, version ${status.daemonVersion})`,
    `Baseline DB: ${status.baseline.dbPath}`,
    `Overlay DB: ${status.overlay.dbPath}`,
    `Next: ${status.recommendedAction}`,
  ].join("\n");
}

function formatDisableMessage(status: RepoStatus): string {
  return [
    `pi-code-index disabled for ${status.repoName}`,
    `Repo root: ${status.repoRoot}`,
    `State: ${status.state}`,
    `Cache preserved: yes`,
    `Baseline DB: ${status.baseline.dbPath}`,
    `Overlay DB: ${status.overlay.dbPath}`,
  ].join("\n");
}

function formatReindexMessage(status: RepoStatus): string {
  return [
    `pi-code-index reindex requested for ${status.repoName}`,
    `Repo root: ${status.repoRoot}`,
    `State: ${status.state}`,
    `Recommended action: ${status.recommendedAction}`,
  ].join("\n");
}

function formatStatusMessage(status: RepoStatus): string {
  return [
    "pi-code-index status",
    `Repo: ${status.repoName}`,
    `Root: ${status.repoRoot}`,
    `Worktree ID: ${status.worktreeId}`,
    `Enabled: ${status.enabled ? "yes" : "no"}`,
    `State: ${status.state}`,
    `Mode: ${status.mode}`,
    `Indexed files: ${status.indexedFiles}`,
    `Pending files: ${status.filesPending}`,
    `Coverage: ${formatCoverage(status.coverage)}`,
    `HEAD baseline: ${status.headCommit ?? "unborn HEAD"}`,
    `Baseline DB: ${status.baseline.dbPath}`,
    `Overlay DB: ${status.overlay.dbPath}`,
    `Last updated: ${status.lastUpdated}`,
    `Transport: ${status.transport}`,
    `Protocol: ${status.protocolVersion}`,
    `Action: ${status.recommendedAction}`,
    ...(status.lastError ? [`Last error: ${status.lastError}`] : []),
  ].join("\n");
}

function formatDoctorMessage(diagnostics: RepoDiagnostics): string {
  return [
    "pi-code-index doctor",
    `Daemon running: yes`,
    `Daemon version: ${diagnostics.daemonVersion}`,
    `Protocol version: ${diagnostics.protocolVersion}`,
    `Transport: ${diagnostics.transport}`,
    `Daemon PID: ${diagnostics.pid}`,
    `Daemon started: ${diagnostics.startedAt}`,
    `Repo ID: ${diagnostics.repoId}`,
    `Repo root: ${diagnostics.repoRoot}`,
    `Git dir: ${diagnostics.repoIdentity.gitDir}`,
    `Worktree ID: ${diagnostics.worktreeId}`,
    `State: ${diagnostics.state}`,
    `Freshness: ${diagnostics.freshness}`,
    `Coverage: ${formatCoverage(diagnostics.coverage)}`,
    `Analyzers: ${formatAnalyzerCapabilities(diagnostics.analyzerCapabilities)}`,
    `Queue depth: ${diagnostics.queueDepth}`,
    `Active jobs: ${diagnostics.activeJobs.length > 0 ? diagnostics.activeJobs.join(", ") : "none"}`,
    `Baseline DB: ${diagnostics.baseline.dbPath}`,
    `Overlay DB: ${diagnostics.overlay.dbPath}`,
    `Storage usage: baselines=${diagnostics.storageSummary.baselineCount}, overlayBytes=${diagnostics.storageSummary.overlayBytes}, totalBytes=${diagnostics.storageSummary.totalBytes}`,
    `Recommended action: ${diagnostics.recommendedAction}`,
    ...(diagnostics.lastError ? [`Last error: ${diagnostics.lastError}`] : []),
    ...(diagnostics.actionableErrors.length > 0
      ? [`Actionable errors: ${diagnostics.actionableErrors.join(" | ")}`]
      : []),
  ].join("\n");
}

function formatCoverage(coverage: RepoStatus["coverage"]): string {
  return `${coverage.indexedFiles}/${coverage.eligibleFiles} (${coverage.indexedPercent}%)`;
}

function formatAnalyzerCapabilities(analyzers: RepoDiagnostics["analyzerCapabilities"]): string {
  return Object.entries(analyzers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, quality]) => `${name}=${quality}`)
    .join(", ");
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof RepoContextError) {
    return error.message;
  }

  if (error instanceof UnsupportedPlatformError) {
    return error.message;
  }

  if (error instanceof ProtocolMismatchError) {
    return error.message;
  }

  if (error instanceof DaemonRemoteError) {
    return `Daemon error (${error.remote.code}): ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function emit(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  message: string,
  level: "info" | "warn" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(message);
}

export function registerIndexCommand(pi: ExtensionAPI, deps: Partial<IndexCommandDeps> = {}): void {
  pi.registerCommand("index", {
    description: "Manage background indexing for the current repository",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const matches = SUBCOMMANDS.filter((candidate) => candidate.startsWith(normalizedPrefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: createIndexCommandHandler(deps),
  });
}
