import { homedir } from "node:os";
import { join } from "node:path";

import type { HealthResponse, RepoDiagnostics, RepoStatus } from "../shared/protocol";

export interface DaemonClientOptions {
  socketPath?: string;
}

export function defaultSocketPath(): string {
  return join(homedir(), ".cache", "pi-index", "daemon.sock");
}

export class DaemonClient {
  readonly socketPath: string;

  constructor(options: DaemonClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
  }

  async health(): Promise<HealthResponse> {
    throw new Error("DaemonClient.health() is not implemented yet.");
  }

  async getStatus(_repoRoot: string): Promise<RepoStatus> {
    throw new Error("DaemonClient.getStatus() is not implemented yet.");
  }

  async getRepoDiagnostics(_repoRoot: string): Promise<RepoDiagnostics> {
    throw new Error("DaemonClient.getRepoDiagnostics() is not implemented yet.");
  }
}
