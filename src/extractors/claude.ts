import Anthropic from "@anthropic-ai/sdk";
import type { Extractor } from "../core/registry.ts";
import type { Document, Extraction } from "../core/types.ts";
import { buildExtractionPrompt } from "./prompt.ts";
import { decimalExtractionJsonSchema, extractionFromDecimalInput } from "./schema.ts";

export const DEFAULT_MODEL = "claude-opus-5";
export const MAX_ATTEMPTS = 2;
const TOOL_NAME = "record_extraction";
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

function extractionTool(): Anthropic.Tool {
	return {
		name: TOOL_NAME,
		description: "Records the structured fields extracted from a financial document.",
		strict: true,
		input_schema: decimalExtractionJsonSchema() as Anthropic.Tool.InputSchema,
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
					return extractionFromDecimalInput(toolUse.input, "claude");
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
