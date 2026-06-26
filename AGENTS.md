# AGENTS.md

## Purpose

This repository builds `@linimin/pi-code-index`.
It is a local-first code indexing package for pi, with a thin extension and a background daemon.

## Primary documents

Implementation priority:

1. `docs/mvp-spec.md` — **normative for Phase 1 implementation**
2. task-specific instructions
3. existing code structure
4. `docs/rfc.md` — rationale and future direction only

If `docs/mvp-spec.md` and `docs/rfc.md` differ, **follow `docs/mvp-spec.md` for MVP work**.

## Phase 1 guardrails

For MVP work:

- support **macOS + Linux on local POSIX filesystems** only
- use **Unix domain socket** transport
- build **one user-scoped daemon** with many repo runtimes
- use **SQLite** for storage
- use **one immutable baseline DB per commit**
- use **one mutable overlay DB per worktree**
- support **TS/JS structural analyzers** as the only primary analyzers
- keep non-primary languages at **coarse/fallback behavior only**
- expose only these agent tools:
  - `symbol_lookup`
  - `file_summary`
  - `impact_analysis`
- expose these commands:
  - `/index`
  - `/index enable`
  - `/index disable`
  - `/index status`
  - `/index reindex`
  - `/index doctor`

## Do not implement yet unless explicitly requested

The following are **not MVP** and should not be implemented opportunistically:

- `smart_read`
- `codebase_search`
- embeddings / reranking / semantic search
- shared baseline reuse
- proof-based filtering for shared results
- hash-tree snapshot sync
- Windows-native runtime support
- local HTTP as the default transport
- manual daemon installation as the primary user path

## Implementation style

- keep the extension thin
- keep daemon/runtime boundaries explicit
- prefer simple, explicit modules over premature abstraction
- keep outputs deterministic
- preserve explicit safety boundaries for repo/file eligibility
- do not add prompt stuffing; prefer query-first retrieval

## Validation expectations

When implementing a slice, prefer changes that can be validated by:

- typechecking
- small unit or integration tests
- explicit command behavior verification
- deterministic output assertions

## Repo layout expectations

- `extensions/` is the pi package entrypoint surface
- `src/extension/` contains pi-side integration
- `src/daemon/` contains background runtime code
- `src/shared/` contains protocol and shared types
- `docs/` contains spec documents
