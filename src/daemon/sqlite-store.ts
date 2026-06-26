export interface BaselineStoreDescriptor {
  repoId: string;
  commitSha: string;
  dbPath: string;
}

export interface OverlayStoreDescriptor {
  repoId: string;
  worktreeId: string;
  dbPath: string;
}

export class SqliteStoreCatalog {
  readonly baselines = new Map<string, BaselineStoreDescriptor>();
  readonly overlays = new Map<string, OverlayStoreDescriptor>();
}
