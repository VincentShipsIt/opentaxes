---
name: architecture
description: Domain model, module map, and invariants for opentaxes
status: active
last_verified: 2026-09-03
---

# Architecture

## The one idea

Bookkeeping is reconciliation. Every bank transaction for a month must end with either a matching document or an explicit decision. Documents come from mail and vendor APIs; the ledger comes from the bank. The tool's job is to fetch both sides, match them, and hand a human or agent the short list it could not settle.

## Domain model (`src/core/types.ts`)

- `Ledger` is the whole state for one `Month`. It is a plain JSON value: transactions and documents keyed by stable ids, extractions keyed by document id, a list of `Match`, and `decisions` for anything settled by hand.
- `Transaction` comes from a `TransactionSource`. Its id is `<source>:<native id>` so refetching upserts instead of duplicating.
- `Document` is content-addressed. Its id is the sha256 of the bytes, so the same PDF arriving from two mails is one document.
- `Extraction` is what a reader learned from a document: kind, side, party, date, total, tax, number. `by` records who produced it (`source`, `claude`, or `agent`).
- `Match` links one transaction to one document with the rule that fired and a score. `manual` matches survive re-reconciliation; automatic ones are recomputed.
- `Decision` is a tagged union for the leftovers: personal spend, no document expected, duplicate, ignore.
- `Money` is minor units plus a branded `Currency`. Never floats.

## Module map

```
src/core/
  types.ts      domain types (branded ids, Ledger, Extraction, Match, Decision)
  config.ts     zod schema for opentaxes.config.json
  env.ts        zod schema for secrets
  money.ts      parse/format Money, minor-unit arithmetic
  dates.ts      Month and IsoDate parsing, month bounds, day distance
  naming.ts     documentFilename(extraction, document) -> "YYYY-MM-DD_party_total-CUR_number.ext"
  store.ts      LedgerStore: <state>/<month>/ledger.json + documents/<sha>.<ext>
  reconcile.ts  pure: reconcile(ledger, matching) -> ledger; summary(ledger) -> Summary
  registry.ts   adapter interfaces + createRegistry(config, env)
  run.ts        fetchMonth / extractMonth / reconcileMonth / publishMonth / runMonth
src/sources/    wise.ts  gmail.ts  stripe.ts  google-auth.ts
src/sinks/      folder.ts  drive.ts  sheets.ts
src/extractors/ claude.ts
src/mcp/        server.ts (tools over the core)  index.ts (stdio entry)
src/cli/        index.ts (commander)
skills/opentaxes/SKILL.md   the agent playbook installed with `npx skills add`
```

## Invariants

- **Boundary discipline.** Only `sources/`, `sinks/`, `extractors/`, `cli/`, and `mcp/` touch the outside world. `core/` is pure except `store.ts`, which owns the filesystem.
- **Idempotent everything.** `fetch` upserts by id. `store.putDocument` is content-addressed. `reconcile` recomputes automatic matches from scratch and keeps manual ones. `publish` checks for an existing file or row by filename or transaction id before writing. Running a month twice produces no diff.
- **No branching on adapter names outside `registry.ts`.** The core iterates `Registry` arrays.
- **Extraction is optional at the core level.** The MCP path lets the connected agent read the PDF and call `set_extraction`; the CLI path uses the Claude extractor. Both write the same `Extraction`.
- **Node and Bun.** `src/` uses only Node-compatible APIs so the published package runs under `npx` too.

## Matching (`reconcile.ts`)

Score each transaction against each document with an extraction on the same side (`out` pairs with `expense`, `in` with `revenue`):

- same currency and same minor amount, and `|bookedAt - issuedAt| <= dateWindowDays`: base 0.7, rule `amount-date`
- plus party token overlap with `counterparty` or `reference`: up to +0.3, rule `amount-date-party`
- different currency or amount: 0

Greedy assignment by descending score, one document per transaction, above `threshold`. Manual matches are applied first and their ids removed from the pool.

## Surfaces

CLI verbs: `init`, `auth google`, `fetch`, `extract`, `reconcile`, `publish`, `run`, `missing`, `mcp`. Every verb takes `--month YYYY-MM` (default: previous month) and reads config from `opentaxes.config.json` in cwd and secrets from env.

MCP tools mirror the verbs and add `list_transactions`, `list_documents`, `read_document`, `set_extraction`, `decide`, `summary`. The skill in `skills/opentaxes/` teaches the loop: fetch, read what is unextracted, extract, reconcile, resolve leftovers, publish.
