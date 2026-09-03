import { z } from "zod";
import { parseIsoDate, parseMonth } from "./dates.ts";
import { currency, money } from "./money.ts";

function transformOrIssue<In, Out>(parse: (value: In) => Out) {
	return (value: In, ctx: z.RefinementCtx<In>): Out => {
		try {
			return parse(value);
		} catch (error) {
			ctx.addIssue({
				code: "custom",
				message: error instanceof Error ? error.message : String(error),
			});
			return z.NEVER;
		}
	};
}

const monthSchema = z.string().transform(transformOrIssue(parseMonth));

/** Validates and parses an ISO date string into a branded IsoDate. */
export const IsoDateSchema = z.string().transform(transformOrIssue(parseIsoDate));

/** Validates and parses a `{ minor, currency }` pair into a branded Money. */
export const MoneySchema = z
	.object({ minor: z.number(), currency: z.string() })
	.transform(
		transformOrIssue((value: { minor: number; currency: string }) =>
			money(value.minor, currency(value.currency))
		)
	);

const documentOriginSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("gmail"),
		messageId: z.string(),
		attachmentId: z.string(),
		from: z.string(),
		subject: z.string(),
		receivedAt: IsoDateSchema,
	}),
	z.object({ kind: z.literal("stripe"), invoiceId: z.string() }),
	z.object({ kind: z.literal("statement"), source: z.string(), account: z.string() }),
	z.object({ kind: z.literal("file"), path: z.string() }),
]);

const transactionSchema = z.object({
	id: z.string(),
	source: z.string(),
	bookedAt: IsoDateSchema,
	direction: z.enum(["in", "out"]),
	amount: MoneySchema,
	/** What the counterparty billed before the bank's FX conversion, when it differs from `amount`. */
	original: MoneySchema.optional(),
	counterparty: z.string(),
	reference: z.string(),
});

const documentSchema = z.object({
	id: z.string(),
	origin: documentOriginSchema,
	filename: z.string(),
	mime: z.string(),
	fetchedAt: IsoDateSchema,
});

/** Validates an Extraction, as produced by an extractor or set by hand over MCP. */
export const ExtractionSchema = z.object({
	kind: z.enum(["invoice", "receipt", "credit_note", "statement", "other"]),
	side: z.enum(["expense", "revenue"]),
	party: z.string(),
	issuedAt: IsoDateSchema,
	total: MoneySchema,
	tax: MoneySchema.nullable(),
	number: z.string().nullable(),
	category: z.string().nullable(),
	confidence: z.number().min(0).max(1),
	by: z.enum(["source", "claude", "agent"]),
});

/** Validates a Match record. */
export const MatchSchema = z.object({
	transactionId: z.string(),
	documentId: z.string(),
	rule: z.enum(["manual", "amount-date", "amount-date-party"]),
	score: z.number().min(0).max(1),
});

/** Validates a Decision, as set by hand over MCP's "decide" tool. */
export const DecisionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("personal") }),
	z.object({ kind: z.literal("no-document"), reason: z.string() }),
	z.object({ kind: z.literal("duplicate"), of: z.string() }),
	z.object({ kind: z.literal("ignore"), reason: z.string() }),
]);

/**
 * Validates an entire Ledger as persisted to ledger.json.
 *
 * Structural validation only: ids are opaque strings here, not re-derived,
 * since a saved ledger's ids were already validated when they were created.
 */
export const LedgerSchema = z.object({
	month: monthSchema,
	transactions: z.record(z.string(), transactionSchema),
	documents: z.record(z.string(), documentSchema),
	extractions: z.record(z.string(), ExtractionSchema),
	matches: z.array(MatchSchema),
	decisions: z.record(z.string(), DecisionSchema),
});
