# opentaxes

Start here: `.agents/memory/MEMORY.md` is the index. Read `.agents/memory/architecture.md` before touching `src/`.

Rules for agents working in this repo:

- Bun only. `bun install`, `bun test`, `bunx`. Never npm or yarn.
- Verification is `bun run check && bun run typecheck && bun test`. All three green before a PR.
- Secrets never enter tracked files. Real IDs live in `opentaxes.config.json` and `.env`, both ignored.
- Tests use synthetic data under `fixtures/`. Never commit a real invoice, statement, or email.
- Match the shapes in `src/core/types.ts`. New sources, sinks, and extractors plug into the registries in `src/core/registry.ts`. Nothing outside an adapter branches on a source name.
- Every state-mutating operation is idempotent. Re-running a month converges to the same files, rows, and ledger.
- Runtime code must run on Node 22+ as well as Bun. No `Bun.*` APIs in `src/`.
