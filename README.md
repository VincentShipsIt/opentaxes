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

## License

MIT
