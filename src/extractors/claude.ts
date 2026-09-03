import Anthropic from "@anthropic-ai/sdk";
import { extractionJsonSchema, parseExtraction } from "../core/extraction-schema.ts";
import { currency, moneyFromDecimal } from "../core/money.ts";
import type { Extractor } from "../core/registry.ts";
import type { Document, Extraction, Money } from "../core/types.ts";
import { buildExtractionPrompt } from "./prompt.ts";

const DEFAULT_MODEL = "claude-opus-5";
const TOOL_NAME = "record_extraction";
const MAX_ATTEMPTS = 2;
const SUPPORTED_MIMES = ["application/pdf", "image/png", "image/jpeg"] as const;

type SupportedMime = (typeof SUPPORTED_MIMES)[number];

/** The slice of the Anthropic client this extractor needs, so tests can inject a fake. */
export interface ClaudeMessagesClient {
	messages: {
		create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
	};
}

export interface CreateClaudeExtractorOptions {
	readonly apiKey: string;
	readonly model?: string;
	/** The ledger owner's own business name, passed through to the prompt. */
	readonly selfName?: string;
	readonly client?: ClaudeMessagesClient;
}

function isSupportedMime(mime: string): mime is SupportedMime {
	return (SUPPORTED_MIMES as readonly string[]).includes(mime);
}

function documentContentBlock(
	mime: SupportedMime,
	data: string
): Anthropic.Messages.ContentBlockParam {
	if (mime === "application/pdf") {
		return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
	}
	return { type: "image", source: { type: "base64", media_type: mime, data } };
}

/**
 * Reuses the canonical JSON schema from extraction-schema.ts, but asks the model for money as a
 * decimal amount plus a currency code rather than pre-computed minor units — a vision model reads
 * a printed total directly, while minor-unit math needs a currency's decimal precision (e.g. JPY
 * has none), which is exactly what `moneyFromDecimal` applies once the amount comes back.
 */
function toolInputSchema(): Anthropic.Tool.InputSchema {
	const decimalMoney = {
		type: "object",
		properties: {
			amount: { type: "string", description: 'Decimal amount, e.g. "1234.56".' },
			currency: { type: "string", description: 'ISO 4217 code, e.g. "USD".' },
		},
		required: ["amount", "currency"],
		additionalProperties: false,
	};
	const base = extractionJsonSchema as { properties: Record<string, unknown> };
	return {
		type: "object",
		properties: {
			...base.properties,
			total: decimalMoney,
			tax: { anyOf: [decimalMoney, { type: "null" }] },
		},
		required: [
			"kind",
			"side",
			"party",
			"issuedAt",
			"total",
			"tax",
			"number",
			"category",
			"confidence",
		],
		additionalProperties: false,
	};
}

function extractionTool(): Anthropic.Tool {
	return {
		name: TOOL_NAME,
		description: "Records the structured fields extracted from a financial document.",
		strict: true,
		input_schema: toolInputSchema(),
	};
}

interface DecimalMoneyInput {
	readonly amount: string;
	readonly currency: string;
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

function normalizeToolInput(rawInput: unknown): unknown {
	if (typeof rawInput !== "object" || rawInput === null) {
		throw new Error("record_extraction input is not an object");
	}
	const raw = rawInput as Record<string, unknown>;
	return {
		...raw,
		total: toMoney(raw.total, "total"),
		tax: toMoney(raw.tax, "tax"),
	};
}

function findToolUse(message: Anthropic.Message): Anthropic.ToolUseBlock {
	const block = message.content.find(
		(b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME
	);
	if (!block) throw new Error("Claude did not call the record_extraction tool");
	return block;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createClaudeExtractor(options: CreateClaudeExtractorOptions): Extractor {
	const { apiKey, model = DEFAULT_MODEL, selfName, client } = options;
	const anthropic: ClaudeMessagesClient = client ?? new Anthropic({ apiKey });
	const prompt = buildExtractionPrompt(selfName === undefined ? {} : { selfName });
	const tools = [extractionTool()];

	return {
		name: "claude",
		async extract(document: Document, bytes: Uint8Array): Promise<Extraction> {
			if (!isSupportedMime(document.mime)) {
				throw new Error(`unsupported document mime type "${document.mime}" for Claude extraction`);
			}
			const data = Buffer.from(bytes).toString("base64");
			const messages: Anthropic.MessageParam[] = [
				{
					role: "user",
					content: [documentContentBlock(document.mime, data), { type: "text", text: prompt }],
				},
			];

			let lastError: unknown;
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				const response = await anthropic.messages.create({
					model,
					max_tokens: 1024,
					tools,
					tool_choice: { type: "tool", name: TOOL_NAME },
					messages,
				});
				const toolUse = findToolUse(response);
				try {
					return parseExtraction(normalizeToolInput(toolUse.input), "claude");
				} catch (error) {
					lastError = error;
					messages.push({ role: "assistant", content: response.content });
					messages.push({
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUse.id,
								is_error: true,
								content: `Invalid extraction: ${errorMessage(error)}. Call record_extraction again with corrected values.`,
							},
						],
					});
				}
			}
			throw new Error(`Claude extraction failed validation twice: ${errorMessage(lastError)}`);
		},
	};
}
