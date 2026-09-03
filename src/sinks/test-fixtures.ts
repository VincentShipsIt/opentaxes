import { parseIsoDate, parseMonth } from "../core/dates.ts";
import { currency, money } from "../core/money.ts";
import type {
	Decision,
	Document,
	DocumentId,
	Extraction,
	Ledger,
	Match,
	Transaction,
	TransactionId,
} from "../core/types.ts";

/** Synthetic fixtures shared by the sink tests. No real vendor, bank, or document data. */

type TxnOverrides = Omit<Partial<Transaction>, "id"> & { readonly id: string };

export function txn(overrides: TxnOverrides): Transaction {
	return {
		id: overrides.id as TransactionId,
		source: overrides.source ?? "wise",
		bookedAt: overrides.bookedAt ?? parseIsoDate("2026-01-05"),
		direction: overrides.direction ?? "out",
		amount: overrides.amount ?? money(10_000, currency("USD")),
		counterparty: overrides.counterparty ?? "Acme Supplies",
		reference: overrides.reference ?? "INV-100",
		...(overrides.original !== undefined ? { original: overrides.original } : {}),
	};
}

type DocOverrides = Omit<Partial<Document>, "id"> & { readonly id: string };

export function doc(overrides: DocOverrides): Document {
	return {
		id: overrides.id as DocumentId,
		origin: overrides.origin ?? { kind: "file", path: `/dev/null/${overrides.id}` },
		filename: overrides.filename ?? `${overrides.id}.pdf`,
		mime: overrides.mime ?? "application/pdf",
		fetchedAt: overrides.fetchedAt ?? parseIsoDate("2026-01-04"),
	};
}

export function extraction(overrides: Partial<Extraction> = {}): Extraction {
	return {
		kind: overrides.kind ?? "invoice",
		side: overrides.side ?? "expense",
		party: overrides.party ?? "Acme Supplies",
		issuedAt: overrides.issuedAt ?? parseIsoDate("2026-01-03"),
		total: overrides.total ?? money(10_000, currency("USD")),
		tax: overrides.tax ?? null,
		number: overrides.number ?? "INV-100",
		category: overrides.category ?? "software",
		confidence: overrides.confidence ?? 0.95,
		by: overrides.by ?? "claude",
	};
}

type MatchOverrides = Omit<Partial<Match>, "transactionId" | "documentId"> & {
	readonly transactionId: string;
	readonly documentId: string;
};

export function match(overrides: MatchOverrides): Match {
	return {
		transactionId: overrides.transactionId as TransactionId,
		documentId: overrides.documentId as DocumentId,
		rule: overrides.rule ?? "amount-date",
		score: overrides.score ?? 0.9,
	};
}

export interface LedgerFixture {
	readonly transactions?: readonly Transaction[];
	readonly documents?: readonly Document[];
	readonly extractions?: Readonly<Record<string, Extraction>>;
	readonly matches?: readonly Match[];
	readonly decisions?: Readonly<Record<string, Decision>>;
}

export function ledgerFixture(fixture: LedgerFixture = {}): Ledger {
	return {
		month: parseMonth("2026-01"),
		transactions: Object.fromEntries(
			(fixture.transactions ?? []).map((t) => [t.id, t])
		) as unknown as Ledger["transactions"],
		documents: Object.fromEntries(
			(fixture.documents ?? []).map((d) => [d.id, d])
		) as unknown as Ledger["documents"],
		extractions: (fixture.extractions ?? {}) as unknown as Ledger["extractions"],
		matches: fixture.matches ?? [],
		decisions: (fixture.decisions ?? {}) as unknown as Ledger["decisions"],
	};
}
