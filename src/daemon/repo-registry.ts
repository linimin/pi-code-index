import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createRepoId, type RepoIndexingState, type RepoLocator } from "../shared/protocol.ts";

export interface RepoRegistryOptions {
  cacheDir: string;
}

export interface PersistedRepoRecord {
  repoId: string;
  repoRoot: string;
  repoName: string;
  gitDir: string;
  worktreeId: string;
  headCommit: string | null;
  enabled: boolean;
  state: RepoIndexingState;
  createdAt: string;
  lastUpdated: string;
  lastOpenedAt?: string;
  lastEnabledAt?: string;
  lastDisabledAt?: string;
  lastSuccessfulIndexAt?: string;
  lastError?: string;
}

export class RepoRegistry {
  readonly dbPath: string;

  constructor(options: RepoRegistryOptions) {
    this.dbPath = join(options.cacheDir, "repo-registry.sqlite");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.dbPath), 0o700).catch(() => undefined);

    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_registry (
          repo_id TEXT NOT NULL,
          repo_root TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          git_dir TEXT NOT NULL,
          worktree_id TEXT NOT NULL PRIMARY KEY,
          head_commit TEXT,
          enabled INTEGER NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_updated TEXT NOT NULL,
          last_opened_at TEXT,
          last_enabled_at TEXT,
          last_disabled_at TEXT,
          last_successful_index_at TEXT,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_repo_registry_enabled ON repo_registry(enabled);
      `);
    } finally {
      db.close();
    }

    await chmod(this.dbPath, 0o600).catch(() => undefined);
  }

  async upsertFromLocator(locator: RepoLocator): Promise<PersistedRepoRecord> {
    const existing = this.getByWorktreeId(locator.worktreeId);
    const now = new Date().toISOString();
    const record: PersistedRepoRecord = {
      repoId: existing?.repoId ?? createRepoId(locator.repoRoot),
      repoRoot: locator.repoRoot,
      repoName: locator.repoName,
      gitDir: locator.gitDir,
      worktreeId: locator.worktreeId,
      headCommit: locator.headCommit,
      enabled: existing?.enabled ?? false,
      state: existing?.state ?? "disabled",
      createdAt: existing?.createdAt ?? now,
      lastUpdated: now,
      lastOpenedAt: now,
      lastEnabledAt: existing?.lastEnabledAt,
      lastDisabledAt: existing?.lastDisabledAt,
      lastSuccessfulIndexAt: existing?.lastSuccessfulIndexAt,
      lastError: existing?.lastError,
    };

    this.save(record);
    return this.getByWorktreeId(locator.worktreeId) ?? record;
  }

  getByWorktreeId(worktreeId: string): PersistedRepoRecord | null {
    const db = new DatabaseSync(this.dbPath, { open: true, readOnly: true });
    try {
      const row = db.prepare(`
        SELECT
          repo_id,
          repo_root,
          repo_name,
          git_dir,
          worktree_id,
          head_commit,
          enabled,
          state,
          created_at,
          last_updated,
          last_opened_at,
          last_enabled_at,
          last_disabled_at,
          last_successful_index_at,
          last_error
        FROM repo_registry
        WHERE worktree_id = ?
      `).get(worktreeId) as RegistryRow | undefined;
      return row ? mapRow(row) : null;
    } finally {
      db.close();
    }
  }

  async markEnabled(locator: RepoLocator, repoId: string): Promise<PersistedRepoRecord> {
    const existing = await this.upsertFromLocator(locator);
    const now = new Date().toISOString();
    this.save({
      ...existing,
      repoId,
      headCommit: locator.headCommit,
      enabled: true,
      state: existing.lastSuccessfulIndexAt ? existing.state : "initializing",
      lastEnabledAt: now,
      lastUpdated: now,
      lastError: undefined,
    });
    return this.getByWorktreeId(locator.worktreeId) ?? existing;
  }

  async markDisabled(locator: RepoLocator, repoId: string): Promise<PersistedRepoRecord> {
    const existing = await this.upsertFromLocator(locator);
    const now = new Date().toISOString();
    this.save({
      ...existing,
      repoId,
      headCommit: locator.headCommit,
      enabled: false,
      state: "disabled",
      lastDisabledAt: now,
      lastUpdated: now,
    });
    return this.getByWorktreeId(locator.worktreeId) ?? existing;
  }

  updateLifecycle(input: {
    worktreeId: string;
    repoId: string;
    headCommit: string | null;
    enabled: boolean;
    state: RepoIndexingState;
    lastSuccessfulIndexAt?: string;
    lastError?: string;
  }): PersistedRepoRecord | null {
    const existing = this.getByWorktreeId(input.worktreeId);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    this.save({
      ...existing,
      repoId: input.repoId,
      headCommit: input.headCommit,
      enabled: input.enabled,
      state: input.state,
      lastSuccessfulIndexAt: input.lastSuccessfulIndexAt ?? existing.lastSuccessfulIndexAt,
      lastError: input.lastError,
      lastUpdated: now,
    });

    return this.getByWorktreeId(input.worktreeId);
  }

  listEnabled(): PersistedRepoRecord[] {
    return this.listWhere("WHERE enabled = 1");
  }

  listAll(): PersistedRepoRecord[] {
    return this.listWhere("");
  }

  private listWhere(whereClause: string): PersistedRepoRecord[] {
    const db = new DatabaseSync(this.dbPath, { open: true, readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT
          repo_id,
          repo_root,
          repo_name,
          git_dir,
          worktree_id,
          head_commit,
          enabled,
          state,
          created_at,
          last_updated,
          last_opened_at,
          last_enabled_at,
          last_disabled_at,
          last_successful_index_at,
          last_error
        FROM repo_registry
        ${whereClause}
        ORDER BY repo_root, worktree_id
      `).all() as RegistryRow[];
      return rows.map(mapRow);
    } finally {
      db.close();
    }
  }

  private save(record: PersistedRepoRecord): void {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_registry (
          repo_id TEXT NOT NULL,
          repo_root TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          git_dir TEXT NOT NULL,
          worktree_id TEXT NOT NULL PRIMARY KEY,
          head_commit TEXT,
          enabled INTEGER NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_updated TEXT NOT NULL,
          last_opened_at TEXT,
          last_enabled_at TEXT,
          last_disabled_at TEXT,
          last_successful_index_at TEXT,
          last_error TEXT
        );
      `);
      db.prepare(`
        INSERT INTO repo_registry (
          repo_id,
          repo_root,
          repo_name,
          git_dir,
          worktree_id,
          head_commit,
          enabled,
          state,
          created_at,
          last_updated,
          last_opened_at,
          last_enabled_at,
          last_disabled_at,
          last_successful_index_at,
          last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_id) DO UPDATE SET
          repo_id = excluded.repo_id,
          repo_root = excluded.repo_root,
          repo_name = excluded.repo_name,
          git_dir = excluded.git_dir,
          head_commit = excluded.head_commit,
          enabled = excluded.enabled,
          state = excluded.state,
          last_updated = excluded.last_updated,
          last_opened_at = excluded.last_opened_at,
          last_enabled_at = excluded.last_enabled_at,
          last_disabled_at = excluded.last_disabled_at,
          last_successful_index_at = excluded.last_successful_index_at,
          last_error = excluded.last_error
      `).run(
        record.repoId,
        record.repoRoot,
        record.repoName,
        record.gitDir,
        record.worktreeId,
        record.headCommit,
        record.enabled ? 1 : 0,
        record.state,
        record.createdAt,
        record.lastUpdated,
        record.lastOpenedAt ?? null,
        record.lastEnabledAt ?? null,
        record.lastDisabledAt ?? null,
        record.lastSuccessfulIndexAt ?? null,
        record.lastError ?? null,
      );
    } finally {
      db.close();
    }
  }
}

interface RegistryRow {
  repo_id: string;
  repo_root: string;
  repo_name: string;
  git_dir: string;
  worktree_id: string;
  head_commit: string | null;
  enabled: number;
  state: RepoIndexingState;
  created_at: string;
  last_updated: string;
  last_opened_at: string | null;
  last_enabled_at: string | null;
  last_disabled_at: string | null;
  last_successful_index_at: string | null;
  last_error: string | null;
}

function mapRow(row: RegistryRow): PersistedRepoRecord {
  return {
    repoId: row.repo_id,
    repoRoot: row.repo_root,
    repoName: row.repo_name,
    gitDir: row.git_dir,
    worktreeId: row.worktree_id,
    headCommit: row.head_commit,
    enabled: row.enabled === 1,
    state: row.state,
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
    lastOpenedAt: row.last_opened_at ?? undefined,
    lastEnabledAt: row.last_enabled_at ?? undefined,
    lastDisabledAt: row.last_disabled_at ?? undefined,
    lastSuccessfulIndexAt: row.last_successful_index_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}
