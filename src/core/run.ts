import type { Config } from "./config.ts";
import { toIsoDate } from "./dates.ts";
import { addDocument, setExtraction, upsertTransactions } from "./ledger.ts";
import { documentFilename, slug } from "./naming.ts";
import { reconcile, summary } from "./reconcile.ts";
import type { PublishInput, PublishResult, Registry } from "./registry.ts";
import type { LedgerStore } from "./store.ts";
import type { Document, Month, Summary } from "./types.ts";

export interface RunDeps {
	readonly registry: Registry;
	readonly store: LedgerStore;
	readonly config: Config;
}

export interface PublishSummary {
	readonly summary: Summary;
	readonly results: readonly PublishResult[];
}

/**
 * Upserts transactions and documents from every source, saving after each one so a
 * source that fails partway through does not discard what the earlier sources fetched.
 */
export async function fetchMonth(month: Month, deps: RunDeps): Promise<Summary> {
	let ledger = await deps.store.load(month);

	for (const source of deps.registry.transactionSources) {
		const transactions = await source.fetchTransactions(month);
		ledger = upsertTransactions(ledger, transactions);
		await deps.store.save(ledger);
	}

	for (const source of deps.registry.documentSources) {
		const fetched = await source.fetchDocuments(month);
		for (const item of fetched) {
			const { id } = await deps.store.putDocument(month, item.bytes, item.filename, item.mime);
			if (ledger.documents[id]) continue;
			const document: Document = {
				id,
				origin: item.origin,
				filename: item.filename,
				mime: item.mime,
				fetchedAt: toIsoDate(new Date()),
			};
			ledger = addDocument(ledger, document, item.extraction);
		}
		await deps.store.save(ledger);
	}

	return summary(ledger);
}

/**
 * Extracts every document that has none yet. Applies the configured category for the
 * party's slug when the extractor left it null.
 */
export async function extractMonth(month: Month, deps: RunDeps): Promise<Summary> {
	let ledger = await deps.store.load(month);
	const pending = Object.values(ledger.documents).filter(
		(document) => ledger.extractions[document.id] === undefined
	);

	if (pending.length === 0) return summary(ledger);

	const extractor = deps.registry.extractor;
	if (!extractor) {
		throw new Error(
			`${pending.length} document(s) in ${month} have no extraction and no extractor is configured. ` +
				`Run "opentaxes extract --month ${month}" with an extractor configured, or extract them by ` +
				`hand over MCP (src/mcp/server.ts): "read_document" then "set_extraction".`
		);
	}

	for (const document of pending) {
		const bytes = await deps.store.readDocument(month, document.id);
		const extraction = await extractor.extract(document, bytes);
		const category = extraction.category ?? deps.config.categories[slug(extraction.party)] ?? null;
		ledger = setExtraction(ledger, document.id, { ...extraction, category });
		await deps.store.save(ledger);
	}

	return summary(ledger);
}

export async function reconcileMonth(month: Month, deps: RunDeps): Promise<Summary> {
	const ledger = await deps.store.load(month);
	const reconciled = reconcile(ledger, deps.config.matching);
	await deps.store.save(reconciled);
	return summary(reconciled);
}

export async function publishMonth(month: Month, deps: RunDeps): Promise<PublishSummary> {
	const ledger = await deps.store.load(month);
	const filenames: Record<string, string> = {};
	for (const document of Object.values(ledger.documents)) {
		filenames[document.id] = documentFilename(document, ledger.extractions[document.id]);
	}

	const input: PublishInput = {
		ledger,
		filenames,
		readDocument: (document) => deps.store.readDocument(month, document.id),
	};

	const results: PublishResult[] = [];
	for (const sink of deps.registry.sinks) {
		results.push(await sink.publish(input));
	}

	return { summary: summary(ledger), results };
}

export async function runMonth(month: Month, deps: RunDeps): Promise<Summary> {
	await fetchMonth(month, deps);
	await extractMonth(month, deps);
	await reconcileMonth(month, deps);
	const published = await publishMonth(month, deps);
	return published.summary;
}
