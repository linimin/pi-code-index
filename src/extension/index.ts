import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerIndexCommand } from "./commands/index-command.ts";
import {
  DaemonClient,
  DaemonRemoteError,
  ProtocolMismatchError,
  RepoContextError,
  UnsupportedPlatformError,
  resolveRepoLocator,
} from "./daemon-client.ts";
import type {
  FileSummaryResponse,
  ImpactAnalysisResponse,
  RepoStatus,
  SymbolLookupResponse,
} from "../shared/protocol.ts";

const PHASE_ONE_TOOL_NAMES = ["symbol_lookup", "file_summary", "impact_analysis"] as const;

const symbolLookupTool = {
  name: "symbol_lookup",
  label: "Symbol Lookup",
  description: "Look up indexed TypeScript/JavaScript symbols with deterministic ordering and freshness metadata.",
  promptSnippet: "Use symbol_lookup before broad file reads when you need a named symbol definition or nearby related files.",
  promptGuidelines: [
    "Use symbol_lookup for named code entities before exploring entire files.",
    "Prefer file_summary after symbol_lookup when you need a fuller explanation of one file.",
  ],
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name or prefix to look up within the current enabled repository." },
      limit: { type: "number", description: "Optional result cap up to the Phase 1 maximum of 10 matches." },
    },
    required: ["symbol"],
    additionalProperties: false,
  },
  async execute(_toolCallId: string, params: { symbol: string; limit?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
    const client = new DaemonClient();
    const repo = await resolveRepoLocator(ctx.cwd);
    const result = await client.symbolLookup({ repo, symbol: params.symbol, limit: params.limit });
    return {
      content: [{ type: "text", text: formatSymbolLookup(result) }],
      details: result,
    };
  },
};

const fileSummaryTool = {
  name: "file_summary",
  label: "File Summary",
  description: "Return an indexed summary for one repository file, including important ranges and related files.",
  promptSnippet: "Use file_summary when you want one file's structure or fallback summary without reading the full file body.",
  promptGuidelines: [
    "Use file_summary to inspect one indexed file with metadata instead of pulling the entire file body.",
  ],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative path for the file to summarize." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(_toolCallId: string, params: { path: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
    const client = new DaemonClient();
    const repo = await resolveRepoLocator(ctx.cwd);
    const result = await client.fileSummary({ repo, path: params.path });
    return {
      content: [{ type: "text", text: formatFileSummary(result) }],
      details: result,
    };
  },
};

const impactAnalysisTool = {
  name: "impact_analysis",
  label: "Impact Analysis",
  description: "Estimate affected files and ranges for a target path or symbol using the local index only.",
  promptSnippet: "Use impact_analysis to estimate likely affected files before proposing or applying changes.",
  promptGuidelines: [
    "Use impact_analysis before broad edits when you need a bounded list of likely affected files.",
  ],
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "Target file path, symbol name, or query string to analyze." },
      limit: { type: "number", description: "Optional impacted-area cap up to the Phase 1 maximum of 10 areas." },
    },
    required: ["target"],
    additionalProperties: false,
  },
  async execute(_toolCallId: string, params: { target: string; limit?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
    const client = new DaemonClient();
    const repo = await resolveRepoLocator(ctx.cwd);
    const result = await client.impactAnalysis({ repo, target: params.target, limit: params.limit });
    return {
      content: [{ type: "text", text: formatImpactAnalysis(result) }],
      details: result,
    };
  },
};

export default function createPiCodeIndexExtension(pi: ExtensionAPI): void {
  registerIndexCommand(pi);
  pi.registerTool(symbolLookupTool);
  pi.registerTool(fileSummaryTool);
  pi.registerTool(impactAnalysisTool);

  pi.on("before_agent_start", async (_event, ctx) => {
    const activeTools = pi.getActiveTools();
    const nonIndexTools = activeTools.filter((name) => !PHASE_ONE_TOOL_NAMES.includes(name as (typeof PHASE_ONE_TOOL_NAMES)[number]));
    const shouldEnable = await shouldEnableIndexTools(ctx.cwd);
    const nextTools = shouldEnable ? [...nonIndexTools, ...PHASE_ONE_TOOL_NAMES] : nonIndexTools;

    if (sameToolList(activeTools, nextTools)) {
      return;
    }

    pi.setActiveTools(nextTools);
  });
}

async function shouldEnableIndexTools(cwd: string): Promise<boolean> {
  try {
    const repo = await resolveRepoLocator(cwd);
    const client = new DaemonClient();
    const status = await client.getStatus(repo);
    return isHealthyRepoStatus(status);
  } catch (error) {
    if (
      error instanceof RepoContextError ||
      error instanceof UnsupportedPlatformError ||
      error instanceof ProtocolMismatchError ||
      error instanceof DaemonRemoteError
    ) {
      return false;
    }

    return false;
  }
}

function isHealthyRepoStatus(status: RepoStatus): boolean {
  return status.enabled && status.state !== "disabled" && status.state !== "error";
}

function sameToolList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatSymbolLookup(result: SymbolLookupResponse): string {
  const header = [
    `symbol_lookup: ${result.query}`,
    `freshness=${result.freshness} coverage=${result.coverage.indexedFiles}/${result.coverage.eligibleFiles} (${result.coverage.indexedPercent}%) provenance=${result.provenance} analysisQuality=${result.analysisQuality}`,
    `matches=${result.returnedCount}${typeof result.totalCount === "number" ? `/${result.totalCount}` : ""}${result.truncated ? " truncated" : ""}`,
  ];

  const body = result.matches.length > 0
    ? result.matches.map((match, index) => {
        const nextRead = match.suggestedNextRead.length > 0 ? match.suggestedNextRead.join(", ") : "none";
        return `${index + 1}. ${match.kind} ${match.symbol} @ ${match.path}:${match.range.startLine}-${match.range.endLine}\n   summary: ${match.summary}\n   reason: ${match.reason}\n   next: ${nextRead}\n   quality: ${match.analysisQuality} freshness: ${match.freshness}`;
      })
    : ["No indexed symbol matches found."];

  return [...header, ...body].join("\n");
}

function formatFileSummary(result: FileSummaryResponse): string {
  const exports = result.mainExports.length > 0
    ? result.mainExports.map((entry) => `${entry.name} (${entry.kind})`).join(", ")
    : "none";
  const ranges = result.importantRanges.map((range) => `${range.startLine}-${range.endLine}`).join(", ");
  const related = result.relatedFiles.length > 0
    ? result.relatedFiles.map((entry) => `${entry.path} — ${entry.reason}`).join("\n")
    : "none";

  return [
    `file_summary: ${result.path}`,
    `freshness=${result.freshness} coverage=${result.coverage.indexedFiles}/${result.coverage.eligibleFiles} (${result.coverage.indexedPercent}%) provenance=${result.provenance} analysisQuality=${result.analysisQuality}`,
    `summary: ${result.summary}`,
    `mainExports: ${exports}`,
    `importantRanges: ${ranges || "none"}`,
    `relatedFiles=${result.relatedFilesReturnedCount}${typeof result.relatedFilesTotalCount === "number" ? `/${result.relatedFilesTotalCount}` : ""}${result.relatedFilesTruncated ? " truncated" : ""}`,
    related,
  ].join("\n");
}

function formatImpactAnalysis(result: ImpactAnalysisResponse): string {
  const areas = result.areas.length > 0
    ? result.areas.map((area, index) => {
        const range = area.range ? `:${area.range.startLine}-${area.range.endLine}` : "";
        return `${index + 1}. ${area.path}${range}\n   reason: ${area.reason}\n   summary: ${area.summary}\n   quality: ${area.analysisQuality} freshness: ${area.freshness}`;
      })
    : ["No indexed impacted areas found."];

  return [
    `impact_analysis: ${result.target}`,
    `freshness=${result.freshness} coverage=${result.coverage.indexedFiles}/${result.coverage.eligibleFiles} (${result.coverage.indexedPercent}%) provenance=${result.provenance} analysisQuality=${result.analysisQuality}`,
    `reason: ${result.reason}`,
    `risk: ${result.risk}`,
    `areas=${result.areasReturnedCount}${typeof result.areasTotalCount === "number" ? `/${result.areasTotalCount}` : ""}${result.areasTruncated ? " truncated" : ""}`,
    `suggestedNextRead=${result.suggestedNextReadReturnedCount}${typeof result.suggestedNextReadTotalCount === "number" ? `/${result.suggestedNextReadTotalCount}` : ""}${result.suggestedNextReadTruncated ? " truncated" : ""}: ${result.suggestedNextRead.join(", ") || "none"}`,
    ...areas,
  ].join("\n");
}
