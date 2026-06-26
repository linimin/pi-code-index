# @linimin/pi-code-index

`@linimin/pi-code-index` is a local-only Phase 1 code index for pi. It keeps the pi extension thin, runs indexing and queries in a same-user local daemon over a Unix domain socket, and stores repository facts in SQLite baseline and overlay databases under the user's cache directory.

## Shipped Phase 1 surface

### Agent tools

Only these Phase 1 tools are exposed:

- `symbol_lookup`
- `file_summary`
- `impact_analysis`

They activate only when the current `cwd` is inside an enabled, healthy Git repository. If the repo is not indexed yet, disabled, outside Git, or in an error state, the tools stay inactive until the operator recovers the repo.

### Commands

- `/index` or `/index status` — show current repo indexing status
- `/index enable` — register the current Git repo, lazy-start the daemon if needed, and queue indexing
- `/index reindex` — request a soft rebuild after local changes
- `/index doctor` — inspect daemon transport, protocol, repo identity, freshness, coverage, and storage
- `/index disable` — stop repo indexing while preserving cache by default

## Architecture

Phase 1 intentionally stays local-only:

- **Thin pi extension**: registers `/index` and the three approved tools
- **Local daemon**: same-user singleton on a Unix domain socket
- **SQLite storage**: one immutable baseline DB per commit plus one mutable overlay DB per worktree
- **No RFC-only features yet**: no `smart_read`, `codebase_search`, embeddings, or shared-baseline reuse

## Query behavior

Tool responses include Phase 1 metadata so the agent can reason about partial availability:

- `freshness`
- `coverage` (`eligibleFiles`, `indexedFiles`, `indexedPercent`, `omittedFiles`)
- `provenance` (`local` in MVP)
- `analysisQuality` (`structural` for TS/JS, `basic` for fallback summaries)

Default result caps:

- `symbol_lookup`: up to 10 matches
- `file_summary`: 1 primary summary and up to 5 related files
- `impact_analysis`: up to 10 impacted areas and up to 5 suggested reads

When a result is truncated, the response includes deterministic truncation metadata such as returned counts and total counts when cheaply available.

## Operator workflow

1. Run `/index enable` inside a Git repo.
2. Wait for `/index status` or `/index doctor` to show the repo becoming queryable.
3. Use `symbol_lookup`, `file_summary`, and `impact_analysis` for structured local queries.
4. If freshness drops after changes, run `/index reindex`.
5. If the daemon or repo enters an error state, run `/index doctor` first, fix the reported issue, then retry `/index enable` or `/index reindex`.
6. Use `/index disable` to stop indexing without purging cache.

## Development

```bash
npm install
npm run check
npm test
```

## Repository layout

```text
extensions/          pi package extension entrypoint
src/extension/       thin pi extension and tool registration
src/daemon/          local daemon, indexing pipeline, SQLite storage, query handling
src/shared/          daemon/extension protocol types
tests/               deterministic command and tool coverage
docs/                MVP spec and RFC context
```

## Docs

- `docs/mvp-spec.md` — normative Phase 1 spec
- `docs/rfc.md` — design rationale and future phases
- `docs/analyzer-plugin-system.md` — normative implementation plan for future analyzer plugin work when explicitly requested
- `AGENTS.md` — repo guardrails for coding agents
