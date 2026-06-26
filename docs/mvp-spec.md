# pi-code-index MVP spec

## Status

Draft

## Relationship to the RFC

This document is the **implementation-facing MVP specification** derived from:

- `docs/rfc.md`

The RFC remains the full design and rationale document.
This spec is the **normative source for Phase 1 (MVP) implementation decisions**.

If this document conflicts with exploratory or future-looking language in the RFC, **this MVP spec wins for Phase 1 implementation**.

---

## 1. Purpose

The MVP provides local, low-token, working-tree-aware codebase indexing for pi.

It must allow the agent to prefer structured lookup over broad raw file exploration by providing:

- `symbol_lookup`
- `file_summary`
- `impact_analysis`
- `/index` operational controls
- `/index doctor` diagnostics

The MVP is intentionally **local-first**, **single-user**, and **structural-index-first**.

---

## 2. MVP decisions summary

The following decisions are fixed for the MVP.

| Topic | MVP decision |
|---|---|
| Installation entry point | `pi install` installs the package |
| Runtime model | thin pi extension + separate local daemon |
| Daemon ownership | extension-managed bootstrap and lazy-start |
| Official platforms | macOS and Linux on local POSIX filesystems |
| Default transport | Unix domain socket |
| Daemon exposure | local-only, same-user only |
| Process topology | one user-scoped daemon, many repo runtimes |
| Repo scope | git repositories only |
| Repo identity | canonical repo root + worktree identity |
| Index storage | SQLite |
| Baseline model | one immutable baseline DB per commit |
| Overlay model | one mutable overlay DB per worktree |
| Primary analyzer scope | TypeScript/JavaScript structural indexing |
| Non-primary languages | discovery + safety filtering + coarse file summary only |
| MVP commands | `/index`, `/index enable`, `/index disable`, `/index status`, `/index reindex`, `/index doctor` |
| MVP agent tools | `symbol_lookup`, `file_summary`, `impact_analysis` |
| Deferred tools | `smart_read`, `codebase_search` |
| Shared service | not required for MVP |
| Embeddings / RAG | not part of MVP |
| Prompt strategy | query-first, not prompt-stuffing |
| Secrets policy | sensitive files excluded by default |
| Diagnostics | `/index doctor` is required in MVP |

---

## 3. Explicit MVP scope

## In scope

- local daemon runtime
- one package installed through `pi install`
- extension-managed daemon lazy-start
- repository registration and background indexing
- TS/JS structural indexing
- baseline + overlay query model
- SQLite-backed storage
- deterministic tool outputs with explicit caps
- diagnostics and recovery path

## Out of scope

- Windows-native runtime support
- remote/shared indexing as a dependency for correctness
- embeddings, semantic search, reranking
- `smart_read`
- `codebase_search`
- per-package sub-index orchestration inside a monorepo
- nested-repo recursive indexing
- symlink target indexing
- telemetry or remote crash upload
- manual daemon installation as the default user path

---

## 4. Platform and environment support

## 4.1 Supported platforms

The MVP **must** officially support:

- macOS on local POSIX filesystems
- Linux on local POSIX filesystems

The MVP treats the following as out of scope or best-effort only:

- Windows-native runtime
- WSL-specific guarantees
- network filesystems such as NFS and SMB
- cloud-synced directories with delayed or synthetic fs events
- container bind-mount environments as a primary support target

## 4.2 Filesystem assumptions

The MVP assumes:

- reliable local filesystem event delivery
- stable canonical absolute paths
- predominantly text-based repository contents

If these assumptions fail, correctness takes priority over freshness.
The daemon may mark the repo stale and trigger bounded rescans.

## 4.3 Path, encoding, and hashing rules

These rules are normative:

- content hashes are computed from **raw file bytes**
- textual analysis should prefer **UTF-8 decoding**
- files that fail text-decoding heuristics may be skipped or treated as non-text
- query-visible paths are **repository-relative**
- internal identity should preserve both canonical absolute paths and git-relative paths
- case-only rename behavior on case-insensitive filesystems is best-effort in MVP and may require a bounded rescan

---

## 5. Packaging and installation model

## 5.1 User-facing install model

The MVP **must** use `pi install` as the primary install entry point.

Expected user flow:

```bash
pi install npm:your-indexing-package
```

From the user's perspective, this installs one feature: background indexing support for pi.

## 5.2 Runtime separation

Even though install UX is unified, the daemon remains a separate runtime with its own:

- process lifecycle
- socket/IPC boundary
- SQLite/cache state
- health/version reporting

## 5.3 Delivery model

For MVP, the daemon is assumed to be **Node.js / TypeScript based** and shipped inside the package runtime.

That means:

- the package includes extension + daemon code
- the extension or launcher can spawn the daemon locally
- native-binary packaging is deferred beyond MVP

## 5.4 Lazy-start behavior

After install:

- the extension is available
- the daemon runtime is available
- no repos are indexed by default
- the daemon may remain stopped until first use

When the user runs `/index enable`:

1. extension verifies daemon availability
2. extension starts the daemon if needed
3. extension performs version/protocol checks
4. extension registers the repo and enables indexing

---

## 6. Process model and IPC

## 6.1 Daemon topology

The MVP uses:

- **one user-scoped daemon**
- **many repo runtimes** managed inside that daemon

There must not be one always-on daemon per repository by default.

## 6.2 Transport

The MVP **must** use a Unix domain socket on POSIX platforms.

Local HTTP is **not** a default MVP transport.

The daemon must not bind to non-loopback network interfaces.

## 6.3 User-scope isolation

Runtime files should live under a user-private directory, for example:

- `~/.cache/pi-index/`

Recommended permissions:

- runtime parent directory: `0700`
- socket / lock / pid files: same-user only

The MVP may assume all clients run as the same local user.

## 6.4 Singleton rules

The daemon **must** behave as a singleton per user:

- at most one process owns the active socket
- startup must use a lock file or equivalent guard
- concurrent startup attempts must converge to one daemon process

## 6.5 Stale socket / lock handling

On connect failure or startup:

1. detect whether the socket path exists
2. determine whether a live daemon still owns it
3. remove stale socket/lock artifacts only when ownership is clearly dead
4. retry connect/start once before surfacing an error

## 6.6 Handshake contract

Every connection must perform a handshake returning at least:

- daemon version
- protocol version
- daemon PID
- daemon start time or instance ID
- supported capabilities

The extension **must refuse** normal operation if protocol compatibility fails.

---

## 7. Repository eligibility and safety policy

## 7.1 Repository boundary

A repo is eligible for indexing only if cwd is inside a git repository.

The boundary is the canonical git top-level from:

```bash
git rev-parse --show-toplevel
```

If cwd is not inside a git repository, `/index enable` must refuse to enable indexing.

## 7.2 Nested repos and submodules

In MVP:

- nested git repositories are separate repositories
- git submodules are separate repositories
- parent repo runtimes do not recursively index them

## 7.3 File discovery source of truth

Eligible candidate paths must be discovered in this order:

1. tracked files
2. modified tracked files in the working tree
3. untracked but non-ignored files from git ignore-aware discovery

The daemon must not walk arbitrary parent directories outside the repo root.

## 7.4 Filtering precedence

Highest to lowest precedence:

1. hard safety boundaries
2. user-local explicit overrides
3. repo-local indexing config
4. built-in default include/exclude rules
5. VCS ignore rules for untracked files

Repo-local config may widen built-in defaults, but may not override hard safety boundaries.
Sensitive-file opt-in must be user-local only.

## 7.5 Hard safety boundaries

The daemon must never:

- read content outside the canonical repo root
- follow symlinks for content indexing in MVP
- index devices, sockets, FIFOs, or other special files
- recurse into nested repos or submodules from the parent runtime

Symlinks may be recorded as path metadata only.
Their target contents are not indexed in MVP.

## 7.6 Default excludes

By default, MVP should exclude at least:

- `.git/`
- `node_modules/`
- `dist/`
- `build/`
- `.next/`
- `coverage/`
- `vendor/`
- `target/`
- `.venv/`

## 7.7 Sensitive-file denylist

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

These may only be included through explicit user-local configuration.

## 7.8 Binary and large-file policy

- binary files must be skipped
- files larger than **2 MiB** must be skipped by default in MVP
- skipped files must appear as omitted in diagnostics/coverage metadata

A file may be considered binary if it contains NUL bytes in the first 8 KiB or fails text-decoding heuristics.

## 7.9 `.gitignore` behavior

- `.gitignore` applies only to untracked files
- tracked files remain eligible unless excluded by safety rules or explicit config

---

## 8. Repository runtime model

## 8.1 Repo runtime identity

A repo runtime is keyed by:

- canonical repo root
- worktree identity

This means:

- multiple pi sessions in the same worktree share one runtime
- separate git worktrees do not share mutable overlay state

## 8.2 Repository states

The daemon/extension layer must expose these states:

- `disabled`
- `initializing`
- `indexing`
- `ready`
- `stale`
- `error`

State meanings:

- `disabled`: repo indexing is off; no active watcher or indexing work
- `initializing`: repo registration succeeded, but the repo is not yet broadly queryable
- `indexing`: repo is queryable, but baseline or overlay backlog remains
- `ready`: committed generations exist and no pending dirty files are older than 2 seconds
- `stale`: daemon knows fs/git state changed and freshness is not yet re-established
- `error`: last indexing cycle failed and automatic background retries are paused

## 8.3 State transitions

- `/index enable`: `disabled -> initializing`, `error -> initializing`
- `/index disable`: `initializing|indexing|ready|stale|error -> disabled`
- `/index reindex`: `ready|stale|error -> indexing`

## 8.4 Multi-client concurrency

Rules:

- exactly one watcher set and one indexing queue exist per repo runtime
- repeated `/index enable` is idempotent
- repeated `/index reindex` coalesces into one rebuild job
- progress/state/diagnostics fan out to all subscribed clients
- interactive queries preempt background work

## 8.5 Job semantics

The daemon must distinguish:

- **superseded jobs**: older file jobs replaced by newer content for the same path
- **coalesced jobs**: duplicate repo-level rebuild requests
- **non-cancellable committed writes**: short transactional commits that must finish once started

---

## 9. Git transition detection semantics

Filesystem events alone are insufficient.

The daemon must detect at least:

- `checkout` / `switch`
- `reset --hard`
- `merge`
- `rebase`
- `stash pop`
- file rename storms
- watcher overflow / dropped-event conditions

The daemon should re-check git state at minimum:

- when opening a repo runtime
- before repo-level rebuilds
- after large fs event bursts
- when a query arrives for a repo already marked stale or suspicious

When a likely git transition or watcher overflow is detected:

- mark the repo `stale` immediately
- keep last committed generations queryable if still safe
- schedule a bounded rescan or baseline refresh
- clear `stale` only after a new committed generation is available

Queries served while stale must expose stale freshness metadata.

---

## 10. Indexing model

## 10.1 Baseline + overlay

The MVP uses:

- **one immutable baseline SQLite DB per commit snapshot**
- **one mutable overlay SQLite DB per worktree**

`worktreeId` must be derived from canonical repo root plus gitdir/worktree identity.

## 10.2 Query rule

All queries resolve as:

1. read overlay first
2. overlay data overrides baseline for affected entities
3. baseline fills unaffected data

## 10.3 Branch semantics

Branch name is not the primary identity key.

Branch is used only for:

- warm-cache hints
- retention policy
- UI display
- recent snapshot bookkeeping

Primary identity is:

- commit SHA
- working-tree overlay state

---

## 11. Language support

## 11.1 Primary analyzer support in MVP

MVP primary structural analyzers are:

- TypeScript
- JavaScript

These languages should support:

- structural symbol lookup
- import/export/reference extraction
- file/module summary
- basic impact analysis

## 11.2 Non-primary language behavior in MVP

For non-primary languages, MVP guarantees only:

- file discovery
- safety filtering
- coarse file summary behavior

No structural or semantic retrieval quality is guaranteed outside supported analyzers.

## 11.3 Tool quality signaling

Tool results should include:

- `analysisQuality: "basic" | "structural" | "semantic"`

For MVP, typical values are:

- TS/JS structural results: `structural`
- fallback file-summary behavior: `basic`

---

## 12. Command surface

The extension must expose:

- `/index`
- `/index enable`
- `/index disable`
- `/index status`
- `/index reindex`
- `/index doctor`

## 12.1 `/index`

With no arguments, show a short summary of indexing status and available actions for the current repo.

## 12.2 `/index enable`

Behavior:

1. verify cwd is inside a git repo
2. connect to or lazy-start the daemon
3. verify protocol compatibility
4. if repo is untrusted, allow safe-default enable while ignoring repo-local indexing config
5. register repo with smart defaults
6. start initial indexing

## 12.3 `/index disable`

Behavior:

- stop watcher and background updates for the repo
- mark the repo disabled
- preserve cache by default

`/index disable --purge` is **not part of MVP**.

## 12.4 `/index status`

Must report at least:

- repo name/path
- enabled/disabled
- state
- mode
- indexed files
- last updated
- HEAD baseline
- overlay pending files
- last error if present

## 12.5 `/index reindex`

MVP semantics:

- soft rebuild only
- retain repo registration
- rebuild baseline structures
- update status/progress

## 12.6 `/index doctor`

Must report at least:

- daemon running state
- daemon version and protocol version
- transport path
- repo ID, root, and worktree ID
- repo state, freshness, and coverage
- analyzer set and per-tool capability level
- queue depth and active jobs
- storage usage
- last successful index timestamp
- last error and recommended next action

---

## 13. Agent tool surface

The extension should only activate indexing tools when:

- cwd is inside a git repo
- indexing is enabled for that repo
- the daemon is healthy enough to answer queries

### MVP tools

- `symbol_lookup`
- `file_summary`
- `impact_analysis`

### Deferred tools

- `smart_read` (Phase 2)
- `codebase_search` (Phase 2+)

## 13.1 `symbol_lookup`

Required output fields:

- `symbol`
- `kind`
- `path`
- `range`
- `summary`
- `reason`
- `suggestedNextRead`
- `analysisQuality`
- `freshness`

## 13.2 `file_summary`

Required output fields:

- `path`
- `summary`
- `mainExports` or equivalent top-level entities when available
- `importantRanges`
- `relatedFiles`
- `analysisQuality`
- `freshness`

## 13.3 `impact_analysis`

Required output fields:

- `target`
- `areas`
- `reason`
- `risk`
- `suggestedNextRead`
- `analysisQuality`
- `freshness`

---

## 14. Tool result limits and deterministic ordering

Default caps:

- `symbol_lookup`: max **10 matches**
- `impact_analysis`: max **10 areas** and **5 suggested reads**
- `file_summary`: **1 primary summary** and max **5 related files**

If a result is truncated, expose:

- `truncated: true`
- `returnedCount`
- `totalCount` when cheaply available

For the same query against the same committed generations, ordering must be deterministic.

Tie-break order:

1. primary relevance score, descending
2. stronger match class before weaker match class
3. higher-confidence analyzer result before fallback result
4. repository-relative path ascending
5. line range start ascending

---

## 15. Scheduling, consistency, and partial availability

## 15.1 Priority classes

Priority order:

1. interactive queries and `/index status` / `/index doctor`
2. save-triggered overlay updates for the active repo
3. initial baseline scans and large background backfills
4. maintenance work such as compaction and cleanup

Scheduling rules:

- high-priority work preempts low-priority work
- low-priority jobs must yield at file boundaries and within 250 ms when preempted
- watcher events debounce for 250 ms per burst, max 2 seconds coalescing
- repeated saves should cancel superseded file jobs

## 15.2 Consistency model

Rules:

- every successful index commit creates a new immutable generation
- queries read from exactly one committed baseline generation and one committed overlay generation selected at query start
- queries must never observe partially applied writes or mixed generations
- all query-visible SQLite writes must be transactional
- partial availability is allowed only when explicitly labeled

## 15.3 Coverage metadata

When a repo is not fully indexed, query responses must include:

- `freshness`
- `coverage.eligibleFiles`
- `coverage.indexedFiles`
- `coverage.indexedPercent`
- `provenance` (`local`, `shared-baseline`, or `merged`; MVP will typically use `local`)
- `analysisQuality`

---

## 16. Performance and resource targets

These are MVP operational targets.

### 16.1 Repository size classes

- **small**: up to 2,000 eligible files or 100 MiB eligible text
- **medium**: up to 20,000 eligible files or 1 GiB eligible text
- **large**: above medium

### 16.2 User-visible latency targets (p95)

- daemon connect/lazy-start for daemon-dependent command: **<= 2 s**
- `/index status`: **<= 300 ms** once daemon reachable
- warm `symbol_lookup` / `file_summary`: **<= 500 ms**
- warm `impact_analysis`: **<= 1.5 s**

After `/index enable`:

- small repo: first usable query results within **10 s**
- medium repo: within **60 s**
- large repo without shared baseline reuse: partial queryability within **120 s**

Save-triggered local updates:

- supported structural analyzer, single changed file up to 2,000 lines: **<= 2 s p95**
- fallback analyzer path, single changed file up to 2,000 lines: **<= 5 s p95**

### 16.3 Resource budgets

Defaults:

- background parser concurrency: **2 jobs per repo runtime**
- global background parser concurrency: **4 jobs max**
- background work yields to interactive queries within **250 ms**
- soft memory target: **1 GiB per active repo runtime**
- fail-safe memory ceiling: **2 GiB per active repo runtime**
- per-repo storage budget: **min(2 GiB, 20% of eligible text bytes)**

---

## 17. Storage, migration, and cleanup

## 17.1 Storage model

Use SQLite.

Suggested DB categories in MVP:

- immutable baseline DBs by commit
- mutable overlay DBs by worktree

## 17.2 Required metadata per DB

Each DB must store:

- `schemaVersion`
- `indexerVersion`
- `languageAdapterSet`
- `createdAt`

## 17.3 Migration rule

MVP prefers rebuild over complex migration:

- compatible minor changes may migrate in place
- incompatible schema changes invalidate cache and rebuild
- downgrade compatibility is not required

## 17.4 Retention policy

Retain:

- current HEAD baseline
- most recent baseline for default branch if known
- up to 3 additional most-recently-used baselines

Evict older baselines in LRU order once storage budget is exceeded.

## 17.5 Corruption handling

- run integrity checks on open failure or suspected corruption
- move corrupt DBs to timestamped quarantine
- rebuild corrupt overlays from local state
- rebuild corrupt baselines from repo content

## 17.6 Cleanup

- vacuum/compaction runs only as maintenance-priority work
- orphaned overlays older than 7 days are removed
- quarantined DBs may be deleted after 30 days

---

## 18. Logging, diagnostics, and privacy

## 18.1 Logging policy

Logs and diagnostics are operational metadata, not a secondary source-code store.

Allowed by default:

- repository-relative paths
- hashes
- counts and sizes
- queue state
- analyzer names/capability levels
- exception types, messages, and stack traces
- line-range metadata without surrounding source

Disallowed by default:

- whole-file source content
- long raw code snippets
- secret-like file contents
- full tool query payloads with large text bodies

## 18.2 Artifact locations

Recommended locations:

- daemon logs: `~/.cache/pi-index/logs/`
- per-repo diagnostics: `~/.cache/pi-index/repos/<repo-id>/diagnostics/`
- quarantine/crash artifacts: `~/.cache/pi-index/quarantine/`

## 18.3 Automatic recovery

The daemon/extension should automatically handle:

- lost daemon connection -> retry once, then offer daemon restart
- incompatible cache schema -> invalidate and rebuild
- overlay read failure -> rebuild overlay
- repeated single-file analyzer crash -> omit file, record diagnostic, continue
- repeated repo-level failure -> move repo to `error` and pause background retries

## 18.4 Manual recovery path

Operator path:

1. run `/index doctor`
2. if advised, run `/index reindex`
3. if indexing should stop, run `/index disable`

---

## 19. Minimal daemon API surface

The MVP daemon must expose at least these methods:

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

This spec does not yet lock the exact wire format, but all method contracts must respect the constraints in this document.

---

## 20. Deferred beyond MVP

Deferred items include:

- `smart_read`
- `codebase_search`
- local HTTP transport
- Windows-native runtime support
- shared baseline reuse
- similarity fingerprints
- proof-based filtering for shared results
- embeddings / reranking / semantic search
- native-binary packaging as a primary delivery model

---

## 21. Implementation checklist

Before coding starts, the implementation plan should produce:

- IPC wire format draft
- daemon bootstrap/launcher design
- SQLite schema draft
- repo runtime state machine
- TS/JS analyzer fact model
- command behavior tests
- repo boundary and sensitive-file exclusion tests
- baseline/overlay merge tests
- stale transition and watcher overflow tests
- `/index doctor` output contract

---

## One-sentence summary

The MVP is a local-first, POSIX-only, extension-managed background indexing system for pi, built around a single user-scoped daemon, SQLite baseline/overlay storage, TS/JS structural analyzers, deterministic low-token query tools, and explicit operational diagnostics.