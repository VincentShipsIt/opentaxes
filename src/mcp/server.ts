import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { DepsOptions } from "../cli/deps.ts";
import { loadRunDeps, resolveMonth } from "../cli/deps.ts";
import { parseMonth } from "../core/dates.ts";
import { parseExtraction } from "../core/extraction-schema.ts";
import { addManualMatch, setDecision, setExtraction } from "../core/ledger.ts";
import { slug } from "../core/naming.ts";
import { summary } from "../core/reconcile.ts";
import { extractMonth, fetchMonth, publishMonth, reconcileMonth, runMonth } from "../core/run.ts";
import { DecisionSchema } from "../core/schemas.ts";
import type { Decision, DocumentId, Ledger, Month, TransactionId } from "../core/types.ts";

interface ToolTextResult {
	// Index signature matches the SDK's CallToolResult shape (which allows arbitrary extra
	// fields), so this narrower shape is structurally assignable to it.
	readonly [key: string]: unknown;
	readonly content: Array<{ readonly type: "text"; readonly text: string }>;
	readonly isError?: boolean;
}

function ok(data: unknown, warnings: readonly string[]): ToolTextResult {
	return { content: [{ type: "text", text: JSON.stringify({ result: data, warnings }, null, 2) }] };
}

function fail(error: unknown): ToolTextResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
		isError: true,
	};
}

/** Runs a handler, turning any thrown error into an `isError` tool result instead of crashing the server. */
function guarded<Input>(
	handler: (input: Input) => Promise<ToolTextResult>
): (input: Input) => Promise<ToolTextResult> {
	return async (input) => {
		try {
			return await handler(input);
		} catch (error) {
			return fail(error);
		}
	};
}

const TRANSACTION_STATUSES = ["all", "matched", "unmatched", "decided"] as const;
const DOCUMENT_STATUSES = ["all", "extracted", "unextracted", "matched", "orphan"] as const;

/**
 * Builds every tool. `depsOptions` is only the config/state paths — `loadRunDeps` is called
 * fresh inside each handler (never cached on the server), so editing the config file or .env
 * takes effect on the next tool call with no restart.
 */
export function createServer(depsOptions: DepsOptions): McpServer {
	const server = new McpServer({ name: "opentaxes", version: "0.1.0" });

	async function deps(month: Month, warnings: string[]) {
		return (await loadRunDeps(depsOptions, month, (message) => warnings.push(message))).deps;
	}

	server.registerTool(
		"fetch",
		{
			description: "Pulls transactions and documents for a month from every configured source.",
			inputSchema: { month: z.string().optional() },
		},
		guarded(async ({ month }: { month?: string | undefined }) => {
			const warnings: string[] = [];
			const resolved = resolveMonth(month);
			const result = await fetchMonth(resolved, await deps(resolved, warnings));
			return ok(result, warnings);
		})
	);

	server.registerTool(
		"extract",
		{
			description:
				"Extracts every document that has no extraction yet, using the configured extractor.",
			inputSchema: { month: z.string().optional() },
		},
		guarded(async ({ month }: { month?: string | undefined }) => {
			const warnings: string[] = [];
			const resolved = resolveMonth(month);
			const result = await extractMonth(resolved, await deps(resolved, warnings));
			return ok(result, warnings);
		})
	);

	server.registerTool(
		"reconcile",
		{
			description: "Recomputes automatic matches between transactions and extracted documents.",
			inputSchema: { month: z.string().optional() },
		},
		guarded(async ({ month }: { month?: string | undefined }) => {
			const warnings: string[] = [];
			const resolved = resolveMonth(month);
			const result = await reconcileMonth(resolved, await deps(resolved, warnings));
			return ok(result, warnings);
		})
	);

	server.registerTool(
		"publish",
		{
			description: "Publishes the month's ledger to every configured sink (folder, Drive, Sheets).",
			inputSchema: { month: z.string().optional() },
		},
		guarded(async ({ month }: { month?: string | undefined }) => {
			const warnings: string[] = [];
			const resolved = resolveMonth(month);
			const result = await publishMonth(resolved, await deps(resolved, warnings));
			return ok(result, warnings);
		})
	);

	server.registerTool(
		"run",
		{
			description: "Runs fetch, extract, reconcile, and publish in sequence for a month.",
			inputSchema: { month: z.string().optional() },
		},
		guarded(async ({ month }: { month?: string | undefined }) => {
			const warnings: string[] = [];
			const resolved = resolveMonth(month);
			const result = await runMonth(resolved, await deps(resolved, warnings));
			return ok(result, warnings);
		})
	);

	server.registerTool(
		"missing",
		{
			description: "Lists unmatched transactions and orphan documents that still need attention.",
			inputSchema: { month: z.string().optional() },
		},
		guarded(async ({ month }: { month?: string | undefined }) => {
			const warnings: string[] = [];
			const resolved = resolveMonth(month);
			const runDeps = await deps(resolved, warnings);
			const ledger = await runDeps.store.load(resolved);
			const { unmatchedTransactions, orphanDocuments } = summary(ledger);
			const documents = orphanDocuments.map((document) => ({
				id: document.id,
				filename: document.filename,
				extraction: ledger.extractions[document.id] ?? null,
			}));
			return ok({ unmatchedTransactions, orphanDocuments: documents }, warnings);
		})
	);

	server.registerTool(
		"list_transactions",
		{
			description: "Lists a month's transactions, optionally filtered by match/decision status.",
			inputSchema: { month: z.string(), status: z.enum(TRANSACTION_STATUSES).optional() },
		},
		guarded(
			async ({
				month,
				status,
			}: {
				month: string;
				status?: (typeof TRANSACTION_STATUSES)[number] | undefined;
			}) => {
				const warnings: string[] = [];
				const resolved = parseMonth(month);
				const runDeps = await deps(resolved, warnings);
				const ledger = await runDeps.store.load(resolved);
				const matchedIds = new Set(ledger.matches.map((entry) => entry.transactionId));
				const filtered = Object.values(ledger.transactions).filter((transaction) => {
					switch (status ?? "all") {
						case "matched":
							return matchedIds.has(transaction.id);
						case "unmatched":
							return !matchedIds.has(transaction.id) && !ledger.decisions[transaction.id];
						case "decided":
							return ledger.decisions[transaction.id] !== undefined;
						default:
							return true;
					}
				});
				return ok(filtered, warnings);
			}
		)
	);

	server.registerTool(
		"list_documents",
		{
			description: "Lists a month's documents, optionally filtered by extraction/match status.",
			inputSchema: { month: z.string(), status: z.enum(DOCUMENT_STATUSES).optional() },
		},
		guarded(
			async ({
				month,
				status,
			}: {
				month: string;
				status?: (typeof DOCUMENT_STATUSES)[number] | undefined;
			}) => {
				const warnings: string[] = [];
				const resolved = parseMonth(month);
				const runDeps = await deps(resolved, warnings);
				const ledger = await runDeps.store.load(resolved);
				const matchedIds = new Set(ledger.matches.map((entry) => entry.documentId));
				const filtered = Object.values(ledger.documents).filter((document) => {
					const extracted = ledger.extractions[document.id] !== undefined;
					switch (status ?? "all") {
						case "extracted":
							return extracted;
						case "unextracted":
							return !extracted;
						case "matched":
							return matchedIds.has(document.id);
						case "orphan":
							return extracted && !matchedIds.has(document.id) && !ledger.decisions[document.id];
						default:
							return true;
					}
				});
				return ok(filtered, warnings);
			}
		)
	);

	server.registerTool(
		"read_document",
		{
			description: "Reads one document's bytes (base64) and mime type, for extraction by an agent.",
			inputSchema: { month: z.string(), documentId: z.string() },
		},
		guarded(async ({ month, documentId }: { month: string; documentId: string }) => {
			const warnings: string[] = [];
			const resolved = parseMonth(month);
			const runDeps = await deps(resolved, warnings);
			const ledger = await runDeps.store.load(resolved);
			const id = documentId as DocumentId;
			const document = ledger.documents[id];
			if (!document) throw new Error(`document ${documentId} not found in ${month}`);
			const bytes = await runDeps.store.readDocument(resolved, id);
			return ok({ mime: document.mime, base64: Buffer.from(bytes).toString("base64") }, warnings);
		})
	);

	server.registerTool(
		"set_extraction",
		{
			description:
				"Records an extraction for a document, validated the same way the Claude extractor's output is.",
			inputSchema: { month: z.string(), documentId: z.string(), extraction: z.unknown() },
		},
		guarded(
			async ({
				month,
				documentId,
				extraction,
			}: {
				month: string;
				documentId: string;
				extraction: unknown;
			}) => {
				const warnings: string[] = [];
				const resolved = parseMonth(month);
				const runDeps = await deps(resolved, warnings);
				let ledger: Ledger = await runDeps.store.load(resolved);
				const id = documentId as DocumentId;
				if (!ledger.documents[id]) throw new Error(`document ${documentId} not found in ${month}`);
				const parsed = parseExtraction(extraction, "agent");
				const category = parsed.category ?? runDeps.config.categories[slug(parsed.party)] ?? null;
				ledger = setExtraction(ledger, id, { ...parsed, category });
				await runDeps.store.save(ledger);
				return ok({ documentId, extraction: ledger.extractions[id] }, warnings);
			}
		)
	);

	server.registerTool(
		"decide",
		{
			description:
				"Records a personal/no-document/duplicate/ignore decision on a transaction or document.",
			inputSchema: { month: z.string(), id: z.string(), decision: z.unknown() },
		},
		guarded(async ({ month, id, decision }: { month: string; id: string; decision: unknown }) => {
			const warnings: string[] = [];
			const resolved = parseMonth(month);
			const runDeps = await deps(resolved, warnings);
			let ledger: Ledger = await runDeps.store.load(resolved);
			const parsed = DecisionSchema.parse(decision) as Decision;
			ledger = setDecision(ledger, id as TransactionId | DocumentId, parsed);
			await runDeps.store.save(ledger);
			return ok({ id, decision: parsed }, warnings);
		})
	);

	server.registerTool(
		"match",
		{
			description: "Records a manual match between a transaction and a document.",
			inputSchema: { month: z.string(), transactionId: z.string(), documentId: z.string() },
		},
		guarded(
			async ({
				month,
				transactionId,
				documentId,
			}: {
				month: string;
				transactionId: string;
				documentId: string;
			}) => {
				const warnings: string[] = [];
				const resolved = parseMonth(month);
				const runDeps = await deps(resolved, warnings);
				let ledger: Ledger = await runDeps.store.load(resolved);
				const txnId = transactionId as TransactionId;
				const docId = documentId as DocumentId;
				if (!ledger.transactions[txnId]) {
					throw new Error(`transaction ${transactionId} not found in ${month}`);
				}
				if (!ledger.documents[docId])
					throw new Error(`document ${documentId} not found in ${month}`);
				ledger = addManualMatch(ledger, txnId, docId);
				await runDeps.store.save(ledger);
				return ok({ transactionId, documentId }, warnings);
			}
		)
	);

	server.registerTool(
		"summary",
		{
			description: "Reports transaction/document counts, matches, and what still needs attention.",
			inputSchema: { month: z.string() },
		},
		guarded(async ({ month }: { month: string }) => {
			const warnings: string[] = [];
			const resolved = parseMonth(month);
			const runDeps = await deps(resolved, warnings);
			const ledger = await runDeps.store.load(resolved);
			return ok(summary(ledger), warnings);
		})
	);

	return server;
}

export async function startMcpServer(depsOptions: DepsOptions): Promise<void> {
	const server = createServer(depsOptions);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
