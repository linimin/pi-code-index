import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  INDEXER_LANGUAGE_ADAPTER_SET,
  SQLITE_SCHEMA_VERSION,
  baselineKeyForHead,
  createRepoId,
  type RepoLocator,
  type StoreAnchor,
  type StoreMetadata,
} from "../shared/protocol.ts";

export interface RepoStoreAnchorSet {
  repoId: string;
  repoDir: string;
  baselinesDir: string;
  overlaysDir: string;
  baseline: StoreAnchor;
  overlay: StoreAnchor;
}

export interface StorageSummary {
  baselineCount: number;
  overlayBytes: number;
  totalBytes: number;
}

export interface SqliteStoreManagerOptions {
  cacheDir: string;
  indexerVersion: string;
  schemaVersion?: number;
  languageAdapterSet?: string[];
}

interface EnsureAnchorInput {
  kind: "baseline" | "overlay";
  dbPath: string;
  repoId: string;
  repoRoot: string;
  repoName: string;
  headCommit: string | null;
  worktreeId: string;
}

const METADATA_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export class SqliteStoreManager {
  private readonly repoCacheRoot: string;
  private readonly indexerVersion: string;
  private readonly schemaVersion: number;
  private readonly languageAdapterSet: string[];

  constructor(options: SqliteStoreManagerOptions) {
    this.repoCacheRoot = join(options.cacheDir, "repos");
    this.indexerVersion = options.indexerVersion;
    this.schemaVersion = options.schemaVersion ?? SQLITE_SCHEMA_VERSION;
    this.languageAdapterSet = options.languageAdapterSet ?? [...INDEXER_LANGUAGE_ADAPTER_SET];
  }

  async ensureRepoStores(locator: RepoLocator): Promise<RepoStoreAnchorSet> {
    const repoId = createRepoId(locator.repoRoot);
    const repoDir = join(this.repoCacheRoot, repoId);
    const baselinesDir = join(repoDir, "baselines");
    const overlaysDir = join(repoDir, "overlays");
    const baselinePath = join(baselinesDir, `${baselineKeyForHead(locator.headCommit)}.sqlite`);
    const overlayPath = join(overlaysDir, `${locator.worktreeId}.sqlite`);

    await Promise.all([
      this.ensurePrivateDir(repoDir),
      this.ensurePrivateDir(baselinesDir),
      this.ensurePrivateDir(overlaysDir),
    ]);

    await Promise.all([
      this.ensureAnchor({
        kind: "baseline",
        dbPath: baselinePath,
        repoId,
        repoRoot: locator.repoRoot,
        repoName: locator.repoName,
        headCommit: locator.headCommit,
        worktreeId: locator.worktreeId,
      }),
      this.ensureAnchor({
        kind: "overlay",
        dbPath: overlayPath,
        repoId,
        repoRoot: locator.repoRoot,
        repoName: locator.repoName,
        headCommit: locator.headCommit,
        worktreeId: locator.worktreeId,
      }),
    ]);

    const [baseline, overlay] = await Promise.all([
      this.readAnchor("baseline", baselinePath, locator.headCommit, locator.worktreeId),
      this.readAnchor("overlay", overlayPath, locator.headCommit, locator.worktreeId),
    ]);

    return {
      repoId,
      repoDir,
      baselinesDir,
      overlaysDir,
      baseline,
      overlay,
    };
  }

  async getStorageSummary(repoId: string, overlay: StoreAnchor): Promise<StorageSummary> {
    const baselinesDir = join(this.repoCacheRoot, repoId, "baselines");
    const entries = await readdir(baselinesDir, { withFileTypes: true }).catch(() => []);
    const baselineCount = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite")).length;
    const overlayBytes = overlay.bytes;

    let baselineBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".sqlite")) {
        continue;
      }

      const entryPath = join(baselinesDir, entry.name);
      const entryStat = await stat(entryPath).catch(() => null);
      baselineBytes += entryStat?.size ?? 0;
    }

    return {
      baselineCount,
      overlayBytes,
      totalBytes: baselineBytes + overlayBytes,
    };
  }

  private async ensureAnchor(input: EnsureAnchorInput): Promise<void> {
    await this.ensurePrivateDir(dirname(input.dbPath));

    const db = new DatabaseSync(input.dbPath);

    try {
      db.exec(METADATA_TABLE_SQL);

      const insertOrReplace = db.prepare(
        `
          INSERT INTO metadata (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        `,
      );
      const insertOrIgnore = db.prepare(
        `
          INSERT OR IGNORE INTO metadata (key, value)
          VALUES (?, ?);
        `,
      );

      insertOrReplace.run("schemaVersion", String(this.schemaVersion));
      insertOrReplace.run("indexerVersion", this.indexerVersion);
      insertOrReplace.run("languageAdapterSet", JSON.stringify(this.languageAdapterSet));
      insertOrIgnore.run("createdAt", new Date().toISOString());
      insertOrReplace.run("anchorKind", input.kind);
      insertOrReplace.run("repoId", input.repoId);
      insertOrReplace.run("repoRoot", input.repoRoot);
      insertOrReplace.run("repoName", input.repoName);
      insertOrReplace.run("headCommit", input.headCommit ?? "");
      insertOrReplace.run("worktreeId", input.worktreeId);
    } finally {
      db.close();
    }

    await chmod(input.dbPath, 0o600).catch(() => undefined);
  }

  private async readAnchor(
    kind: "baseline" | "overlay",
    dbPath: string,
    headCommit: string | null,
    worktreeId: string,
  ): Promise<StoreAnchor> {
    const metadata = this.readMetadata(dbPath);
    const anchorStat = await stat(dbPath).catch(() => null);

    return {
      kind,
      dbPath,
      exists: anchorStat !== null,
      bytes: anchorStat?.size ?? 0,
      metadata,
      headCommit,
      worktreeId,
    };
  }

  private readMetadata(dbPath: string): StoreMetadata {
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });

    try {
      db.exec(METADATA_TABLE_SQL);
      const rows = db.prepare(`SELECT key, value FROM metadata`).all() as Array<{ key: string; value: string }>;
      const values = new Map(rows.map((row) => [row.key, row.value]));

      return {
        schemaVersion: Number(values.get("schemaVersion") ?? this.schemaVersion),
        indexerVersion: values.get("indexerVersion") ?? this.indexerVersion,
        languageAdapterSet: JSON.parse(
          values.get("languageAdapterSet") ?? JSON.stringify(this.languageAdapterSet),
        ) as string[],
        createdAt: values.get("createdAt") ?? new Date(0).toISOString(),
      };
    } finally {
      db.close();
    }
  }

  private async ensurePrivateDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700).catch(() => undefined);
  }
}
