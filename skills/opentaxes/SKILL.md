---
name: opentaxes
description: Use when the user wants to run their monthly bookkeeping collection with opentaxes — fetching bank transactions and receipts/invoices, extracting document data, reconciling matches, and publishing a clean ledger for their accountant. Triggers on requests like "run opentaxes", "do my books for last month", "reconcile my receipts", or "what's missing for taxes".
---

# opentaxes

Agent-first bookkeeping collector. It pulls transactions (Wise, Stripe) and documents
(Gmail, Stripe, a local drop folder) for one month, matches them, and publishes a ledger. You
reach it over MCP — every tool below is an MCP tool this server exposes, not a shell command.

No Anthropic API key is required. When Claude Code is installed, extraction runs through the
local `claude` CLI by default (`config.extractor` unset or `{ "kind": "claude-cli" }`). Setting
`ANTHROPIC_API_KEY` switches the default to the Anthropic API instead. Either way, you (the
agent working this skill) can also read a document yourself with `read_document` and record
its fields with `set_extraction` — useful when the configured extractor gets a document wrong,
or when no extractor is configured at all.

## Workflow

1. **Fetch.** Call `fetch { month }` (e.g. `"2026-03"`). This pulls every configured source for
   the month into local state. Report anything in the returned `warnings` — usually a source
   whose credentials need attention (e.g. an expired Google token).
2. **Check the summary.** Call `summary { month }`. It reports transaction/document counts,
   how many are matched, and how many still need work.
3. **Extract pending documents.** If `unextractedDocuments > 0`:
   - Prefer running `extract { month }` — it runs the configured extractor (CLI or API) over
     every unextracted document at once.
   - If that tool errors, or the extractor got a document wrong, extract manually instead:
     call `list_documents { month, status: "unextracted" }`, then for each one call
     `read_document { month, documentId }` (returns `mime` and `base64`), read the document
     yourself, and call `set_extraction { month, documentId, extraction }` with the fields
     (`kind`, `side`, `party`, `issuedAt`, `total`, `tax`, `number`, `category`, `confidence`).
     A rejected extraction means a required field is missing or malformed — fix it and retry.
4. **Reconcile.** Call `reconcile { month }` to recompute matches now that extractions exist.
5. **Review what's missing.** Call `missing { month }`. It lists unmatched transactions (with
   date, amount, and counterparty) and orphan documents (extracted but unmatched). For each:
   - If a transaction is personal or otherwise shouldn't need a receipt, call
     `decide { month, id, decision: { kind: "personal" } }` (or `{ kind: "no-document",
     reason }`, `{ kind: "duplicate", of }`, `{ kind: "ignore", reason }` as appropriate).
   - If you can tell a listed document actually belongs to a listed transaction, call
     `match { month, transactionId, documentId }` and re-run `missing` to confirm it cleared.
   - If the user has a receipt for one of the remaining transactions, tell them to drop the
     file into the configured drop folder for the month (if `sources.folder` is set in
     `opentaxes.config.json`, that's `<folder.dir>/<YYYY-MM>/`) and re-run this workflow from
     step 1 (`fetch`, then `extract`) — the new file gets picked up automatically.
6. **Publish.** Once nothing more can be resolved automatically, call `publish { month }` to
   write the ledger to every configured sink (local folder, Google Drive, Google Sheets).
7. **Report to the user.** Summarize what was matched and published, then list what's still
   open: which transactions need a receipt (vendor, amount, date) and which orphan documents
   need a transaction — this is exactly what `missing` returned in step 5.

## Notes

- Every tool takes `month` as `"YYYY-MM"`. `fetch`, `extract`, `reconcile`, `publish`, `run`,
  and `missing` default it to last month when omitted; the rest (`summary`,
  `list_transactions`, `list_documents`, `read_document`, `set_extraction`, `decide`, `match`)
  require it. Pass it explicitly on every call so every tool in one workflow run agrees on the
  same month.
- Config lives in `opentaxes.config.json` at the project root; if a tool call fails with
  "no config... run opentaxes init", tell the user to run `opentaxes init` first (or use the
  `init` CLI verb) and set up `.env` before continuing.
- `set_extraction` and `decide` validate their input the same way the CLI does — a rejected
  call means the shape is wrong, not that the operation is unsupported. Fix the payload and
  retry rather than giving up on the step.
