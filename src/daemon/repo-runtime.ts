import type { RepoIndexingState } from "../shared/protocol";

export interface RepoRuntimeDescriptor {
  repoRoot: string;
  worktreeId: string;
  state: RepoIndexingState;
}

export class RepoRuntime {
  readonly repoRoot: string;
  readonly worktreeId: string;
  state: RepoIndexingState;

  constructor(descriptor: RepoRuntimeDescriptor) {
    this.repoRoot = descriptor.repoRoot;
    this.worktreeId = descriptor.worktreeId;
    this.state = descriptor.state;
  }
}
