import { formatDecimal } from "../core/money.ts";
import type {
	Currency,
	Decision,
	Document,
	DocumentId,
	IsoDate,
	Ledger,
	Match,
	Month,
	Transaction,
	TransactionId,
} from "../core/types.ts";

export type SinkFolder = "expenses" | "revenue" | "bank" | "unsorted";

/**
 * Statements always land in `bank`, whatever an extractor might have made of one. Everything
 * else follows its extraction's side, and anything unextracted is left for a human to sort.
 */
export function documentFolder(ledger: Ledger, documentId: DocumentId): SinkFolder {
	const document = ledger.documents[documentId];
	if (!document) throw new Error(`unknown document "${documentId}"`);
	if (document.origin.kind === "statement") return "bank";
	const extraction = ledger.extractions[documentId];
	if (!extraction) return "unsorted";
	if (extraction.kind === "statement") return "bank";
	return extraction.side === "expense" ? "expenses" : "revenue";
}

export function monthPath(month: Month): readonly [string, string] {
	const [year, monthNumber] = month.split("-") as [string, string];
	return [year, monthNumber];
}

/** Column order shared by `reconciliationCsv` and `rows.ts` (which prepends `id`). */
export const TRANSACTION_COLUMNS = [
	"date",
	"bank",
	"debit",
	"credit",
	"currency",
	"original",
	"original_currency",
	"description",
	"invoice",
	"file",
	"party",
	"category",
] as const;

export interface TransactionRecord {
	readonly id: TransactionId;
	readonly date: IsoDate;
	readonly bank: string;
	readonly debit: string;
	readonly credit: string;
	readonly currency: Currency;
	readonly original: string;
	readonly originalCurrency: string;
	readonly description: string;
	readonly invoice: string;
	readonly file: string;
	readonly party: string;
	readonly category: string;
}

export function transactionRecords(
	ledger: Ledger,
	filenames: Readonly<Record<string, string>>
): readonly TransactionRecord[] {
	return sortedTransactions(ledger).map((transaction) =>
		buildRecord(ledger, filenames, transaction)
	);
}

function buildRecord(
	ledger: Ledger,
	filenames: Readonly<Record<string, string>>,
	transaction: Transaction
): TransactionRecord {
	const match = ledger.matches.find((candidate) => candidate.transactionId === transaction.id);
	const extraction = match ? ledger.extractions[match.documentId] : undefined;
	const decision = ledger.decisions[transaction.id];
	return {
		id: transaction.id,
		date: transaction.bookedAt,
		bank: transaction.source.toUpperCase(),
		debit: transaction.direction === "out" ? formatDecimal(transaction.amount) : "",
		credit: transaction.direction === "in" ? formatDecimal(transaction.amount) : "",
		currency: transaction.amount.currency,
		original: transaction.original ? formatDecimal(transaction.original) : "",
		originalCurrency: transaction.original ? transaction.original.currency : "",
		description: transaction.counterparty || transaction.reference,
		invoice: invoiceStatus(match, decision),
		file: match ? (filenames[match.documentId] ?? "") : "",
		party: extraction?.party ?? "",
		category: extraction?.category ?? "",
	};
}

function invoiceStatus(match: Match | undefined, decision: Decision | undefined): string {
	if (match) return "UPLOADED";
	if (!decision) return "MISSING";
	switch (decision.kind) {
		case "no-document":
			return "NOT AVAILABLE";
		case "personal":
			return "PERSONAL";
		case "ignore":
			return "IGNORED";
		case "duplicate":
			return "DUPLICATE";
		default: {
			const exhaustive: never = decision;
			throw new Error(`unhandled decision: ${JSON.stringify(exhaustive)}`);
		}
	}
}

function sortedTransactions(ledger: Ledger): readonly Transaction[] {
	return Object.values(ledger.transactions).slice().sort(byDateThenId);
}

function byDateThenId(a: { readonly bookedAt: IsoDate; readonly id: string }, b: typeof a): number {
	if (a.bookedAt !== b.bookedAt) return a.bookedAt < b.bookedAt ? -1 : 1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

export interface OrphanDocumentRecord {
	readonly id: DocumentId;
	readonly filename: string;
	readonly party: string;
	readonly issuedAt: string;
}

/**
 * Documents no `Match` points at, and nothing tells us to stop chasing: excludes bank
 * statements (never matched to a transaction) and any document a decision already settled.
 */
export function orphanDocumentRecords(
	ledger: Ledger,
	filenames: Readonly<Record<string, string>>
): readonly OrphanDocumentRecord[] {
	const matchedDocumentIds = new Set(ledger.matches.map((match) => match.documentId));
	return sortedDocuments(ledger)
		.filter((document) => !matchedDocumentIds.has(document.id))
		.filter((document) => ledger.extractions[document.id]?.kind !== "statement")
		.filter((document) => !ledger.decisions[document.id])
		.map((document) => {
			const extraction = ledger.extractions[document.id];
			return {
				id: document.id,
				filename: filenames[document.id] ?? document.filename,
				party: extraction?.party ?? "",
				issuedAt: extraction?.issuedAt ?? "",
			};
		});
}

function sortedDocuments(ledger: Ledger): readonly Document[] {
	return Object.values(ledger.documents)
		.slice()
		.sort((a, b) =>
			byDateThenId({ bookedAt: a.fetchedAt, id: a.id }, { bookedAt: b.fetchedAt, id: b.id })
		);
}

export function reconciliationCsv(
	ledger: Ledger,
	filenames: Readonly<Record<string, string>>
): string {
	const lines: string[] = [csvRow(TRANSACTION_COLUMNS)];
	for (const record of transactionRecords(ledger, filenames)) {
		lines.push(
			csvRow([
				record.date,
				record.bank,
				record.debit,
				record.credit,
				record.currency,
				record.original,
				record.originalCurrency,
				record.description,
				record.invoice,
				record.file,
				record.party,
				record.category,
			])
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Column order for `unmatchedDocumentsCsv`. */
export const UNMATCHED_DOCUMENTS_COLUMNS = ["filename", "party", "issued_at"] as const;

/**
 * A CSV of documents no `Match` points at yet, kept separate from `reconciliationCsv` — a file
 * with two differently-shaped tables in it opens badly in spreadsheet software. Callers should
 * write this file only when `orphanDocumentRecords` is non-empty.
 */
export function unmatchedDocumentsCsv(
	ledger: Ledger,
	filenames: Readonly<Record<string, string>>
): string {
	const lines: string[] = [csvRow(UNMATCHED_DOCUMENTS_COLUMNS)];
	for (const orphan of orphanDocumentRecords(ledger, filenames)) {
		lines.push(csvRow([orphan.filename, orphan.party, orphan.issuedAt]));
	}
	return `${lines.join("\n")}\n`;
}

function csvRow(fields: readonly string[]): string {
	return fields.map(csvField).join(",");
}

function csvField(value: string): string {
	return /["\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
