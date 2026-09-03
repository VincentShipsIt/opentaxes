import { z } from "zod";
import { parseIsoDate } from "./dates.ts";
import { currency, money } from "./money.ts";
import type { ExtractedBy, Extraction } from "./types.ts";

const DOCUMENT_KINDS = ["invoice", "receipt", "credit_note", "statement", "other"] as const;
const SIDES = ["expense", "revenue"] as const;

/** Runs a throwing pure function inside a zod transform, turning its error into a zod issue. */
function transformOrIssue<In, Out>(parse: (value: In) => Out) {
	return (value: In, ctx: z.RefinementCtx): Out => {
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

const moneySchema = z
	.object({ minor: z.number(), currency: z.string() })
	.transform(
		transformOrIssue((value: { minor: number; currency: string }) =>
			money(value.minor, currency(value.currency))
		)
	);

const isoDateSchema = z.string().transform(transformOrIssue(parseIsoDate));

/**
 * Validates the shape an `Extraction` carries once money and dates have already been
 * normalized to their canonical forms. `by` is not accepted here — `parseExtraction`
 * always stamps it from its own argument, never from untrusted input.
 */
export const ExtractionSchema = z.object({
	kind: z.enum(DOCUMENT_KINDS),
	side: z.enum(SIDES),
	party: z.string().min(1),
	issuedAt: isoDateSchema,
	total: moneySchema,
	tax: moneySchema.nullable(),
	number: z.string().nullable(),
	category: z.string().nullable(),
	confidence: z.number().min(0).max(1),
});

export function parseExtraction(raw: unknown, by: ExtractedBy): Extraction {
	const parsed = ExtractionSchema.parse(raw);
	return { ...parsed, by };
}

/**
 * JSON-schema-shaped description of the fields above, for handing to a model (the Claude
 * extractor, or an agent driving the MCP `set_extraction` tool). Derived from the same
 * schema that validates the result, so the two can never drift.
 */
export const extractionJsonSchema = z.toJSONSchema(ExtractionSchema, { io: "input" });
