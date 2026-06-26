export interface TsJsAnalyzerInput {
  path: string;
  content: string;
}

export interface TsJsSymbolFact {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface TsJsImportFact {
  moduleSpecifier: string;
  importedName: string;
  localName: string;
  isTypeOnly: boolean;
}

export interface TsJsExportFact {
  exportedName: string;
  kind: string;
  moduleSpecifier?: string;
}

export interface TsJsReferenceFact {
  name: string;
  line: number;
  column: number;
}

export interface TsJsAnalysis {
  language: "typescript" | "javascript";
  analysisQuality: "structural";
  summary: {
    lineCount: number;
    symbolCount: number;
    importCount: number;
    exportCount: number;
    referenceCount: number;
  };
  symbols: TsJsSymbolFact[];
  imports: TsJsImportFact[];
  exports: TsJsExportFact[];
  references: TsJsReferenceFact[];
}

const SYMBOL_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "function", regex: /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "class", regex: /^(export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", regex: /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", regex: /^(export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: "enum", regex: /^(export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "variable", regex: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
];

export class TsJsAnalyzer {
  async analyze(input: TsJsAnalyzerInput): Promise<TsJsAnalysis> {
    const lines = input.content.split(/\r?\n/);
    const symbols: TsJsSymbolFact[] = [];
    const imports: TsJsImportFact[] = [];
    const exports: TsJsExportFact[] = [];
    const references: TsJsReferenceFact[] = [];
    const declarationLocations = new Set<string>();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const trimmed = line.trim();
      const lineNumber = index + 1;

      const importMatch = trimmed.match(/^import\s+(.+?)\s+from\s+["'](.+)["'];?$/);
      if (importMatch) {
        const [, clause, moduleSpecifier] = importMatch;
        for (const entry of parseImportClause(clause, moduleSpecifier)) {
          imports.push(entry);
        }
      }

      const exportNamedMatch = trimmed.match(/^export\s+\{(.+?)\}(?:\s+from\s+["'](.+)["'])?;?$/);
      if (exportNamedMatch) {
        const [, clause, moduleSpecifier] = exportNamedMatch;
        for (const entry of clause.split(",").map((value) => value.trim()).filter(Boolean)) {
          const [rawImported, rawExported] = entry.split(/\s+as\s+/i).map((value) => value.trim());
          exports.push({
            exportedName: rawExported ?? rawImported,
            kind: moduleSpecifier ? "re-export" : "named",
            moduleSpecifier,
          });
        }
      }

      const exportAllMatch = trimmed.match(/^export\s+\*\s+from\s+["'](.+)["'];?$/);
      if (exportAllMatch) {
        exports.push({
          exportedName: "*",
          kind: "export-all",
          moduleSpecifier: exportAllMatch[1],
        });
      }

      if (/^export\s+default\b/.test(trimmed)) {
        exports.push({ exportedName: "default", kind: "default" });
      }

      for (const pattern of SYMBOL_PATTERNS) {
        const match = trimmed.match(pattern.regex);
        if (!match) {
          continue;
        }

        const exported = Boolean(match[1]);
        const name = match[2] ?? "";
        declarationLocations.add(`${lineNumber}:${line.indexOf(name) + 1}`);
        symbols.push({
          name,
          kind: pattern.kind,
          startLine: lineNumber,
          endLine: lineNumber,
          exported,
        });
        if (exported) {
          exports.push({ exportedName: name, kind: pattern.kind });
        }
        break;
      }

      const scrubbed = line.replace(/(['"`]).*?\1/g, " ");
      for (const match of scrubbed.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
        const name = match[1];
        const column = (match.index ?? 0) + 1;
        if (!name || JS_KEYWORDS.has(name) || declarationLocations.has(`${lineNumber}:${column}`)) {
          continue;
        }

        references.push({
          name,
          line: lineNumber,
          column,
        });
      }
    }

    return {
      language: isTypeScriptPath(input.path) ? "typescript" : "javascript",
      analysisQuality: "structural",
      summary: {
        lineCount: input.content.length === 0 ? 0 : lines.length,
        symbolCount: symbols.length,
        importCount: imports.length,
        exportCount: exports.length,
        referenceCount: references.length,
      },
      symbols,
      imports,
      exports,
      references,
    };
  }
}

function isTypeScriptPath(path: string): boolean {
  return /\.(cts|mts|ts|tsx)$/i.test(path);
}

function parseImportClause(clause: string, moduleSpecifier: string): TsJsImportFact[] {
  const results: TsJsImportFact[] = [];
  const normalized = clause.trim();

  if (normalized.startsWith("* as ")) {
    results.push({
      moduleSpecifier,
      importedName: "*",
      localName: normalized.slice(5).trim(),
      isTypeOnly: false,
    });
    return results;
  }

  const braceMatch = normalized.match(/^(.+?),\s*\{(.+)\}$/);
  if (braceMatch) {
    results.push({
      moduleSpecifier,
      importedName: "default",
      localName: braceMatch[1].trim(),
      isTypeOnly: false,
    });
    results.push(...parseNamedImports(braceMatch[2], moduleSpecifier));
    return results;
  }

  if (normalized.startsWith("{")) {
    return parseNamedImports(normalized.slice(1, -1), moduleSpecifier);
  }

  results.push({
    moduleSpecifier,
    importedName: "default",
    localName: normalized,
    isTypeOnly: false,
  });
  return results;
}

function parseNamedImports(clause: string, moduleSpecifier: string): TsJsImportFact[] {
  return clause
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((entry) => {
      const typeOnly = /^type\s+/.test(entry);
      const normalized = entry.replace(/^type\s+/, "");
      const [importedName, localName] = normalized.split(/\s+as\s+/i).map((value) => value.trim());
      return {
        moduleSpecifier,
        importedName,
        localName: localName ?? importedName,
        isTypeOnly: typeOnly,
      };
    });
}

const JS_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
