# opentaxes

Agent-first bookkeeping collector. It pulls your bank transactions, collects the invoices and receipts behind them from mail and vendor APIs, matches the two sides, and hands your accountant a clean monthly folder. The parts it cannot settle come back as a short list instead of a day on vendor dashboards.

Runs as a CLI for cron and as an MCP server for Claude Code, Codex, Cursor, or any agent that speaks MCP. Bring your own credentials. Nothing leaves your machine except calls to the services you connect.

## Status

Early. The domain model and adapter interfaces are in place; sources and sinks are landing one PR at a time. Watch the repo for the first tagged release.

## Sources and sinks

| kind | v1 |
| --- | --- |
| bank | Wise Business (transactions + monthly statement PDF) |
| documents | Gmail attachments, Stripe invoices |
| reader | the connected agent over MCP, or Claude with your own API key |
| output | local folder, Google Drive, Google Sheets |

Adding a bank, mailbox, or accounting export is one adapter file. See `.agents/memory/architecture.md`.

## Usage

```sh
bun add -g @vincentshipsit/opentaxes   # or: bunx @vincentshipsit/opentaxes <verb>
opentaxes init                         # writes opentaxes.config.json and .env.example
cp .env.example .env                   # fill in the tokens for the sources you use
opentaxes auth google                  # only if you use Gmail, Drive, or Sheets
opentaxes run                          # fetch, extract, reconcile, publish last month
opentaxes missing                      # what still needs a receipt or a decision
```

No Anthropic API key is required: with Claude Code installed, document extraction runs
through the local `claude` CLI by default. Set `ANTHROPIC_API_KEY` in `.env` to use the
Anthropic API instead, or pin one explicitly with `"extractor": { "kind": "claude-api" }` or
`"extractor": { "kind": "claude-cli" }` in `opentaxes.config.json`.

Every verb takes `--month YYYY-MM` (defaults to last month), `--state <dir>`, `--config
<path>`, and `--json`.

### As an MCP server

Over MCP, the connected agent can also read a document itself (`read_document`) and record its
extraction (`set_extraction`) — see `skills/opentaxes/SKILL.md` for the full tool sequence.

Claude Code:

```sh
claude mcp add opentaxes -- bunx @vincentshipsit/opentaxes mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.opentaxes]
command = "bunx"
args = ["@vincentshipsit/opentaxes", "mcp"]
```

## License

MIT
