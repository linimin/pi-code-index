# @linimin/pi-code-index

Local-first code indexing for pi.

This repository contains the package skeleton for publishing `@linimin/pi-code-index` to npm as a pi package.
The intended architecture is:

- a **thin pi extension**
- a **local background daemon**
- **SQLite-backed baseline + overlay indexing**
- **LLM-friendly query tools** such as `symbol_lookup`, `file_summary`, and `impact_analysis`

## Current status

This repository is currently a **project scaffold**:

- package metadata is set up for `pi install`
- extension entrypoints exist
- daemon/shared module boundaries exist
- RFC and MVP documents are checked into `docs/`
- production functionality is still to be implemented

## Repository layout

```text
extensions/          pi package extension entrypoints
src/extension/       pi extension implementation
src/daemon/          local daemon skeleton
src/shared/          protocol and shared types
docs/                RFC and MVP spec
```

## Docs

- `docs/rfc.md` — full design and rationale
- `docs/mvp-spec.md` — Phase 1 implementation-facing MVP spec
- `AGENTS.md` — repository guardrails for AI coding agents

## Development

```bash
npm install
npm run typecheck
npm run dev:daemon
```

## Publishing intent

This package is intended to be published as:

```text
@linimin/pi-code-index
```

and installed via:

```bash
pi install npm:@linimin/pi-code-index
```
