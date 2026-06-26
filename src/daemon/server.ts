import { randomUUID } from "node:crypto";

import {
  DAEMON_PROTOCOL_VERSION,
  type HealthResponse,
  type RepoDiagnostics,
  type RepoStatus,
} from "../shared/protocol";

export interface DaemonServerOptions {
  socketPath: string;
  version?: string;
}

export interface DaemonServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): HealthResponse;
  getStatus(repoRoot: string): Promise<RepoStatus>;
  getRepoDiagnostics(repoRoot: string): Promise<RepoDiagnostics>;
}

class PlaceholderDaemonServer implements DaemonServer {
  private started = false;
  private readonly instanceId = randomUUID();
  private readonly version: string;

  constructor(private readonly options: DaemonServerOptions) {
    this.version = options.version ?? "0.1.0";
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  health(): HealthResponse {
    return {
      daemonVersion: this.version,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      pid: process.pid,
      capabilities: ["health"],
    };
  }

  async getStatus(repoRoot: string): Promise<RepoStatus> {
    return {
      repoRoot,
      state: this.started ? "disabled" : "error",
      filesPending: 0,
      overlayState: "not-implemented",
    };
  }

  async getRepoDiagnostics(repoRoot: string): Promise<RepoDiagnostics> {
    const status = await this.getStatus(repoRoot);

    return {
      ...status,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      transport: `unix://${this.options.socketPath}`,
      worktreeId: "not-implemented",
      analyzerCapabilities: {},
      queueDepth: 0,
      activeJobs: [],
      storageSummary: {
        baselineCount: 0,
        overlayBytes: 0,
        totalBytes: 0,
      },
      recommendedAction: "Implement daemon transport, repo registration, and indexing.",
    };
  }
}

export async function createDaemonServer(
  options: DaemonServerOptions,
): Promise<DaemonServer> {
  return new PlaceholderDaemonServer(options);
}
