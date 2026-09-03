import type { Config } from "./config.ts";
import { daysBetween } from "./dates.ts";
import { sideOf } from "./ledger.ts";
import { sameMoney } from "./money.ts";
import type {
	Document,
	DocumentId,
	Extraction,
	Ledger,
	Match,
	MatchRule,
	Summary,
	Transaction,
	TransactionId,
} from "./types.ts";

type Matching = Config["matching"];

interface Candidate {
	readonly transaction: Transaction;
	readonly extraction: Extraction;
	readonly matching: Matching;
}

/**
 * True when the transaction and the extraction land on the same side, within the date
 * window, and agree on amount — either the bank's settled amount or, for a card charge
 * the bank converted, the counterparty's original billed amount.
 */
function amountDateFires(candidate: Candidate): boolean {
	const { transaction, extraction, matching } = candidate;
	const amountMatches =
		sameMoney(transaction.amount, extraction.total) ||
		(transaction.original !== undefined && sameMoney(transaction.original, extraction.total));
	return (
		sideOf(transaction.direction) === extraction.side &&
		amountMatches &&
		daysBetween(transaction.bookedAt, extraction.issuedAt) <= matching.dateWindowDays
	);
}

/** Lowercase word tokens of at least 3 characters, ascii-folded. */
function tokens(text: string): ReadonlySet<string> {
	const folded = text
		.normalize("NFKD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
	return new Set(folded.split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

/** Fraction of the party's tokens found in the transaction's counterparty or reference, scaled to 0.3. */
function partyBonus(candidate: Candidate): number {
	const { transaction, extraction } = candidate;
	const partyTokens = tokens(extraction.party);
	if (partyTokens.size === 0) return 0;
	const transactionTokens = new Set([
		...tokens(transaction.counterparty),
		...tokens(transaction.reference),
	]);
	if (transactionTokens.size === 0) return 0;
	let overlap = 0;
	for (const token of partyTokens) {
		if (transactionTokens.has(token)) overlap += 1;
	}
	return Math.min(overlap / partyTokens.size, 1) * 0.3;
}

/** Scoring rules, most specific first. Each returns a score or null when it does not apply. */
const RULES: ReadonlyArray<{
	readonly rule: MatchRule;
	score(candidate: Candidate): number | null;
}> = [
	{
		rule: "amount-date-party",
		score(candidate) {
			if (!amountDateFires(candidate)) return null;
			const bonus = partyBonus(candidate);
			return bonus > 0 ? 0.7 + bonus : null;
		},
	},
	{
		rule: "amount-date",
		score(candidate) {
			return amountDateFires(candidate) ? 0.7 : null;
		},
	},
];

interface ScoredPair {
	readonly transactionId: TransactionId;
	readonly documentId: DocumentId;
	readonly rule: MatchRule;
	readonly score: number;
}

function bestScore(
	candidate: Candidate
): { readonly rule: MatchRule; readonly score: number } | null {
	let best: { readonly rule: MatchRule; readonly score: number } | null = null;
	for (const entry of RULES) {
		const score = entry.score(candidate);
		if (score === null) continue;
		if (!best || score > best.score) best = { rule: entry.rule, score };
	}
	return best;
}

/**
 * Recomputes automatic matches from scratch and keeps manual ones. Manual matches
 * are pulled out first and their transactions/documents removed from the pool, so
 * re-running never overrides a human decision.
 */
export function reconcile(ledger: Ledger, matching: Matching): Ledger {
	const manual = ledger.matches.filter((match) => match.rule === "manual");
	const manualTransactionIds = new Set(manual.map((match) => match.transactionId));
	const manualDocumentIds = new Set(manual.map((match) => match.documentId));

	const transactions = Object.values(ledger.transactions).filter(
		(transaction) => !manualTransactionIds.has(transaction.id)
	);
	const documents = Object.values(ledger.documents).filter(
		(document) => !manualDocumentIds.has(document.id)
	);

	const scored: ScoredPair[] = [];
	for (const transaction of transactions) {
		for (const document of documents) {
			const extraction = ledger.extractions[document.id];
			if (!extraction) continue;
			const result = bestScore({ transaction, extraction, matching });
			if (!result || result.score < matching.threshold) continue;
			scored.push({
				transactionId: transaction.id,
				documentId: document.id,
				rule: result.rule,
				score: result.score,
			});
		}
	}

	scored.sort((a, b) => b.score - a.score);

	const usedTransactions = new Set<TransactionId>();
	const usedDocuments = new Set<DocumentId>();
	const automatic: Match[] = [];
	for (const pair of scored) {
		if (usedTransactions.has(pair.transactionId) || usedDocuments.has(pair.documentId)) continue;
		usedTransactions.add(pair.transactionId);
		usedDocuments.add(pair.documentId);
		automatic.push(pair);
	}

	return { ...ledger, matches: [...manual, ...automatic] };
}

export function summary(ledger: Ledger): Summary {
	const matchedTransactionIds = new Set(ledger.matches.map((match) => match.transactionId));
	const matchedDocumentIds = new Set(ledger.matches.map((match) => match.documentId));
	const transactions: readonly Transaction[] = Object.values(ledger.transactions);
	const documents: readonly Document[] = Object.values(ledger.documents);

	const unmatchedTransactions = transactions.filter(
		(transaction) => !matchedTransactionIds.has(transaction.id) && !ledger.decisions[transaction.id]
	);
	const orphanDocuments = documents.filter(
		(document) =>
			!matchedDocumentIds.has(document.id) &&
			!ledger.decisions[document.id] &&
			ledger.extractions[document.id] !== undefined
	);
	const unextractedDocuments = documents.filter(
		(document) => ledger.extractions[document.id] === undefined
	);

	return {
		month: ledger.month,
		transactions: transactions.length,
		documents: documents.length,
		matched: ledger.matches.length,
		unmatchedTransactions,
		orphanDocuments,
		unextractedDocuments,
	};
}
