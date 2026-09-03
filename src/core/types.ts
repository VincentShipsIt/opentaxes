declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** "YYYY-MM" */
export type Month = Brand<string, "Month">;
/** "YYYY-MM-DD" */
export type IsoDate = Brand<string, "IsoDate">;
/** ISO 4217, upper case */
export type Currency = Brand<string, "Currency">;
/** "<source>:<native id>", stable across runs */
export type TransactionId = Brand<string, "TransactionId">;
/** sha256 hex of the document bytes */
export type DocumentId = Brand<string, "DocumentId">;

export interface Money {
	/** minor units (cents), always positive; direction lives on the owner */
	readonly minor: number;
	readonly currency: Currency;
}

export type Direction = "in" | "out";

export interface Transaction {
	readonly id: TransactionId;
	readonly source: string;
	readonly bookedAt: IsoDate;
	readonly direction: Direction;
	readonly amount: Money;
	/**
	 * What the counterparty billed, when the bank converted it. A card charge of 88.88 EUR
	 * debits 103.24 USD; the vendor's invoice says 88.88 EUR, so matching must see both.
	 */
	readonly original?: Money;
	readonly counterparty: string;
	/** payment reference or description, "" when the bank gives none */
	readonly reference: string;
}

export type DocumentOrigin =
	| {
			readonly kind: "gmail";
			readonly messageId: string;
			readonly attachmentId: string;
			readonly from: string;
			readonly subject: string;
			readonly receivedAt: IsoDate;
	  }
	| { readonly kind: "stripe"; readonly invoiceId: string }
	| { readonly kind: "statement"; readonly source: string; readonly account: string }
	| { readonly kind: "file"; readonly path: string };

export interface Document {
	readonly id: DocumentId;
	readonly origin: DocumentOrigin;
	readonly filename: string;
	readonly mime: string;
	readonly fetchedAt: IsoDate;
}

export type DocumentKind = "invoice" | "receipt" | "credit_note" | "statement" | "other";
export type Side = "expense" | "revenue";
export type ExtractedBy = "source" | "claude" | "agent";

export interface Extraction {
	readonly kind: DocumentKind;
	readonly side: Side;
	/** vendor for an expense, customer for revenue */
	readonly party: string;
	readonly issuedAt: IsoDate;
	readonly total: Money;
	readonly tax: Money | null;
	readonly number: string | null;
	readonly category: string | null;
	/** 0..1 */
	readonly confidence: number;
	readonly by: ExtractedBy;
}

export type MatchRule = "manual" | "amount-date" | "amount-date-party";

export interface Match {
	readonly transactionId: TransactionId;
	readonly documentId: DocumentId;
	readonly rule: MatchRule;
	/** 0..1, 1 for manual */
	readonly score: number;
}

/** A human or agent verdict on something the matcher could not settle. */
export type Decision =
	| { readonly kind: "personal" }
	| { readonly kind: "no-document"; readonly reason: string }
	| { readonly kind: "duplicate"; readonly of: DocumentId }
	| { readonly kind: "ignore"; readonly reason: string };

export interface Ledger {
	readonly month: Month;
	readonly transactions: Readonly<Record<TransactionId, Transaction>>;
	readonly documents: Readonly<Record<DocumentId, Document>>;
	readonly extractions: Readonly<Record<DocumentId, Extraction>>;
	readonly matches: readonly Match[];
	readonly decisions: Readonly<Record<TransactionId | DocumentId, Decision>>;
}

export interface Summary {
	readonly month: Month;
	readonly transactions: number;
	readonly documents: number;
	readonly matched: number;
	readonly unmatchedTransactions: readonly Transaction[];
	readonly orphanDocuments: readonly Document[];
	readonly unextractedDocuments: readonly Document[];
}
