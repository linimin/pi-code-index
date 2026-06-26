# Analyzer Plugin System Implementation Plan

## Status

Draft.

## Relationship to existing documents

- `docs/mvp-spec.md` remains the normative source for the currently shipped Phase 1 surface.
- This document does **not** change the current MVP command surface, tool surface, transport, or daemon topology.
- This document is the normative implementation plan for future analyzer plugin work **when analyzer plugin work is explicitly requested**.
- If any part of this document would expand or contradict current MVP user-facing scope unintentionally, `docs/mvp-spec.md` still wins for the currently shipped product.

---

## 1. Purpose

This document defines the concrete implementation plan for adding a full analyzer plugin system to `@linimin/pi-code-index`.

The plan is intentionally specific. It chooses one architecture, one packaging model, one discovery path, one runtime loading model, and one invalidation strategy so that follow-up implementation work is not ambiguous.

The target outcome is:

- one thin pi extension remains the user-facing integration layer
- one user-scoped daemon remains the only analysis runtime
- language support becomes extensible through daemon-side analyzer plugins
- analyzer packages can be installed with normal pi package flows
- unsupported languages can gain structural support without rewriting daemon core logic

---

## 2. Design decisions summary

| Topic | Decision |
|---|---|
| Main pi extension | `@linimin/pi-code-index` remains the only primary user-facing extension |
| Analyzer execution location | Analyzer plugins run inside the daemon, not inside the pi extension event lifecycle |
| Distribution model | Analyzer plugins are distributed as pi packages, but their core role is daemon-side analyzer loading |
| Package discovery model | Analyzer packages include a **thin extension shim** that publishes analyzer manifests to the main extension |
| Daemon/plugin handshake | The main extension syncs a deterministic analyzer catalog into the daemon over the existing IPC boundary |
| Plugin API surface | One canonical plugin API package: `@linimin/pi-code-index-plugin-api` |
| Query ownership | Plugins produce canonical facts only; the daemon core keeps ownership of `symbol_lookup`, `file_summary`, and `impact_analysis` |
| Built-in analyzers | Current TS/JS and fallback analyzers are converted into built-in plugins first |
| File selection | Exactly one primary analyzer plugin is selected per file; fallback is last-resort only |
| Cache invalidation | Initial implementation uses **repo-wide analyzer-catalog invalidation** rather than per-file targeted invalidation |
| Isolation model | Initial implementation loads plugins in-process with crash containment and quarantine; no subprocess isolation in v1 |
| Public commands | No new public commands are added |
| Public tools | No new public tools are added |

These decisions are mandatory for implementation derived from this plan.

---

## 3. Goals

The plugin system must:

1. let the daemon support additional languages without hardcoding every new analyzer into core logic
2. preserve the thin-extension / heavy-daemon split
3. preserve the current command surface and tool surface
4. preserve the current single-daemon process topology
5. let analyzer packages be installed through normal pi package flows
6. preserve explicit operator visibility through `/index doctor`
7. fail closed and remain deterministic when plugins are missing, incompatible, or crashing

---

## 4. Non-goals

This implementation plan does **not** include:

- per-repo daemons
- HTTP transport
- Windows support
- semantic search, embeddings, reranking, or new query tools
- plugin-specific user-facing commands
- plugin-specific prompt injection
- targeted per-file plugin invalidation in the first plugin-system implementation
- runtime hot-swapping of analyzer code without daemon catalog sync
- using pi extensions themselves as the analyzer execution environment

---

## 5. Why analyzers are not ordinary pi extensions

Analyzer plugins must **not** be designed as ordinary pi extensions with primary responsibility for session hooks, command registration, or tool registration.

Reasons:

1. analyzers are daemon concerns, not agent-session concerns
2. analyzers need indexing, storage, and query integration rather than UI lifecycle control
3. the main extension must remain thin
4. analyzer packages should not automatically gain unnecessary powers such as tool interception or prompt mutation
5. daemon lifecycle, cache invalidation, and repo runtime management must stay authoritative inside the daemon

Therefore the analyzer system is defined as:

> **pi package for installation and trust + daemon plugin for execution**

A plugin package may include a thin extension shim for discovery, but that shim is only a registration mechanism. It is not the analyzer runtime.

---

## 6. Package model

### 6.1 Required package roles

There are three package roles in the complete system:

#### A. Core package
`@linimin/pi-code-index`

Responsibilities:
- registers `/index` commands
- registers the three approved tools
- owns daemon lifecycle and IPC
- owns plugin discovery aggregation and daemon sync
- owns storage schema and query engine

#### B. Plugin API package
`@linimin/pi-code-index-plugin-api`

Responsibilities:
- exports plugin TypeScript interfaces
- exports manifest schemas and validators
- exports shim-side registration helpers
- exports canonical fact types

#### C. Analyzer plugin packages
Examples:
- `@linimin/pi-code-index-analyzer-python`
- `@linimin/pi-code-index-analyzer-go`
- `@linimin/pi-code-index-analyzer-rust`

Responsibilities:
- declare analyzer manifest metadata
- expose daemon-loadable analyzer module entrypoints
- optionally include a thin extension shim for discovery registration

### 6.2 Analyzer package structure

Analyzer packages must use this structure:

```text
package.json
src/
  analyzer.ts
extensions/
  index.ts
```

The built artifact layout may differ, but the logical package roles must remain the same.

### 6.3 Required package.json fields

Analyzer packages must declare a custom `piCodeIndex` manifest section.

Example:

```json
{
  "name": "@linimin/pi-code-index-analyzer-python",
  "version": "0.1.0",
  "keywords": ["pi-package", "pi-code-index-analyzer"],
  "exports": {
    ".": "./dist/analyzer.js"
  },
  "peerDependencies": {
    "@linimin/pi-code-index-plugin-api": "^1.0.0"
  },
  "pi": {
    "extensions": ["./extensions/index.js"]
  },
  "piCodeIndex": {
    "pluginApiVersion": 1,
    "analyzers": [
      {
        "id": "python-structural",
        "entry": "./dist/analyzer.js",
        "languages": ["python"],
        "fileExtensions": [".py", ".pyi"],
        "specialFilenames": [],
        "analysisQuality": "structural",
        "capabilities": {
          "fileSummary": "structural",
          "symbolLookup": "structural",
          "impactAnalysis": "basic"
        },
        "priority": 100,
        "requires": {
          "os": ["darwin", "linux"],
          "node": ">=22.6.0"
        }
      }
    ]
  }
}
```

### 6.4 Shim requirement

Every externally distributed analyzer package **must** include a thin extension shim.

The shim exists only to participate in pi package discovery and trust.

The shim must:
- register analyzer package descriptors into a shared in-process descriptor registry
- register nothing else

The shim must **not**:
- register user-facing commands
- register user-facing tools
- intercept prompts or tool calls
- talk directly to the daemon
- implement language analysis itself

---

## 7. Discovery and trust model

### 7.1 Discovery source of truth

The daemon will **not** scan pi installation directories or pi settings files directly to discover analyzer plugins.

Instead, the discovery source of truth is:

1. built-in analyzer definitions bundled with `@linimin/pi-code-index`
2. analyzer package descriptors published by trusted extension shims loaded into the current pi runtime

This preserves pi's existing trust model and avoids coupling the daemon to pi package installation internals.

### 7.2 Descriptor publication flow

Each analyzer package shim must call a helper from `@linimin/pi-code-index-plugin-api` at extension load time.

Required helper name:

```ts
publishAnalyzerPackageDescriptors(...)
```

Required retrieval helper in the main extension:

```ts
listPublishedAnalyzerPackageDescriptors()
```

These helpers must use a process-global registry under a stable `globalThis` symbol so that multiple extension packages in the same pi process can cooperate without order-sensitive imports.

### 7.3 Trust rule

Project-local analyzer packages only become discoverable after project trust, because their shim extensions only load after trust.

This is intentional and required.

No daemon-side bypass of pi trust is allowed.

---

## 8. Analyzer catalog sync between extension and daemon

### 8.1 Catalog ownership

The main extension owns the **current analyzer catalog** visible in the current pi runtime.

That catalog consists of:
- all built-in analyzers
- all published descriptors from trusted analyzer package shims

### 8.2 Deterministic catalog hash

The main extension must compute a deterministic `analyzerCatalogHash` from the fully normalized catalog.

Normalization rules:
- sort by `id` ascending
- serialize with stable field order
- include plugin API version, package name, package version, analyzer manifest, and resolved entry path

### 8.3 IPC method addition

The daemon protocol must add a new internal method:

```ts
syncAnalyzerCatalog
```

This is an internal daemon API method, not a user-facing command.

### 8.4 Sync rule

Before any daemon operation that depends on analyzer selection or analyzer-derived status truth, the client must ensure the daemon has the current analyzer catalog.

Required behavior:
1. call `health`
2. compare daemon-reported `analyzerCatalogHash` with local current hash
3. if they differ, call `syncAnalyzerCatalog`
4. only then proceed with `openRepo`, `enableRepoIndexing`, `reindexRepo`, `getStatus`, `getRepoDiagnostics`, or query methods

This rule is mandatory.

### 8.5 Health response extension

`HealthResponse` must be extended to include:

```ts
analyzerCatalogHash: string
```

This is a wire-contract change and must increment the daemon protocol version.

---

## 9. Plugin API contract

The plugin API package must export these canonical interfaces.

### 9.1 Manifest

```ts
export interface AnalyzerManifest {
  id: string;
  pluginApiVersion: 1;
  version: string;
  languages: string[];
  fileExtensions: string[];
  specialFilenames: string[];
  analysisQuality: "basic" | "structural" | "semantic";
  capabilities: {
    fileSummary: "none" | "basic" | "structural" | "semantic";
    symbolLookup: "none" | "basic" | "structural" | "semantic";
    impactAnalysis: "none" | "basic" | "structural" | "semantic";
  };
  priority: number;
  requires?: {
    os?: Array<"darwin" | "linux">;
    node?: string;
  };
}
```

### 9.2 Runtime plugin definition

```ts
export interface AnalyzerPluginDefinition {
  manifest: AnalyzerManifest;
  create(context: AnalyzerPluginCreateContext): AnalyzerPlugin;
}
```

The analyzer entry module **must** default-export an `AnalyzerPluginDefinition`.

### 9.3 Runtime plugin instance

```ts
export interface AnalyzerPlugin {
  matches(path: string): boolean;
  analyzeFile(input: AnalyzeFileRequest, signal?: AbortSignal): Promise<AnalyzeFileResult>;
  shutdown?(): Promise<void>;
}
```

### 9.4 Create context

```ts
export interface AnalyzerPluginCreateContext {
  packageName: string;
  packageVersion: string;
  packageRoot: string;
  cacheDir: string;
}
```

### 9.5 Analyze request

```ts
export interface AnalyzeFileRequest {
  repoRoot: string;
  repoRelativePath: string;
  headCommit: string | null;
  worktreeId: string;
  content: string;
}
```

### 9.6 Analyze result

```ts
export interface AnalyzeFileResult {
  language: string;
  analysisQuality: "basic" | "structural" | "semantic";
  summary: {
    lineCount: number;
    byteCount: number;
    preview: string;
  };
  symbols: SymbolFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  references: ReferenceFact[];
}
```

### 9.7 Canonical fact types

The plugin API package must define the canonical fact types consumed by the daemon core:

- `SymbolFact`
- `ImportFact`
- `ExportFact`
- `ReferenceFact`

The daemon core query engine remains the only owner of final tool response formatting.

Plugins must not expose custom query response shapes to the agent.

---

## 10. Built-in analyzers become built-in plugins

Before any external analyzer loading is implemented, the current built-in analyzers must be converted to the plugin architecture.

Required built-ins:

1. `builtin:tsjs-structural`
2. `builtin:fallback-basic`

### 10.1 Selection rule for built-ins

- `builtin:tsjs-structural` always wins for current MVP TS/JS file types
- external plugins do **not** override built-in TS/JS in the first analyzer-plugin implementation
- `builtin:fallback-basic` is the last-resort analyzer for all remaining files

This restriction is intentional. The first plugin-system implementation is for extending support to additional languages without destabilizing existing TS/JS behavior.

---

## 11. File matching and analyzer selection

### 11.1 Exactly one primary analyzer per file

The daemon must select exactly one primary analyzer per indexed file.

There is no multi-plugin merge for a single file in the initial implementation.

### 11.2 Selection algorithm

For a given file:

1. if the file matches the built-in TS/JS analyzer, select `builtin:tsjs-structural`
2. otherwise gather external plugin candidates whose manifest extension/special-file prefilters match
3. run `plugin.matches(path)` on those candidates
4. select the winning candidate by:
   1. higher `priority`
   2. more specific static match
   3. lower `id` lexicographically
5. if no external candidate wins, select `builtin:fallback-basic`

### 11.3 Specificity rule

Specificity order:
1. exact special filename match
2. longer file extension match
3. lexicographic tie-break by plugin id

This must be deterministic.

---

## 12. Storage and invalidation model

### 12.1 Store metadata additions

Each baseline and overlay DB must store:

- `pluginApiVersion`
- `analyzerCatalogHash`
- `languageAdapterSet`

### 12.2 File-level metadata additions

Each indexed file row must store:

- `pluginId`
- `pluginVersion`

### 12.3 Initial invalidation rule

The initial analyzer-plugin implementation must use **repo-wide analyzer-catalog invalidation**.

Rule:
- if a repo runtime detects that the current daemon `analyzerCatalogHash` does not match the hash recorded in its current baseline or overlay metadata, that repo becomes stale and must rebuild baseline and overlay index content on the next indexing cycle

This is intentionally simple and safe.

Targeted per-file invalidation is explicitly deferred.

### 12.4 Why repo-wide invalidation is chosen

It avoids ambiguity around:
- plugin selection changes
- plugin behavior changes
- plugin version upgrades
- built-in vs external analyzer reordering

The first plugin-system implementation optimizes for correctness, not minimal rebuild scope.

---

## 13. Query integration rules

### 13.1 Query surfaces do not change

The user-facing tool surface remains:
- `symbol_lookup`
- `file_summary`
- `impact_analysis`

No plugin may directly expose a new agent tool through the analyzer plugin contract.

### 13.2 Core query engine remains authoritative

The daemon core remains responsible for:
- query planning
- deterministic ranking
- truncation
- freshness metadata
- coverage metadata
- provenance metadata
- final output contract

Plugins only contribute file-level canonical facts.

### 13.3 Capability interpretation

The daemon core must respect manifest capabilities.

Examples:
- if a plugin declares `symbolLookup: none`, files analyzed by that plugin do not contribute structural symbol matches
- if a plugin declares `impactAnalysis: basic`, those files may contribute only coarse impact hints
- if a plugin declares `fileSummary: structural`, the daemon may surface structural summary information from its facts

---

## 14. Failure handling and quarantine

### 14.1 Load failure

If a plugin entry module fails to load or validate:
- the daemon marks the plugin unavailable for the lifetime of that daemon process
- the plugin must appear in diagnostics with the load error
- the daemon continues operating with remaining plugins

### 14.2 File analysis failure

If a plugin throws while analyzing a file:
- the daemon records a diagnostic
- the daemon falls back to `builtin:fallback-basic` for that file if the file is otherwise eligible
- the daemon increments the plugin crash count for the current daemon process

### 14.3 Quarantine threshold

If a plugin reaches **5 file-analysis crashes** in one daemon process:
- the daemon quarantines that plugin for the remainder of the process lifetime
- subsequent matching files use fallback behavior instead
- `/index doctor` must report the plugin as quarantined

No subprocess isolation is introduced in the initial implementation.

---

## 15. Diagnostics and observability

### 15.1 `/index doctor` additions

`/index doctor` must include daemon-wide plugin observability:

- analyzer catalog hash
- plugin API version
- loaded analyzer plugins
- unavailable analyzer plugins
- quarantined analyzer plugins
- per-plugin id/version/languages/capabilities

### 15.2 Repo-level diagnostics

For the current repo, `/index doctor` must also report:
- selected built-in analyzers
- selected external analyzers if any files use them
- whether current DB metadata hash matches daemon analyzer catalog hash
- whether the repo is stale because of analyzer catalog mismatch

### 15.3 `/index status`

`/index status` remains concise.

It does not need to list every plugin, but it must remain truthful if analyzer-catalog mismatch causes a stale or rebuilding state.

---

## 16. Trust and security rules

### 16.1 Trusted loading only

Only analyzers published through trusted loaded shims may enter the catalog.

### 16.2 Daemon trust independence is forbidden

The daemon must not independently scan the filesystem for project-local analyzer packages outside the trusted extension discovery path.

### 16.3 Companion shim restrictions

Companion shims must stay minimal.

They must not add:
- agent tools
- commands
- prompt injection
- session mutation
- tool interception

If a package needs additional UX beyond analyzer registration, that UX must be implemented as an explicitly separate optional extension module.

---

## 17. Protocol and versioning requirements

### 17.1 Protocol bump rule

Any wire-contract change required for plugin support must bump `DAEMON_PROTOCOL_VERSION`.

### 17.2 Plugin API versioning

The analyzer plugin contract uses its own explicit `pluginApiVersion`.

Initial value:

```ts
pluginApiVersion = 1
```

The daemon must reject plugin manifests with unsupported API versions.

### 17.3 Compatibility policy

Initial compatibility policy:
- daemon supports exactly plugin API version `1`
- plugin manifest API mismatch is a hard load failure
- no downgrade compatibility is required

---

## 18. Implementation phases

This section is normative for implementation sequencing.

### Phase A — pluginize existing built-ins

Deliverables:
- add `src/daemon/plugins/` module structure
- convert current TS/JS analyzer into `builtin:tsjs-structural`
- convert current fallback path into `builtin:fallback-basic`
- remove hardcoded analyzer selection from daemon core

Required files:
- `src/daemon/plugins/types.ts`
- `src/daemon/plugins/registry.ts`
- `src/daemon/plugins/selection.ts`
- `src/daemon/plugins/builtin/tsjs.ts`
- `src/daemon/plugins/builtin/fallback.ts`
- updates in `src/daemon/server.ts`

Exit criteria:
- current tests still pass
- no user-facing behavior changes

### Phase B — plugin API package and shim-side descriptor publication

Deliverables:
- create `@linimin/pi-code-index-plugin-api`
- add manifest schema and TS interfaces
- add global descriptor publication helpers
- update core extension to aggregate built-in and shim-published descriptors

Required surfaces:
- new package for plugin API
- `src/extension/` integration updates in core package

Exit criteria:
- analyzer catalog can be built deterministically in the extension process
- built-in analyzers appear in the catalog even without external packages

### Phase C — daemon catalog sync and external plugin loading

Deliverables:
- add `syncAnalyzerCatalog` daemon method
- add `analyzerCatalogHash` to `HealthResponse`
- load external analyzer modules from synchronized catalog descriptors
- validate package manifest and runtime module shape

Required surfaces:
- `src/shared/protocol.ts`
- `src/extension/daemon-client.ts`
- `src/daemon/server.ts`
- new loader/manifest modules under `src/daemon/plugins/`

Exit criteria:
- daemon receives and activates external analyzer catalog entries
- unsupported or invalid plugins fail closed without crashing daemon

### Phase D — storage metadata and repo-wide invalidation

Deliverables:
- extend store metadata with plugin API version and analyzer catalog hash
- extend file rows with `pluginId` and `pluginVersion`
- enforce repo-wide invalidation on analyzer catalog hash mismatch

Required surfaces:
- `src/daemon/sqlite-store.ts`
- `src/daemon/server.ts`
- storage tests

Exit criteria:
- changing analyzer catalog hash makes repo stale and triggers rebuild
- rebuilt DB metadata reflects current catalog hash

### Phase E — diagnostics and operator visibility

Deliverables:
- plugin diagnostics in `/index doctor`
- stale reason visibility when caused by analyzer-catalog mismatch
- load-failure and quarantine reporting

Required surfaces:
- `src/daemon/server.ts`
- `src/extension/commands/index-command.ts`
- tests

Exit criteria:
- operator can explain why a plugin is active, unavailable, or quarantined

### Phase F — first external pilot analyzer

Deliverables:
- implement one external analyzer package for a non-TS/JS language
- ship it using the shim + daemon-plugin model
- prove end-to-end install/discovery/load/index/query flow

Recommended pilot language:
- Python

Exit criteria:
- `pi install` of the pilot package results in end-to-end daemon-side analyzer support after trust and reload/start

---

## 19. Test requirements

The completed plugin system must add deterministic coverage for:

1. built-in analyzers registered through the plugin registry
2. shim publication and descriptor aggregation
3. daemon catalog sync and catalog hash mismatch detection
4. external analyzer load success
5. external analyzer load failure
6. file selection determinism when multiple plugins could match
7. fallback behavior when plugin analysis throws
8. plugin quarantine after repeated crashes
9. repo-wide cache invalidation when analyzer catalog hash changes
10. `/index doctor` plugin observability
11. restart behavior with plugin catalog preserved through extension-side rediscovery and daemon-side resync

---

## 20. Final implementation rule

For this project, the correct plugin system is:

> **pi package for distribution and trust**
> + **thin extension shim for discovery registration**
> + **daemon-side plugin execution for analysis**

Any implementation that turns analyzer packages into ordinary pi extensions with primary ownership of commands, tools, or agent-session behavior is out of scope for this plan.
