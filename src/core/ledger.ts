import type {
	Decision,
	Direction,
	Document,
	DocumentId,
	Extraction,
	Ledger,
	Match,
	Month,
	Side,
	Transaction,
	TransactionId,
} from "./types.ts";

export function emptyLedger(month: Month): Ledger {
	return {
		month,
		transactions: {},
		documents: {},
		extractions: {},
		matches: [],
		decisions: {},
	};
}

/** `out` transactions are expenses, `in` transactions are revenue. */
export function sideOf(direction: Direction): Side {
	return direction === "out" ? "expense" : "revenue";
}

/** Upserts by id, so refetching a source never duplicates a transaction. */
export function upsertTransactions(ledger: Ledger, transactions: readonly Transaction[]): Ledger {
	if (transactions.length === 0) return ledger;
	const next = { ...ledger.transactions };
	for (const transaction of transactions) {
		next[transaction.id] = transaction;
	}
	return { ...ledger, transactions: next };
}

export function addDocument(ledger: Ledger, document: Document, extraction?: Extraction): Ledger {
	const documents = { ...ledger.documents, [document.id]: document };
	if (!extraction) return { ...ledger, documents };
	const extractions = { ...ledger.extractions, [document.id]: extraction };
	return { ...ledger, documents, extractions };
}

export function setExtraction(
	ledger: Ledger,
	documentId: DocumentId,
	extraction: Extraction
): Ledger {
	return { ...ledger, extractions: { ...ledger.extractions, [documentId]: extraction } };
}

export function setDecision(
	ledger: Ledger,
	id: TransactionId | DocumentId,
	decision: Decision
): Ledger {
	return { ...ledger, decisions: { ...ledger.decisions, [id]: decision } };
}

/** Records a manual match, replacing any automatic match already on either side. */
export function addManualMatch(
	ledger: Ledger,
	transactionId: TransactionId,
	documentId: DocumentId
): Ledger {
	const kept = ledger.matches.filter(
		(match) => match.transactionId !== transactionId && match.documentId !== documentId
	);
	const manual: Match = { transactionId, documentId, rule: "manual", score: 1 };
	return { ...ledger, matches: [...kept, manual] };
}
