import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  INDEXER_LANGUAGE_ADAPTER_SET,
  SQLITE_SCHEMA_VERSION,
  baselineKeyForHead,
  createRepoId,
  type AnalysisQuality,
  type RepoLocator,
  type StoreAnchor,
  type StoreMetadata,
} from "../shared/protocol.ts";
import type {
  TsJsAnalysis,
  TsJsExportFact,
  TsJsImportFact,
  TsJsReferenceFact,
  TsJsSymbolFact,
} from "./tsjs-analyzer.ts";

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

export interface BasicFileSummary {
  lineCount: number;
  byteCount: number;
  preview: string;
}

export interface FileAnalysisRecord {
  repoRelativePath: string;
  language: string;
  analysisQuality: AnalysisQuality;
  contentHash: string;
  byteCount: number;
  lineCount: number;
  summary: BasicFileSummary;
  symbols: TsJsSymbolFact[];
  imports: TsJsImportFact[];
  exports: TsJsExportFact[];
  references: TsJsReferenceFact[];
}

export interface OmittedFileRecord {
  repoRelativePath: string;
  reason: string;
}

export interface IndexPersistInput {
  anchor: StoreAnchor;
  repoId: string;
  headCommit: string | null;
  worktreeId: string;
  indexedFiles: FileAnalysisRecord[];
  omittedFiles: OmittedFileRecord[];
  pendingFiles: string[];
  indexedAt: string;
  dirtySignature: string;
}

export interface StoreIndexSnapshot {
  indexedFiles: number;
  omittedFiles: number;
  eligibleFiles: number;
  pendingFiles: number;
  lastIndexedAt?: string;
  dirtySignature?: string;
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

const FILE_INDEX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS file_index (
    repo_relative_path TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    analysis_quality TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    line_count INTEGER NOT NULL,
    summary_json TEXT NOT NULL
  );
`;

const OMITTED_FILES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS omitted_files (
    repo_relative_path TEXT PRIMARY KEY,
    reason TEXT NOT NULL
  );
`;

const SYMBOLS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS symbols (
    repo_relative_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    exported INTEGER NOT NULL
  );
`;

const IMPORTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS imports (
    repo_relative_path TEXT NOT NULL,
    module_specifier TEXT NOT NULL,
    imported_name TEXT NOT NULL,
    local_name TEXT NOT NULL,
    is_type_only INTEGER NOT NULL
  );
`;

const EXPORTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS exports (
    repo_relative_path TEXT NOT NULL,
    exported_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    module_specifier TEXT
  );
`;

const REFERENCES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS references_idx (
    repo_relative_path TEXT NOT NULL,
    name TEXT NOT NULL,
    line INTEGER NOT NULL,
    column INTEGER NOT NULL
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

  async replaceBaselineIndex(input: IndexPersistInput): Promise<StoreAnchor> {
    return this.replaceIndexedContent(input);
  }

  async replaceOverlayIndex(input: IndexPersistInput): Promise<StoreAnchor> {
    return this.replaceIndexedContent(input);
  }

  async readSnapshot(anchor: StoreAnchor): Promise<StoreIndexSnapshot> {
    const db = new DatabaseSync(anchor.dbPath, { open: true, readOnly: true });
    try {
      this.execSchema(db);
      const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count);
      const metadata = this.readMetadataMap(db);
      return {
        indexedFiles: count("file_index"),
        omittedFiles: count("omitted_files"),
        eligibleFiles: Number(metadata.get("eligibleFiles") ?? 0),
        pendingFiles: Number(metadata.get("pendingFiles") ?? 0),
        lastIndexedAt: metadata.get("lastIndexedAt") || undefined,
        dirtySignature: metadata.get("dirtySignature") || undefined,
      };
    } finally {
      db.close();
    }
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

  createFallbackRecord(repoRelativePath: string, content: string): FileAnalysisRecord {
    const summary = createBasicSummary(content);
    return {
      repoRelativePath,
      language: detectBasicLanguage(repoRelativePath),
      analysisQuality: "basic",
      contentHash: createContentHash(content),
      byteCount: Buffer.byteLength(content),
      lineCount: summary.lineCount,
      summary,
      symbols: [],
      imports: [],
      exports: [],
      references: [],
    };
  }

  createStructuralRecord(repoRelativePath: string, content: string, analysis: TsJsAnalysis): FileAnalysisRecord {
    return {
      repoRelativePath,
      language: analysis.language,
      analysisQuality: analysis.analysisQuality,
      contentHash: createContentHash(content),
      byteCount: Buffer.byteLength(content),
      lineCount: analysis.summary.lineCount,
      summary: {
        lineCount: analysis.summary.lineCount,
        byteCount: Buffer.byteLength(content),
        preview: createPreview(content),
      },
      symbols: analysis.symbols,
      imports: analysis.imports,
      exports: analysis.exports,
      references: analysis.references,
    };
  }

  private async replaceIndexedContent(input: IndexPersistInput): Promise<StoreAnchor> {
    const db = new DatabaseSync(input.anchor.dbPath);
    try {
      this.execSchema(db);
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.exec("DELETE FROM file_index");
        db.exec("DELETE FROM omitted_files");
        db.exec("DELETE FROM symbols");
        db.exec("DELETE FROM imports");
        db.exec("DELETE FROM exports");
        db.exec("DELETE FROM references_idx");

        const insertFile = db.prepare(
          `
            INSERT INTO file_index (
              repo_relative_path,
              language,
              analysis_quality,
              content_hash,
              byte_count,
              line_count,
              summary_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        );
        const insertOmitted = db.prepare(
          `INSERT INTO omitted_files (repo_relative_path, reason) VALUES (?, ?)`,
        );
        const insertSymbol = db.prepare(
          `INSERT INTO symbols (repo_relative_path, name, kind, start_line, end_line, exported) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const insertImport = db.prepare(
          `INSERT INTO imports (repo_relative_path, module_specifier, imported_name, local_name, is_type_only) VALUES (?, ?, ?, ?, ?)`,
        );
        const insertExport = db.prepare(
          `INSERT INTO exports (repo_relative_path, exported_name, kind, module_specifier) VALUES (?, ?, ?, ?)`,
        );
        const insertReference = db.prepare(
          `INSERT INTO references_idx (repo_relative_path, name, line, column) VALUES (?, ?, ?, ?)`,
        );
        const insertOrReplace = db.prepare(
          `
            INSERT INTO metadata (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `,
        );

        for (const file of input.indexedFiles) {
          insertFile.run(
            file.repoRelativePath,
            file.language,
            file.analysisQuality,
            file.contentHash,
            file.byteCount,
            file.lineCount,
            JSON.stringify(file.summary),
          );

          for (const symbol of file.symbols) {
            insertSymbol.run(
              file.repoRelativePath,
              symbol.name,
              symbol.kind,
              symbol.startLine,
              symbol.endLine,
              symbol.exported ? 1 : 0,
            );
          }

          for (const entry of file.imports) {
            insertImport.run(
              file.repoRelativePath,
              entry.moduleSpecifier,
              entry.importedName,
              entry.localName,
              entry.isTypeOnly ? 1 : 0,
            );
          }

          for (const entry of file.exports) {
            insertExport.run(
              file.repoRelativePath,
              entry.exportedName,
              entry.kind,
              entry.moduleSpecifier ?? null,
            );
          }

          for (const entry of file.references) {
            insertReference.run(file.repoRelativePath, entry.name, entry.line, entry.column);
          }
        }

        for (const omitted of input.omittedFiles) {
          insertOmitted.run(omitted.repoRelativePath, omitted.reason);
        }

        const eligibleFiles = input.indexedFiles.length + input.omittedFiles.length;
        insertOrReplace.run("headCommit", input.headCommit ?? "");
        insertOrReplace.run("worktreeId", input.worktreeId);
        insertOrReplace.run("lastIndexedAt", input.indexedAt);
        insertOrReplace.run("dirtySignature", input.dirtySignature);
        insertOrReplace.run("eligibleFiles", String(eligibleFiles));
        insertOrReplace.run("pendingFiles", String(input.pendingFiles.length));
        insertOrReplace.run("indexedFiles", String(input.indexedFiles.length));
        insertOrReplace.run("omittedFiles", String(input.omittedFiles.length));

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }

    return this.readAnchor(input.anchor.kind, input.anchor.dbPath, input.headCommit, input.worktreeId);
  }

  private async ensureAnchor(input: EnsureAnchorInput): Promise<void> {
    await this.ensurePrivateDir(dirname(input.dbPath));

    const db = new DatabaseSync(input.dbPath);

    try {
      this.execSchema(db);

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
      insertOrIgnore.run("lastIndexedAt", "");
      insertOrIgnore.run("dirtySignature", "");
      insertOrIgnore.run("eligibleFiles", "0");
      insertOrIgnore.run("pendingFiles", "0");
      insertOrIgnore.run("indexedFiles", "0");
      insertOrIgnore.run("omittedFiles", "0");
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
      this.execSchema(db);
      const values = this.readMetadataMap(db);

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

  private readMetadataMap(db: DatabaseSync): Map<string, string> {
    const rows = db.prepare(`SELECT key, value FROM metadata`).all() as Array<{ key: string; value: string }>;
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  private execSchema(db: DatabaseSync): void {
    db.exec(METADATA_TABLE_SQL);
    db.exec(FILE_INDEX_TABLE_SQL);
    db.exec(OMITTED_FILES_TABLE_SQL);
    db.exec(SYMBOLS_TABLE_SQL);
    db.exec(IMPORTS_TABLE_SQL);
    db.exec(EXPORTS_TABLE_SQL);
    db.exec(REFERENCES_TABLE_SQL);
  }

  private async ensurePrivateDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700).catch(() => undefined);
  }
}

function createBasicSummary(content: string): BasicFileSummary {
  const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  return {
    lineCount,
    byteCount: Buffer.byteLength(content),
    preview: createPreview(content),
  };
}

function createPreview(content: string): string {
  return content
    .split(/\r?\n/)
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function detectBasicLanguage(path: string): string {
  const match = path.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? "text";
}

function createContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
