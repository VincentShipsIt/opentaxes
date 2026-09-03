import { z } from "zod";
import { parseExtraction } from "../core/extraction-schema.ts";
import { currency, moneyFromDecimal } from "../core/money.ts";
import type { ExtractedBy, Extraction, Money } from "../core/types.ts";

const DOCUMENT_KINDS = ["invoice", "receipt", "credit_note", "statement", "other"] as const;
const SIDES = ["expense", "revenue"] as const;

/**
 * A model that reads a document directly (vision, or a Read tool over a file path) reports money
 * as a printed decimal amount plus a currency code, not pre-computed minor units — a currency's
 * decimal precision (e.g. JPY has none) is applied afterward, in `extractionFromDecimalInput`.
 */
export const decimalMoneySchema = z.object({
	amount: z.string().describe('Decimal amount, e.g. "1234.56".'),
	currency: z.string().describe('ISO 4217 code, e.g. "USD".'),
});

export type DecimalMoneyInput = z.infer<typeof decimalMoneySchema>;

/**
 * Mirrors `ExtractionSchema` in core/extraction-schema.ts field-for-field, with `total`/`tax`
 * swapped for `decimalMoneySchema` — the shape both the Claude API tool call and the Claude Code
 * CLI's structured output hand back, before `extractionFromDecimalInput` converts it into the
 * canonical `Extraction`.
 */
export const DecimalExtractionSchema = z.object({
	kind: z.enum(DOCUMENT_KINDS),
	side: z.enum(SIDES),
	party: z.string().min(1),
	issuedAt: z.string(),
	total: decimalMoneySchema,
	tax: decimalMoneySchema.nullable(),
	number: z.string().nullable(),
	category: z.string().nullable(),
	confidence: z.number().min(0).max(1),
});

const REQUIRED_FIELDS = Object.keys(DecimalExtractionSchema.shape);

/**
 * JSON Schema for `DecimalExtractionSchema`, shaped for a strict tool/structured-output
 * contract (every field required, no extras) — both Anthropic's tool `input_schema` and the
 * Claude Code CLI's `--json-schema` accept a plain JSON Schema object here.
 */
export function decimalExtractionJsonSchema(): Record<string, unknown> {
	const schema = z.toJSONSchema(DecimalExtractionSchema, { io: "input" }) as {
		properties: Record<string, unknown>;
	};
	return {
		type: "object",
		properties: schema.properties,
		required: REQUIRED_FIELDS,
		additionalProperties: false,
	};
}

function isDecimalMoneyInput(value: unknown): value is DecimalMoneyInput {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.amount === "string" && typeof candidate.currency === "string";
}

function toMoney(value: unknown, field: string): Money | null {
	if (value === null) return null;
	if (!isDecimalMoneyInput(value)) {
		throw new Error(`extraction field "${field}" is not a decimal amount and currency`);
	}
	return moneyFromDecimal(value.amount, currency(value.currency));
}

/**
 * Converts an untrusted extraction object with decimal-money `total`/`tax` (a tool call's input,
 * or a CLI's structured output) into the canonical `Extraction`, validating every other field
 * through the same `ExtractionSchema` the rest of the app uses.
 */
export function extractionFromDecimalInput(rawInput: unknown, by: ExtractedBy): Extraction {
	if (typeof rawInput !== "object" || rawInput === null) {
		throw new Error("extraction input is not an object");
	}
	const raw = rawInput as Record<string, unknown>;
	return parseExtraction(
		{
			...raw,
			total: toMoney(raw.total, "total"),
			tax: toMoney(raw.tax, "tax"),
		},
		by
	);
}
