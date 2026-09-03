import type { Config } from "./config.ts";
import type { Env } from "./env.ts";
import type { Document, DocumentOrigin, Extraction, Ledger, Month, Transaction } from "./types.ts";

/** A document as a source hands it over, before the store assigns its content id. */
export interface FetchedDocument {
	readonly origin: DocumentOrigin;
	readonly filename: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
	/** Sources that already know the totals (Stripe, statements) fill this in. */
	readonly extraction?: Extraction;
}

export interface TransactionSource {
	readonly name: string;
	fetchTransactions(month: Month): Promise<readonly Transaction[]>;
}

export interface DocumentSource {
	readonly name: string;
	fetchDocuments(month: Month): Promise<readonly FetchedDocument[]>;
}

export interface Extractor {
	readonly name: string;
	extract(document: Document, bytes: Uint8Array): Promise<Extraction>;
}

export interface PublishInput {
	readonly ledger: Ledger;
	/** final filename per document, from `documentFilename` in naming.ts */
	readonly filenames: Readonly<Record<string, string>>;
	readDocument(document: Document): Promise<Uint8Array>;
}

export interface PublishResult {
	readonly sink: string;
	readonly created: number;
	readonly unchanged: number;
}

export interface Sink {
	readonly name: string;
	publish(input: PublishInput): Promise<PublishResult>;
}

export interface Registry {
	readonly transactionSources: readonly TransactionSource[];
	readonly documentSources: readonly DocumentSource[];
	readonly extractor: Extractor | null;
	readonly sinks: readonly Sink[];
}

/**
 * Builds every adapter the config enables. This is the only place that
 * knows adapter names; the rest of the core iterates the registry.
 */
export function createRegistry(_config: Config, _env: Env): Registry {
	throw new Error("not implemented");
}
