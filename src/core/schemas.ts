import { z } from "zod";
import { parseMonth } from "./dates.ts";
import { ExtractionSchema, isoDateSchema, moneySchema } from "./extraction-schema.ts";

const monthSchema = z.string().transform((value: string, ctx: z.RefinementCtx) => {
	try {
		return parseMonth(value);
	} catch (error) {
		ctx.addIssue({
			code: "custom",
			message: error instanceof Error ? error.message : String(error),
		});
		return z.NEVER;
	}
});

const documentOriginSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("gmail"),
		messageId: z.string(),
		attachmentId: z.string(),
		from: z.string(),
		subject: z.string(),
		receivedAt: isoDateSchema,
	}),
	z.object({ kind: z.literal("stripe"), invoiceId: z.string() }),
	z.object({ kind: z.literal("statement"), source: z.string(), account: z.string() }),
	z.object({ kind: z.literal("file"), path: z.string() }),
]);

/** Validates a Transaction as persisted to ledger.json. */
export const TransactionSchema = z.object({
	id: z.string(),
	source: z.string(),
	bookedAt: isoDateSchema,
	direction: z.enum(["in", "out"]),
	amount: moneySchema,
	/** What the counterparty billed before the bank's FX conversion, when it differs from `amount`. */
	original: moneySchema.optional(),
	counterparty: z.string(),
	reference: z.string(),
});

/** Validates a Document as persisted to ledger.json. */
export const DocumentSchema = z.object({
	id: z.string(),
	origin: documentOriginSchema,
	filename: z.string(),
	mime: z.string(),
	fetchedAt: isoDateSchema,
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

/** An Extraction as it is stored on a ledger, with its provenance stamped. */
const ledgerExtractionSchema = ExtractionSchema.extend({
	by: z.enum(["source", "claude", "agent"]),
});

/**
 * Validates an entire Ledger as persisted to ledger.json.
 *
 * Structural validation only: ids are opaque strings here, not re-derived,
 * since a saved ledger's ids were already validated when they were created.
 */
export const LedgerSchema = z.object({
	month: monthSchema,
	transactions: z.record(z.string(), TransactionSchema),
	documents: z.record(z.string(), DocumentSchema),
	extractions: z.record(z.string(), ledgerExtractionSchema),
	matches: z.array(MatchSchema),
	decisions: z.record(z.string(), DecisionSchema),
});
