# opentaxes memory

Index of durable project knowledge. Read `architecture.md` before any change under `src/`.

- `architecture.md`. Domain model, module map, invariants, matching rules, surfaces.

Conventions:

- Bun, TypeScript strict, Biome with tabs. `bun run check && bun run typecheck && bun test` is the gate.
- Tests sit next to the code as `*.test.ts` and use `bun:test`. Fixtures under `fixtures/` are synthetic.
- Adapters are thin. Logic that can be a pure function lives in `src/core/` with a test.
- Local-only notes go in `.agents/memory/local/` (ignored). Nothing about a real business enters tracked files.
