# RFC: pi-code-index

## Status

Draft

## Summary

This RFC proposes an **extension + local sidecar daemon** code intelligence architecture for pi. The goal is to replace large amounts of ad hoc `read` / `grep` / `bash` exploration with background indexing and high-level query APIs, so the agent can retrieve the most relevant codebase information on demand with lower token cost while staying accurate to the local working tree.

Core direction:

- **Keep the pi extension thin**
- **Use a local sidecar daemon as the main analysis runtime**
- **Use SQLite as the local index store**
- **Use a commit-aware baseline + working-tree overlay indexing model**
- **Use a local-first, shared-augmented deployment model**

---

## Background

Today, agents often understand large codebases by repeatedly using:

- `read`
- `grep`
- `bash`
- manual multi-step exploration to reconstruct symbol, import, and call relationships

This causes several problems:

1. **High token usage**: large amounts of raw source code and command output go directly into context.
2. **High exploration cost**: the model often reads many irrelevant files before finding the key area.
3. **Weak working-tree responsiveness**: without a structured index, each task replays the same exploration process.
4. **Unstable context quality**: the model receives raw data instead of compact, decision-friendly structured information.

We want a background analysis layer that precomputes repository structure so the agent can query for concise, structured, high-signal results first, then decide whether precise reads are necessary.

---

## Goals

This RFC aims to:

1. **Reduce token usage**
   - Minimize whole-file `read`, broad `grep`, and large bash outputs entering model context.

2. **Support on-demand loading**
   - Let the agent query the index, summaries, and impact surfaces before doing precise reads.

3. **Preserve local working-tree accuracy**
   - Query results should reflect the current branch, uncommitted changes, and local incremental updates.

4. **Keep the pi extension lightweight**
   - Heavy analysis, watchers, cache lifecycle, and indexing runtime should live in the sidecar daemon.

5. **Support future evolution**
   - Allow later expansion into shared baselines, cross-repo graphs, and semantic search.

---

## Non-goals

This RFC does not aim to solve the following in v1:

1. **Move full code understanding to a central remote service**
   - Local working-tree truth remains the responsibility of the local daemon.

2. **Store the indexing database in git**
   - The index is a derived artifact and should not be versioned as source.

3. **Depend on embeddings / RAG / rerankers in the first version**
   - v1 should prioritize structural indexing and high-level query APIs.

4. **Let the extension own the heavy background runtime**
   - The extension should remain an adapter, not become the main indexer.

5. **Guarantee deep semantic support for every language from day one**
   - v1 may focus on one or two primary languages first, with broader fallback support later.

---

## Success metrics and operational targets

Unless otherwise noted, the targets in this section refer to:
- a warm local daemon
- supported primary-language analyzers
- eligible text files only
- local-only query paths, not future shared-service latency

### Repository size classes

To make implementation targets concrete, v1 should classify repositories as:
- **small**: up to 2,000 eligible files or 100 MiB of eligible text
- **medium**: up to 20,000 eligible files or 1 GiB of eligible text
- **large**: anything above medium

### User-visible latency targets

The implementation should target the following p95 latencies:
- daemon connect or lazy-start after a daemon-dependent command: **<= 2 seconds**
- `/index status`: **<= 300 ms** once the daemon is reachable
- warm `symbol_lookup` and `file_summary`: **<= 500 ms**
- warm `impact_analysis`: **<= 1.5 seconds**

After `/index enable`, the system should target:
- **small repo**: first usable query results within **10 seconds**
- **medium repo**: first usable query results within **60 seconds**
- **large repo without shared baseline reuse**: partial queryability within **120 seconds**
- **large repo with reusable shared baseline**: first usable query results within **30 seconds**

For save-triggered local updates:
- supported structural analyzers should reflect a single changed file (up to 2,000 lines) within **2 seconds p95**
- basic fallback analyzers should reflect a single changed file (up to 2,000 lines) within **5 seconds p95**

A repository is considered **partially queryable** when at least `symbol_lookup` and `file_summary` can return results with explicit freshness and coverage metadata, even if the full baseline is not finished.

### Resource targets

The daemon should enforce the following default budgets in v1:
- background parser concurrency: **2 jobs per repo runtime**
- global background parser concurrency: **4 jobs max**
- background work must yield to interactive queries within **250 ms**
- sustained background CPU target: approximately **1 logical core per active repo runtime**, with short bursts allowed during initial scans
- soft memory target: **1 GiB per active repo runtime**
- fail-safe memory ceiling: **2 GiB per active repo runtime**, after which background indexing must pause and surface an error
- per-repo storage target: **the smaller of 2 GiB or 20% of eligible text bytes**, after which compaction and baseline eviction must begin

### Correctness and safety targets

The implementation must satisfy the following invariants:
- no query may return content outside the repository boundary or outside the local proof boundary
- a single query must never observe mixed partially committed generations
- any partial result must carry freshness and coverage metadata
- any omitted file due to safety or size policy must be explainable through diagnostics

---

## Proposal

### High-level architecture

```text
pi agent
  ↕
pi extension
  ↕ local IPC
local sidecar daemon
  ├─ repo registry
  ├─ file watcher
  ├─ incremental index pipeline
  ├─ query engine
  ├─ summary/cache layer
  ├─ freshness/invalidation
  └─ local index store (SQLite)
          ↕ optional enrich/fallback
team shared intelligence service
  ├─ main/develop baseline index
  ├─ ownership / architecture metadata
  ├─ cross-repo graph
  └─ heavy precomputed artifacts
```

### Core design decisions

1. **Separate extension and daemon responsibilities**
   - The extension handles pi integration and tool exposure.
   - The daemon handles analysis, indexing, queries, caching, and lifecycle.

2. **Local-first retrieval**
   - Immediate queries should resolve against local working-tree-aware index state.
   - Shared services should only provide baseline, enrichment, or fallback data.

3. **Query-first, not prompt-stuffing**
   - Do not inject large index data into the prompt by default.
   - Use tools to load information on demand.

4. **Commit-aware baseline + overlay**
   - Keep clean commit snapshots separate from uncommitted local changes.

5. **One user daemon, many repo runtimes**
   - Do not default to one daemon process per repository.
   - Prefer one user-level daemon managing multiple repo runtimes, with optional per-repo worker isolation later.

---

## Detailed design

### 1. pi extension responsibilities

The pi extension should act as a **thin client / agent adapter**.

#### Should do
- connect to the local daemon on `session_start`
- display indexing state: `ready` / `indexing` / `stale` / `error`
- register custom tools
- expose explicit indexing control through the `/index` command namespace
- inject small prompt guidance in `before_agent_start`
- unsubscribe and clean up connections on `session_shutdown`

#### Should not do
- large-scale repository scanning
- long-lived watcher management
- heavy AST / graph analysis
- direct prompt injection of large index payloads

### 1.1 Repository onboarding UX

This proposal recommends **explicit opt-in** as the primary UX for adding a repository to background indexing.

#### On install
- installing the daemon should not automatically scan all repositories
- the daemon may lazy-start, but should register no repositories by default
- no watcher or index should be created automatically

#### First use in a repository
When a user first uses pi inside a repository:
- the extension checks whether the current cwd is inside a git repository
- it checks whether indexing is already registered / enabled for that repo
- if indexing is not enabled, it should not start automatically by default
- the user can explicitly enable it with `/index enable`

Design principles:
- **lazy**: do not scan the whole machine after install
- **explicit**: require clear consent before enrolling a repo
- **progressive**: start with smart defaults, then allow later customization

#### Initial enable behavior
When the user runs `/index enable`:
- if the daemon is not running, the extension may lazy-start it
- the current repository is registered with smart defaults
- initial indexing begins
- the UI shows initialization and progress state
- once indexing is available, the agent can prefer `symbol_lookup`, `file_summary`, and `impact_analysis`

By default, users should not need to create repo-local config before getting value. Repo-local config such as `.pi/indexer.json` should only appear later if customization is needed.

### 1.2 Packaging and installation model

This proposal recommends that **`pi install` should be the primary user-facing installation entry point**, even though the daemon remains a distinct runtime component.

In other words:
- **installation should feel unified**
- **runtime responsibilities should remain separated**

### Recommended packaging model

A single pi package should ship:
- the pi extension
- a daemon client / launcher
- the daemon runtime itself, or a daemon bootstrapper/downloader

Recommended user flow:
```bash
pi install npm:your-indexing-package
```

From the user's perspective, this installs "background indexing support for pi" as one feature.

### Why not require a separate manual daemon install

Requiring users to install the extension and daemon separately would create unnecessary friction, for example:
- two separate installation flows
- version drift between extension and daemon
- unclear ownership of failures
- worse onboarding and support burden

For a local sidecar product, that is usually worse UX than a unified install path.

### Why the daemon should still remain a separate runtime

Even if installation is unified, the daemon should still be treated as a separate runtime because it has its own:
- process lifecycle
- cache / DB
- IPC boundary
- health checks
- versioning and compatibility surface

This RFC therefore recommends:
- **one installation entry point**
- **two runtime roles**

### Lazy-start lifecycle after installation

Installation should not immediately start scanning repositories.

Instead, after `pi install`:
- the extension is available
- the daemon binary/runtime is available or bootstrap-ready
- no repository is indexed by default
- the daemon may remain stopped until first use

Then, when the user first runs `/index enable` (or another daemon-dependent action), the extension should:
1. verify that the daemon is installed or bootstrap it if needed
2. verify that the daemon is running, or lazy-start it
3. perform compatibility checks
4. proceed with repo registration and indexing

### Recommended delivery variants

#### Variant A: daemon implemented in Node/TypeScript
If the daemon can run directly from the installed package runtime, the simplest path is:
- ship extension + daemon code together in one pi package
- let the extension spawn/manage the daemon process locally

#### Variant B: daemon implemented as a native binary
If the daemon is a platform-specific binary, the recommended path is:
- ship the extension and a daemon bootstrapper in the pi package
- download or install the correct daemon artifact on first use
- verify version/checksum before launch
- store it in a pi-managed local cache or package directory

This is still preferable to asking the user to manually install the daemon out-of-band.

### Versioning and compatibility

Because the extension and daemon evolve together, the package should enforce compatibility checks.

Recommended mechanisms:
- the extension knows the supported daemon protocol / minimum version
- the daemon exposes a health/version endpoint
- the extension checks compatibility before use
- if incompatible, the extension prompts for upgrade or refreshes the managed daemon artifact

### When a separate daemon installer may be justified

A separate standalone daemon installer may be reasonable only if:
- the daemon is also intended for non-pi clients (IDE integrations, CLI, other tools)
- it must run as a long-lived system service independent of pi
- it depends on heavyweight native toolchains or OS-level service integration

Even in those cases, this RFC still recommends that `pi install` remain the primary entry point for pi users, with the extension guiding or automating daemon setup as much as possible.

### Design consequence

The packaging principles are:
- **unified install UX**
- **separate runtime boundaries**
- **extension-managed daemon bootstrap and lazy-start**
- **no mandatory manual daemon install for normal pi users**

### 1.3 Platform and environment support

To avoid ambiguity in the MVP, platform support should be explicitly scoped.

### MVP support matrix

The MVP should officially support:
- macOS on local POSIX filesystems
- Linux on local POSIX filesystems

The MVP should treat the following as out of scope or best-effort only:
- Windows-native runtime support
- WSL-specific behavior guarantees
- network filesystems such as NFS and SMB
- cloud-synced directories with delayed or synthetic filesystem events
- container bind-mount environments as a primary support target

### Filesystem assumptions

The MVP assumes:
- reliable local filesystem event delivery
- stable canonical absolute paths
- repository content that is predominantly text-based

If these assumptions do not hold, the daemon may fall back to stale marking and bounded rescans, but correctness must take priority over apparent freshness.

### Path, encoding, and hashing rules

The following rules should be treated as normative:
- content hashes are computed from raw file bytes, not normalized text
- textual analysis should prefer UTF-8 decoding; files that fail text-decoding heuristics may be skipped or treated as non-text
- query-visible source locations use repository-relative paths plus line ranges
- internal identity should preserve both canonical absolute paths and git-relative paths
- case-only rename behavior on case-insensitive filesystems is best-effort in v1 and may require a bounded rescan

### 2. local sidecar daemon responsibilities

The local daemon is the **repository intelligence runtime**.

#### Core responsibilities
- manage repository identity
- start and maintain watchers
- perform incremental parse / index updates
- provide high-level query APIs
- manage local SQLite / cache state
- handle freshness and invalidation
- optionally enrich or fallback to a shared service

#### Explicitly out of scope
- talking directly to the LLM
- directly managing pi sessions
- directly rewriting the agent prompt

### 2.1 Repository enumeration and safety policy

The MVP must define exactly which files are eligible for indexing.

#### Repository boundary
- the repository boundary is the canonical git top-level returned by `git rev-parse --show-toplevel`
- if the current cwd is not inside a git repository, `/index enable` must refuse to enable indexing
- nested git repositories and git submodules are treated as separate repositories and are not recursively indexed from the parent repo in v1

#### File discovery source of truth
Eligible candidate paths must be discovered from git-aware file lists in this order:
1. tracked files
2. modified tracked files in the working tree
3. untracked but non-ignored files from git ignore-aware discovery

The daemon must not walk arbitrary parent directories outside the repository root.

#### Precedence rules
Filtering precedence, highest to lowest:
1. hard safety boundaries
2. user-local explicit overrides
3. repo-local indexing config
4. built-in default include/exclude rules
5. VCS ignore rules for untracked files

Repo-local config may widen built-in defaults, but may not override hard safety boundaries. Sensitive-file opt-in must be user-local only.

#### Hard safety boundaries
The daemon must never:
- read content outside the canonical repository root
- follow symlinks for content indexing in v1
- index special files such as devices, sockets, or FIFOs
- recurse into nested git repos or submodules from the parent repo runtime

Symlinks may be recorded as path metadata only, but their target contents are not indexed in v1.

#### Default excludes
By default, v1 should exclude common generated and vendored paths such as:
- `.git/`
- `node_modules/`
- `dist/`
- `build/`
- `.next/`
- `coverage/`
- `vendor/`
- `target/`
- `.venv/`

Repo-local config may re-include these paths if needed, except where blocked by hard safety rules.

#### Sensitive-file denylist
By default, the daemon must not index likely-secret file contents such as:
- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `*.p12`
- `*.pfx`
- `id_rsa`
- `id_ed25519`
- `.npmrc`
- `.pypirc`

These files may only be included via explicit user-local configuration, never by shared repo config.

#### Binary and large-file policy
- files detected as binary must be skipped
- files larger than 2 MiB must be skipped by default in v1
- skipped files should appear in diagnostics / coverage metadata as omitted, not silently disappear

A file may be considered binary if it contains NUL bytes in the first 8 KiB or fails text-decoding heuristics.

#### `.gitignore` behavior
- `.gitignore` applies only to untracked files
- tracked files remain eligible unless excluded by safety rules or explicit config

### 2.2 IPC security and daemon singleton model

The daemon must be local-only in the MVP and must behave as a single user-scoped instance.

### Transport and exposure rules

In the MVP:
- the primary transport is a Unix domain socket on POSIX platforms
- the daemon must not bind to non-loopback network interfaces
- local HTTP is not the default transport in the MVP

### User-scope isolation

The daemon socket and control files must live in a user-private directory, for example:
- `~/.cache/pi-index/`

Recommended permissions:
- parent runtime directory: `0700`
- socket / lock / pid files: same-user readable and writable only

The implementation may assume all clients are processes running as the same local user.

### Singleton rules

The daemon should follow a singleton-per-user model:
- at most one main daemon process may own the active socket at a time
- daemon startup must use a lock file or equivalent single-instance guard
- if multiple pi sessions attempt startup concurrently, exactly one process becomes the daemon and the rest connect to it

### Stale socket and stale lock handling

On startup or connect failure, the extension/launcher should:
1. detect whether the socket path exists
2. determine whether a live daemon still owns it
3. remove stale socket / lock artifacts only when ownership is clearly dead
4. retry connection or startup once before surfacing an error

### Handshake requirements

Every daemon connection must perform a handshake that returns at least:
- daemon version
- protocol version
- daemon PID
- daemon start time or instance ID
- supported capabilities

The extension must refuse normal operation if the daemon protocol is incompatible.

### 3. optional shared intelligence service

A shared service is a **supporting layer**, not the only source of truth.

#### Suitable responsibilities
- main / develop baseline indexes
- module ownership and architecture metadata
- cross-repo usage graphs
- CI-produced summaries and manifests
- heavy precompute such as embeddings, reranking, or large graph jobs

#### Why it cannot be the only source of truth
A shared service typically does not see:
- a developer's current branch-specific working copy
- unstaged / staged changes
- local codegen outputs
- uncommitted temporary edits

---

## On-demand loading model

The core of this proposal is not prompt preloading but **layered on-demand retrieval**.

### Level 1: routing / retrieval
First identify the most relevant regions:
- which files are most relevant
- which symbols are most relevant
- why they are relevant

### Level 2: summary
Return only enough information to make a decision:
- file / module purpose
- main symbols / entry points
- risk points / boundaries

### Level 3: precise read
Only then load precise content:
- symbol body
- function/class block
- explicit range
- caller/callee local window

### Design principles
- summarize before reading
- prefer symbol / impact analysis before broad file reads
- tool outputs should be small, short, and action-guiding
- avoid dumping full ASTs, large JSON payloads, or whole-file raw content into context

---

## Command surface

This proposal recommends a single command namespace, `/index`, as the explicit control surface for indexing, instead of many unrelated commands.

### Primary command
- `/index`

### Initial subcommands
- `/index enable`
- `/index disable`
- `/index status`
- `/index reindex`
- `/index doctor`

Optional aliases:
- `/index on` = `/index enable`
- `/index off` = `/index disable`

### Command semantics

#### `/index`
With no arguments, show a short summary of indexing status for the current repository and the available actions.

#### `/index enable`
Explicitly register the current repository with the local daemon and start background indexing.

Suggested behavior:
1. verify that cwd is inside a git repository
2. check daemon connectivity; if unavailable, lazy-start it
3. check whether indexing is already enabled for the repo
4. if the project is not trusted, allow enabling with safe defaults while ignoring repo-local indexing config
5. register the repo with smart defaults and start initial indexing
6. show `initializing` / `indexing` / `ready` state transitions

#### `/index disable`
Disable background indexing for the current repository.

Suggested default semantics:
- stop watchers and background updates
- mark the repository as disabled
- **preserve local index cache by default** so re-enable is fast later

Possible future support:
- `/index disable --purge`

#### `/index status`
Show indexing status and freshness for the current repository. Suggested fields:
- repo name/path
- enabled/disabled
- state: `ready` / `initializing` / `indexing` / `stale` / `error`
- mode
- indexed files
- last updated
- HEAD baseline
- overlay pending files
- last error, if present

#### `/index reindex`
Rebuild the index for the current repository. In v1 this may be defined as a soft rebuild; a future full rebuild option can be added later.

#### `/index doctor`
Display daemon, repository, analyzer, and storage diagnostics for the current repository, along with the next recommended recovery action.

### Example command UX

The following examples illustrate the intended command UX and response style.

#### Example: `/index` in a repo that is not yet enabled
```text
Background indexing is not enabled for this repo.

Available commands:
- /index enable
- /index status
```

#### Example: `/index enable`
```text
Background indexing enabled for this repo.

Status: initializing
Mode: standard
Scope: src/, app/, lib/, packages/*/src
Use /index status to inspect progress.
```

#### Example: progress after enable
```text
Indexing repository…
Scanning files: 42/380
Building symbols…
Current state: indexing
```

#### Example: `/index status` while indexing
```text
Index status for my-repo

Enabled: yes
State: indexing
Mode: standard
Indexed files: 380
Progress: symbols 42%
Last updated: just now
HEAD baseline: abc1234
Overlay pending: 0 files
```

#### Example: `/index status` when ready
```text
Index status for my-repo

Enabled: yes
State: ready
Mode: standard
Indexed files: 1284
Last updated: 2 minutes ago
HEAD baseline: abc1234
Overlay pending: 3 files
Shared baseline: not configured
```

#### Example: `/index disable`
```text
Background indexing disabled for this repo.
Existing local index cache was preserved.
Use /index enable to resume later.
```

#### Example: `/index disable --purge` (future)
```text
Background indexing disabled for this repo.
Local index cache was removed.
```

#### Example: `/index reindex`
```text
Reindex started for this repo.
Status: rebuilding
Use /index status to monitor progress.
```

#### Example: `/index doctor`
```text
Index doctor for my-repo

Daemon: running
Version: 0.1.0
Protocol: 1
Transport: unix:///Users/alice/.cache/pi-index/daemon.sock
Repo state: ready
Coverage: 1284/1284 files (100%)
Analyzer capabilities: tsjs=structural
Storage: 142 MiB across 2 baselines + 1 overlay
Last error: none
Suggested action: none
```

#### Example: untrusted repo on enable
```text
This repo is not trusted yet.
Background indexing can still be enabled with safe defaults,
but repo-local indexing config will be ignored.

Proceed?
```

### Repository indexing state model

The daemon / extension layer should expose at least these states:
- `disabled`
- `initializing`
- `ready`
- `indexing`
- `stale`
- `error`

Suggested transitions:
- `/index enable`: `disabled -> initializing`, `error -> initializing`
- `/index disable`: `initializing|ready|indexing|stale|error -> disabled`
- `/index reindex`: `ready|stale|error -> indexing`

---

## Proposed tool surface

### `symbol_lookup`
Look up a symbol definition and relationships.

Suggested return fields:
- symbol name
- definition path / line range
- kind / signature
- callers / related files
- short summary
- suggested next read

### `file_summary`
Return a summary of a file instead of the entire file body.

Suggested return fields:
- path
- one-line purpose description
- main exports / classes / functions
- important line ranges
- related files

### `impact_analysis`
Estimate affected areas for a requested change.

Suggested return fields:
- likely affected files
- reason for impact
- risk level
- suggested read ranges

### `codebase_search`
Search for relevant areas using natural language or keywords.

This is a Phase 2+ capability once text-recall and ranking support are mature enough to justify a stable tool contract.

### `smart_read`
A fine-grained read tool to avoid whole-file reads.

This is a Phase 2 capability and should be implemented in the daemon rather than composed ad hoc in the extension.

Suggested input forms:
- path + symbol
- path + range
- caller/callee window
- class/function block

---

## Query response contract principles

All tool / query responses should be designed for **token efficiency**.

### Should return
- a small top-N candidate set
- path
- line range
- short reason
- one-line summary
- suggested next read

### Should avoid
- full AST dumps
- large raw code payloads
- overly long JSON
- unfiltered search dumps

---

## Tool result limits and deterministic ordering

To keep the implementation predictable for both users and agents, tool outputs must have explicit caps and stable ordering semantics.

### Default result caps

Unless otherwise configured, v1 should cap tool results as follows:
- `symbol_lookup`: at most **10 matches**
- `impact_analysis`: at most **10 impacted areas** and **5 suggested reads**
- `file_summary`: **1 primary summary** and at most **5 related files**
- `codebase_search` (Phase 2+): at most **10 candidates**
- `smart_read` (Phase 2+): at most **1 primary extracted region** plus bounded local context, capped at **300 lines or 24 KiB**, whichever comes first

If a result set is truncated, the response should expose that fact through metadata such as:
- `truncated: true`
- `returnedCount`
- `totalCount` when cheaply available

### Deterministic ordering

For the same query against the same committed generations, ordering should be deterministic.

Recommended tie-break precedence:
1. primary relevance score, descending
2. stronger match class (for example exact symbol match before fuzzy match)
3. higher-confidence analyzer result before lower-confidence fallback result
4. repository-relative path, lexicographically ascending
5. line range start, ascending

Deterministic ordering matters because the LLM should not see unstable candidate order for unchanged repository state.

## LLM-friendly retrieval principles

This proposal is not only about index strength; it is also about whether query results are **LLM-friendly**.

For an LLM, the most important properties are not “maximum data volume” but:
- a small, high-quality candidate set
- fixed and predictable result structure
- explicit relevance reasons
- explicit next-step reading suggestions

### What LLMs are good at
LLMs are relatively good at:
- reasoning over a small set of high-quality candidates
- choosing next steps from fixed-schema tool outputs
- using short summaries and relevance reasons to decide what matters
- gradually expanding context in multiple steps

### What LLMs are bad at
LLMs are relatively bad at:
- consuming very long, noisy search results
- manually extracting signal from large JSON / AST dumps
- reliably choosing the right few items from a very large candidate pool
- planning efficient exploration when no next-step guidance is provided

### Recommended LLM-friendly retrieval stack
The first version should prefer the following retrieval stack:

1. **structure-first retrieval**
   - use symbol tables, imports/exports, references, and call graphs as the primary recall mechanism

2. **bounded graph expansion**
   - impact analysis / related-files queries should use limited-depth, limited-cardinality, weighted traversal
   - the goal is to return only top results, not the full graph

3. **FTS + heuristic rerank**
   - natural language and fuzzy queries should first use full-text recall, then heuristic reranking
   - embeddings should not be the primary retrieval core in v1

4. **AST-based precise extraction**
   - `smart_read` should extract symbol / function / class blocks at the AST-node level
   - small local context windows may be attached when needed, instead of broad line slicing

### Recommended output contract for LLM-facing tools
Regardless of the underlying indexing algorithm, outputs exposed to the agent should use a small, stable schema.

Suggested per-candidate fields:
- `path`
- `symbol`
- `kind`
- `range`
- `summary`
- `reason`
- `suggestedNextRead`

Example:

```json
{
  "matches": [
    {
      "path": "src/checkout/workflow.ts",
      "symbol": "CheckoutWorkflow",
      "kind": "class",
      "range": { "start": 12, "end": 180 },
      "summary": "Owns checkout flow decisions and emits semantic effects.",
      "reason": "Exact symbol match and central workflow node.",
      "suggestedNextRead": [
        { "path": "src/checkout/workflow.ts", "start": 40, "end": 120 }
      ]
    }
  ]
}
```

### Anti-patterns
Even with a strong index, the following patterns are not LLM-friendly:
- returning large raw graph / AST dumps
- returning too many candidates at once
- returning whole files or many raw code blocks
- omitting `reason`, making trust and ranking harder to interpret
- omitting `suggestedNextRead`, forcing the model to plan exploration itself

### Design consequence
For this RFC, “LLM-friendly” means:
- **precise recall**
- **small result sets**
- **fixed schema**
- **explainable ranking**
- **support for two-step / three-step expansion**

This matters more than adopting the most complex indexing algorithm.

---

## Language support model

The **daemon core architecture should be language-agnostic**, but semantic analysis will not be.

The following can remain generic:
- repo registry
- watcher infrastructure
- incremental pipeline lifecycle
- query engine shell
- SQLite storage
- baseline/overlay merge
- `/index` command surface

However, symbol extraction, reference analysis, call graphs, and framework-aware summaries must be provided by language-specific analyzers.

Therefore, this proposal should not claim “equal-quality support for any language.” Instead, it should adopt a:

> **language-agnostic core + pluggable language analyzers**

### Support tiers

#### Tier 1: basic fallback support
For languages without a dedicated analyzer yet.

Suggested capabilities:
- file discovery
- path/text search
- basic file summary
- heuristic symbol extraction
- basic `smart_read` range/symbol extraction

Possible implementation:
- tree-sitter
- regex / heuristics
- FTS

This tier offers broad coverage, but references, call graphs, and impact analysis will have limited quality.

#### Tier 2: structural language support
For primary languages with dedicated parser / structural index support.

Suggested capabilities:
- more accurate symbol lookup
- imports/exports/references
- file/module summary
- more trustworthy `smart_read`
- basic impact analysis

Possible technology:
- TypeScript/JavaScript: TS compiler API / ts-morph
- Python: `ast` plus language-tool integration
- Go: `go/packages` / gopls-like integration
- Rust: rust-analyzer-like integration

#### Tier 3: semantic language support
For a small number of core languages where deeper semantic support is worth the investment.

Suggested capabilities:
- type-aware references
- semantic call graphs
- inheritance / implementation graphs
- framework-aware routing / test mapping
- higher-confidence impact analysis

This tier is usually only worth building for a team's primary languages.

### Recommended rollout

This RFC recommends:
- deep support for one or two primary languages in the MVP (for example TS/JS)
- Tier 1 fallback support for other languages
- gradual expansion into more Tier 2 / Tier 3 adapters over time

### Analyzer adapter interface

To support multiple languages, the semantic extraction layer should be designed as an adapter / plugin system. The daemon core should depend on standardized facts rather than any one language implementation.

Conceptual interface:

```ts
interface LanguageAdapter {
  languageId: string;
  matches(path: string): boolean;

  parseFile(path: string, content: string): Promise<ParsedFile>;
  extractSymbols(parsed: ParsedFile): SymbolFact[];
  extractEdges(parsed: ParsedFile): EdgeFact[];
  summarizeFile(parsed: ParsedFile): FileSummary;
  locateNode(parsed: ParsedFile, query: NodeQuery): SourceRange | null;
}
```

Suggested core fact types:
- `SymbolFact`
- `ReferenceFact`
- `ImportEdge`
- `CallEdge`
- `FileSummary`

This allows language support to expand without rewriting the daemon architecture.

### Tool quality signaling

Because analysis depth varies by language, tool responses should ideally carry a quality signal, for example:
- `analysisQuality: "basic" | "structural" | "semantic"`

This helps both the agent and the user interpret the confidence level of results, especially for `symbol_lookup` and `impact_analysis`.

### Design consequence

The language-support principles are:
- **language-agnostic core architecture**
- **language-specific semantic analysis**
- **adapter/plugin-based extensibility**
- **deep support for primary languages first, fallback support for the rest**

---

## Daemon internals

### Repo registry
Purpose: manage repository identity and avoid confusion across worktrees, symlinks, and equivalent paths.

Suggested key dimensions:
- canonical repo root
- gitdir / worktree identity
- git metadata
- config version

### File watcher
Suggested behavior:
- watch the git root
- ignore `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`
- debounce and batch events

### Incremental index pipeline
Suggested flow:
1. file changes enter a queue
2. determine language / file kind
3. compare hash / mtime
4. parse
5. extract symbols / imports / refs / call edges
6. update graph state
7. recompute affected summaries
8. update freshness state

### Query engine
In addition to low-level data access, provide high-level semantic APIs:
- `symbolLookup`
- `fileSummary`
- `impactAnalysis`
- `search`
- `smartRead`

### Summary/cache layer
The first version should prioritize:
- static summaries derived from AST / graph / heuristics

LLM-generated summaries may be added later, but should not be required in v1.

### Freshness/invalidation
Every query response should include freshness state:
- `ready`
- `indexing`
- `stale`
- `error`

Suggested metadata:
- `indexedAt`
- `headCommit`
- `filesPending`
- `overlayState`

---

## Scheduling, consistency, and resource budgets

### Priority classes

The daemon must schedule work in the following priority order:
1. interactive queries and `/index status` / `/index doctor`
2. save-triggered overlay updates for the active repository
3. initial baseline scans and large background backfills
4. maintenance tasks such as compaction, cleanup, and shared-baseline copy work

Scheduling rules:
- higher-priority work preempts lower-priority work
- lower-priority jobs must yield at file boundaries and within 250 ms when a higher-priority request arrives
- watcher events should debounce for 250 ms per path burst, with a maximum coalescing window of 2 seconds
- repeated saves to the same file should cancel superseded parse jobs instead of queueing every intermediate version

### Consistency model

The daemon must present queryable state using committed generations.

Rules:
- every successful index commit creates a new immutable generation
- queries read from exactly one committed baseline generation and one committed overlay generation selected at query start
- queries must never observe partially applied writes or mixed generations
- all SQLite writes that affect query-visible state must occur inside transactions
- partial availability is allowed, but it must be explicit in the response

### Partial availability and coverage metadata

When a repository is not fully indexed, query results must include:
- `freshness`
- `coverage.eligibleFiles`
- `coverage.indexedFiles`
- `coverage.indexedPercent`
- `provenance` (`local`, `shared-baseline`, or `merged`)
- `analysisQuality`

### State semantics

To avoid ambiguity, repository states mean:
- `disabled`: the repo is registered as off; no active watcher or indexing work is running
- `initializing`: repo registration succeeded, but core baseline structures are not yet broadly queryable
- `indexing`: the repo is queryable, but baseline or overlay backlog remains
- `ready`: current committed generations exist and no pending dirty files are older than 2 seconds
- `stale`: the daemon knows local filesystem or git state has changed, but freshness has not yet been re-established within the expected window
- `error`: the last indexing cycle failed and automatic background retries are paused pending recovery action

## Storage model

### Primary store: SQLite

SQLite is recommended because:
- it is sufficient for single-machine usage
- schema is clear and easy to inspect
- transactions and debugging are straightforward
- FTS5 can be added later
- it integrates well with a sidecar architecture

### Suggested tables
- `repos`
- `repo_snapshots`
- `files`
- `symbols`
- `references`
- `imports`
- `exports`
- `call_edges`
- `file_summaries`
- `symbol_summaries`
- `module_summaries`
- `dirty_files`
- `index_jobs`
- `index_errors`

Optional:
- `file_fts`

---

## Storage lifecycle, migrations, and recovery

### v1 storage layout

To avoid ambiguity, v1 should use:
- one immutable baseline SQLite DB per commit snapshot
- one mutable overlay SQLite DB per worktree ID

`worktreeId` should be derived from canonical repo root plus gitdir identity so that separate git worktrees do not share mutable overlay state.

### Retention policy

v1 should retain:
- the current HEAD baseline
- the most recent baseline for the repository default branch, if known
- up to 3 additional most-recently-used baselines

Older baselines should be evicted in LRU order once the per-repo storage budget is exceeded.

### Schema versioning

Each DB must store:
- `schemaVersion`
- `indexerVersion`
- `languageAdapterSet`
- `createdAt`

v1 should prefer rebuild over complex in-place migration:
- compatible minor changes may migrate in place
- incompatible schema changes should invalidate old caches and rebuild them
- downgrade compatibility is not required for cache DBs

### Integrity and corruption handling

- on open failure or suspected corruption, the daemon should run an integrity check
- corrupt DBs should be moved to a timestamped `quarantine/` directory and excluded from reads
- corrupt overlays should be rebuilt from local working-tree state
- corrupt baselines should be rebuilt from repository content or reacquired from a shared baseline source if available

### Cleanup behavior

- vacuum / compaction should run only as maintenance-priority work
- orphaned overlay DBs older than 7 days should be removed
- quarantined DBs may be deleted after 30 days

---

## Branch-aware indexing model

### Rejected approach
Do not store `index.db` in the git repository and track it with git.

Reasons:
- the index is a derived artifact, not source of truth
- binary DBs do not merge well
- working-tree truth is not fully represented by branch name alone

### Proposed approach
Store the index outside the repository in local cache and use:
- **commit-aware baseline**
- **working-tree overlay**

### Baseline
Represents a clean commit snapshot.

Suggested key dimensions:
- `repo_id`
- `commit_sha`
- `indexer_version`
- `config_hash`
- `toolchain_hash`

### Overlay
Represents local uncommitted changes.

Query rule:
- resolve against overlay first
- fall back to baseline for unaffected data

### Role of branch
Branch should be used for:
- warm-cache hints
- retention policy
- UI display
- recent snapshot management

Branch should not be the only index identity key. The stable base unit should be:
- commit SHA
- working-tree overlay state

### Suggested cache layout
```text
~/.cache/pi-index/
  repos/<repo-id>/
    baselines/<commit-sha>.db
    overlays/<worktree-id>.db
    metadata.json
```

`metadata.json` may track:
- branch -> most recent commit
- branch -> warm modules
- last active time
- indexer/config version

---

## Multi-repo process model

### Default
- one main daemon
- many repo runtimes
- multiple pi sessions on the same repo share the same runtime / index state

### Upgrade path
- large repos or high-isolation cases may use per-repo worker subprocesses

### Rejected default
- one always-on daemon process per repository

---

## Multi-client concurrency and git transition semantics

### Repo runtime identity

A repo runtime should be keyed by:
- canonical repo root
- worktree identity

This means:
- multiple pi sessions attached to the same worktree share one repo runtime
- separate git worktrees for the same underlying repository do not share mutable overlay state

### Multi-client concurrency rules

The daemon must support multiple concurrent clients safely.

Rules:
- exactly one watcher set and one indexing queue exist per repo runtime
- repeated `/index enable` on an already enabled repo is idempotent
- repeated `/index reindex` requests for the same repo should coalesce into one active rebuild job plus subscriber progress updates
- progress, state transitions, and diagnostics should fan out to all subscribed clients for that repo runtime
- interactive queries from any client preempt background work for that repo runtime

### Job cancellation and supersession

The daemon should distinguish:
- **superseded jobs**: older file-parse or summary jobs replaced by newer content for the same path
- **coalesced jobs**: duplicate repo-level rebuild requests
- **non-cancellable committed writes**: short transactional commits that must finish once started

### Git transition detection policy

Filesystem events alone are not sufficient to model repository state changes.

The daemon must also detect git transitions, including at least:
- `checkout` / `switch`
- `reset --hard`
- `merge`
- `rebase`
- `stash pop`
- file move / rename storms
- watcher overflow or dropped-event conditions

The daemon should re-check git state at minimum:
- when opening a repo runtime
- before starting a repo-level rebuild
- after large filesystem event bursts
- when a query arrives for a repo already marked suspicious or stale

### Transition handling rules

When the daemon detects a likely git transition or watcher overflow:
- mark the repo `stale` immediately
- keep the last committed generations queryable if they still satisfy repository-boundary rules
- schedule a bounded rescan or baseline refresh
- clear the `stale` state only after a new committed generation is available

Queries served while stale must expose stale freshness metadata explicitly.

## Team deployment model

### Recommended: local-first, shared-augmented

#### Local daemon handles
- current working-tree truth
- unstaged / staged changes
- branch-specific reality
- real-time incremental updates

#### Shared service handles
- baseline index
- team knowledge
- cross-repo intelligence
- heavy precompute

#### Integration rule
The pi extension should talk only to the local daemon. The local daemon decides whether to use a shared service.

Benefits:
- a single stable query contract for the agent
- local truth can override shared baseline data
- backend evolution does not require changing tool APIs

---

## Secure shared-index reuse and reconciliation

This RFC's primary architecture is local-first, but it should leave room for a future shared-baseline optimization model inspired by large-repo onboarding systems.

The core idea is:
- reuse an already-built baseline index when a repository is highly similar to an existing one
- allow fast time-to-first-query from that reused baseline
- reconcile differences against local truth in the background
- ensure the client never receives results for content it cannot prove it already has

### Hash-tree-based repository snapshots

For large repositories, simple `mtime` checks are often insufficient. A stronger evolution path is to represent repository state as a **content-hash tree** (Merkle-like snapshot structure):

- each file node stores a content hash
- each directory node stores a hash derived from its children
- the root hash summarizes the full repository snapshot

This enables:
- efficient subtree-level change detection
- precise divergence detection between local and remote baselines
- incremental sync / reconciliation without rescanning the entire repo

This mechanism is not required for the MVP, but it is a strong candidate for large-repo optimization and shared-baseline sync.

### Content-addressed unit caching

The system should support **content-addressed caching** below the file level.

Possible cache units:
- syntax chunks
- symbol bodies
- functions/classes
- summary units

Suggested cache key inputs:
- normalized unit content
- analyzer version
- language adapter version
- summary/indexing mode

This allows unchanged structural units to avoid recomputation, which is useful for:
- summary regeneration
- future embedding generation
- semantic extraction
- partial reindexing in large files

### Reusable baseline selection via similarity fingerprints

A future shared service may support **repository-level baseline reuse**.

Conceptually:
- the client computes a repository similarity fingerprint
- the shared service searches for an existing similar baseline
- if similarity exceeds a threshold, that baseline becomes the initial reusable baseline

Possible fingerprint inputs include:
- file-hash summaries
- simhash-like repository fingerprints
- subtree-hash statistics

This should be treated as a Phase 3+ capability, not an MVP requirement.

### Fast time-to-first-query via background reconciliation

A key UX principle for large repositories is:

> usable early queries are often more important than full correctness-before-first-use, as long as results are clearly labeled and reconciled quickly.

That implies the system may:
- start from a reusable baseline
- allow early query handling immediately
- reconcile local differences in the background
- improve result freshness and confidence over time

When this happens, tool responses should ideally expose metadata such as:
- freshness
- provenance (`local`, `shared-baseline`, `merged`)
- `analysisQuality`

### Proof-based filtering for shared results

If shared baseline reuse is introduced, it must preserve strict content isolation.

Principle:
- a client must only receive results for content it can prove is already present locally

A candidate mechanism is **content-hash proof filtering**:
- the client provides a hash-based snapshot of locally present content
- shared-search results are filtered against that proof set
- any result not provably backed by local content is dropped

This keeps shared-index reuse from leaking teammate-only or unavailable code.

### Scope and recommendation

The ideas in this section are recommended as **future shared-augmentation design directions**, especially for very large repos and team onboarding flows.

They should not block the MVP. The MVP should still focus on:
- local structural indexing
- local baseline + overlay correctness
- LLM-friendly query outputs

---

## Alternatives considered

### Alternative A: put all indexing inside the pi extension
**Rejected**.

Reasons:
- indexing stops when pi stops
- watcher / parser lifecycle becomes awkward
- interactive performance degrades
- extensions are not a good place for a heavy long-lived runtime

### Alternative B: one dedicated daemon per repo by default
**Rejected as the default**.

Reasons:
- wastes resources
- creates heavier lifecycle management
- makes sharing index state across multiple sessions harder
- duplicates watchers, DB handles, and schedulers

### Alternative C: team-shared daemon as the primary runtime
**Rejected as the primary model**.

Reasons:
- cannot reliably see each developer's working-tree truth
- branch, dirty state, and local codegen vary per machine
- increases auth, network, and reliability complexity

### Alternative D: commit the index DB into git
**Rejected**.

Reasons:
- index is derived data
- binary merge behavior is poor
- working-tree representation is incomplete
- it pollutes the repository

### Alternative E: start with embeddings / full semantic RAG
**Deferred**.

Reasons:
- most high-value v1 tasks can be solved with structural indexing
- embeddings increase infra complexity and ranking unpredictability

---

## Risks and trade-offs

### 1. A local daemon increases system complexity
It requires management of:
- IPC
- process lifecycle
- watchers
- DB migrations
- cache invalidation

### 2. Index freshness is a first-class risk
If baseline / overlay management is wrong, the daemon can return stale or misleading results.

### 3. Multi-language support expands scope quickly
v1 should focus on a small number of languages; otherwise parser complexity will dominate the project.

### 4. Poor tool output design can still waste tokens
Even with a good index, large or noisy query responses will degrade LLM performance.

### 5. A future shared service adds trust / auth / privacy concerns
This does not block the local-first core, but it does increase operational complexity.

---

## Logging and privacy policy

The MVP must treat logs and diagnostics as operational metadata, not as a secondary source-code storage channel.

### Default logging rules

By default, the daemon must not persist raw source content in logs, diagnostics, or crash artifacts.

Allowed by default:
- repository-relative paths
- hashes
- counts and sizes
- queue state
- analyzer names and capability levels
- exception types, messages, and stack traces
- line-range metadata without surrounding source text

Disallowed by default:
- whole-file source content
- long raw code snippets
- secret-like file contents
- full tool query payloads containing large text bodies

### Crash and diagnostic artifact rules

Crash and quarantine artifacts should contain only the minimum data required for local recovery. If an analyzer needs sample input for debugging, that behavior must be behind an explicit developer-only opt-in.

### Telemetry policy

Any future telemetry or remote crash-upload feature should be treated as out of scope for the MVP and must be explicit opt-in.

### Operator visibility policy

`/index doctor` should surface operational state, not raw content. If future verbose diagnostics are added, they should remain local-only and off by default.

## Diagnostics and recovery

The MVP must include a first-class diagnostic and recovery path. Users should not need to inspect SQLite files manually to recover from normal failures.

### `/index doctor`

`/index doctor` should be part of the MVP command surface.

It should report at least:
- daemon running state
- daemon version and protocol version
- transport path
- repo ID, repo root, and worktree ID
- current repo state, freshness, and coverage
- active analyzer set and per-tool capability level
- queue depth and active jobs
- storage usage (baseline count, overlay size)
- last successful index timestamp
- last error and recommended next action

### Log and artifact locations

The daemon should write:
- user-level daemon logs under `~/.cache/pi-index/logs/`
- per-repo diagnostics under `~/.cache/pi-index/repos/<repo-id>/diagnostics/`
- quarantined DBs and crash artifacts under `~/.cache/pi-index/quarantine/`

### Automatic recovery policy

The daemon and extension should automatically handle the following:
- lost daemon connection -> retry once, then offer daemon restart
- incompatible cache schema -> invalidate incompatible DBs and rebuild
- overlay read failure -> rebuild overlay from local state
- repeated single-file analyzer crash -> omit the file, record a diagnostic, continue indexing the rest of the repo
- repeated repo-level failure -> move the repo to `error` and pause background retries until operator action

### Manual recovery path

The supported operator path is:
1. run `/index doctor`
2. if advised, run `/index reindex`
3. if the repo should stop indexing, run `/index disable`
4. if a future purge command is available, use `/index disable --purge` as a last resort

---

## Rollout plan

### Phase 0: design and contracts
- define extension / daemon boundaries
- define the minimal IPC contract
- define query response shapes
- define baseline / overlay behavior

### Phase 1: MVP

#### Daemon
- Node.js / TypeScript
- Unix domain socket on POSIX platforms; local HTTP is not a default MVP transport
- SQLite
- chokidar watcher
- initial structural indexing for TS/JS
- non-TS/JS files may participate only in file discovery, safety filtering, and coarse file-summary behavior in v1; structural retrieval is not guaranteed outside supported analyzers

#### Extension
- `/index`
- `/index enable`
- `/index disable`
- `/index status`
- `/index doctor`
- footer status
- `symbol_lookup`
- `file_summary`
- `impact_analysis`

#### First API set
- `health`
- `openRepo`
- `enableRepoIndexing`
- `disableRepoIndexing`
- `getStatus`
- `getRepoDiagnostics`
- `reindexRepo`
- `symbolLookup`
- `fileSummary`
- `impactAnalysis`

### Phase 2: local quality improvements
- more mature incremental overlay behavior
- `smart_read`
- test mapping
- branch-aware warm-cache policy
- improved freshness signaling
- content-addressed caching for structural units

### Phase 3: shared augmentation
- shared baseline fallback
- ownership / architecture metadata
- cross-repo graph
- PR / commit intelligence
- reusable baseline selection via similarity fingerprints
- background reconciliation from shared baselines
- proof-based filtering for shared results

### Phase 4: optional advanced retrieval
- embeddings
- reranking
- semantic search
- heavy precompute policies
- hash-tree-based snapshot sync for large repositories

---

## Deferred post-MVP questions

1. If a shared service is added later, which metadata should come from CI?
2. For a future native-binary daemon, should first-use bootstrap download artifacts automatically, or should packages pre-bundle per-platform binaries?
3. For future shared baseline reuse, which similarity-fingerprint strategy should be preferred: simhash-like repository fingerprints, subtree-hash statistics, or another scheme?

---

## Recommendation

This RFC recommends the following overall approach:

- **pi extension as a thin client**
- **local sidecar daemon as the primary runtime**
- **SQLite as the local index store**
- **high-level query APIs before broad raw file reads**
- **commit-aware baseline + working-tree overlay**
- **local-first, shared-augmented deployment**
- **unified `pi install` packaging with extension-managed daemon bootstrap and lazy-start**

---

## One-sentence conclusion

> The most practical path is to let a thin pi extension connect to a local sidecar daemon, with the daemon maintaining a commit-aware baseline plus working-tree overlay in SQLite and serving high-level, low-token, on-demand retrieval to the agent, while any team-shared service remains only a supporting baseline and heavy-precompute layer.
