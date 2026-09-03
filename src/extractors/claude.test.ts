import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { parseIsoDate } from "../core/dates.ts";
import type { Document, DocumentId } from "../core/types.ts";
import { type ClaudeMessagesClient, createClaudeExtractor } from "./claude.ts";

function fakeMessage(content: Anthropic.ContentBlock[]): Anthropic.Message {
	return {
		id: "msg_test",
		container: null,
		content,
		model: "claude-opus-5",
		role: "assistant",
		stop_details: null,
		stop_reason: "tool_use",
		stop_sequence: null,
		type: "message",
		usage: {
			cache_creation: null,
			cache_creation_input_tokens: null,
			cache_read_input_tokens: null,
			inference_geo: null,
			input_tokens: 100,
			output_tokens: 50,
			output_tokens_details: null,
			server_tool_use: null,
			service_tier: null,
		},
	};
}

function toolUseMessage(input: unknown, id = "toolu_1"): Anthropic.Message {
	return fakeMessage([
		{
			id,
			caller: { type: "direct" },
			input,
			name: "record_extraction",
			type: "tool_use",
		},
	]);
}

function validToolInput() {
	return {
		kind: "invoice",
		side: "expense",
		party: "Acme Vendor",
		issuedAt: "2026-01-15",
		total: { amount: "123.45", currency: "USD" },
		tax: { amount: "23.45", currency: "USD" },
		number: "INV-1",
		category: "software",
		confidence: 0.9,
	};
}

function documentFixture(id: string, mime: string, filename: string): Document {
	return {
		id: id as DocumentId,
		origin: { kind: "file", path: `/fixtures/${filename}` },
		filename,
		mime,
		fetchedAt: parseIsoDate("2026-01-15"),
	};
}

function pdfDocument(): Document {
	return documentFixture("doc_1", "application/pdf", "invoice.pdf");
}

function imageDocument(): Document {
	return documentFixture("doc_2", "image/png", "receipt.png");
}

/** Fake client returning one canned response per call, in order. */
function queuedClient(
	responses: readonly Anthropic.Message[]
): ClaudeMessagesClient & { readonly calls: Anthropic.MessageCreateParamsNonStreaming[] } {
	const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
	let index = 0;
	return {
		calls,
		messages: {
			async create(params) {
				calls.push(params);
				const response = responses[index];
				index += 1;
				if (!response) throw new Error("queuedClient ran out of canned responses");
				return response;
			},
		},
	};
}

describe("createClaudeExtractor", () => {
	test("extracts from a PDF document on the happy path", async () => {
		const client = queuedClient([toolUseMessage(validToolInput())]);
		const extractor = createClaudeExtractor({ apiKey: "test", client });

		const extraction = await extractor.extract(pdfDocument(), new Uint8Array([1, 2, 3]));

		expect(extraction).toEqual({
			kind: "invoice",
			side: "expense",
			party: "Acme Vendor",
			issuedAt: "2026-01-15",
			total: { minor: 12345, currency: "USD" },
			tax: { minor: 2345, currency: "USD" },
			number: "INV-1",
			category: "software",
			confidence: 0.9,
			by: "claude",
		});
		expect(client.calls).toHaveLength(1);
	});

	test("extracts from an image document on the happy path", async () => {
		const client = queuedClient([toolUseMessage(validToolInput())]);
		const extractor = createClaudeExtractor({ apiKey: "test", client });

		const extraction = await extractor.extract(imageDocument(), new Uint8Array([4, 5, 6]));

		expect(extraction.party).toBe("Acme Vendor");
		expect(extraction.by).toBe("claude");
	});

	test("rejects an unsupported mime type without calling the model", async () => {
		const client = queuedClient([toolUseMessage(validToolInput())]);
		const extractor = createClaudeExtractor({ apiKey: "test", client });
		const document = documentFixture("doc_3", "application/zip", "archive.zip");

		await expect(extractor.extract(document, new Uint8Array([1]))).rejects.toThrow(
			/unsupported document mime type/
		);
		expect(client.calls).toHaveLength(0);
	});

	test("retries once after a schema failure and succeeds on the second attempt", async () => {
		const client = queuedClient([
			toolUseMessage({ ...validToolInput(), confidence: 5 }),
			toolUseMessage(validToolInput()),
		]);
		const extractor = createClaudeExtractor({ apiKey: "test", client });

		const extraction = await extractor.extract(pdfDocument(), new Uint8Array([1]));

		expect(extraction.party).toBe("Acme Vendor");
		expect(client.calls).toHaveLength(2);
		const secondCallMessages = client.calls[1]?.messages ?? [];
		const lastMessage = secondCallMessages[secondCallMessages.length - 1];
		expect(lastMessage?.role).toBe("user");
	});

	test("throws after a schema failure on both attempts", async () => {
		const client = queuedClient([
			toolUseMessage({ ...validToolInput(), confidence: 5 }),
			toolUseMessage({ ...validToolInput(), confidence: 5 }),
		]);
		const extractor = createClaudeExtractor({ apiKey: "test", client });

		await expect(extractor.extract(pdfDocument(), new Uint8Array([1]))).rejects.toThrow(
			/failed validation twice/
		);
		expect(client.calls).toHaveLength(2);
	});

	test("includes selfName in the prompt sent to the model", async () => {
		const client = queuedClient([toolUseMessage(validToolInput())]);
		const extractor = createClaudeExtractor({
			apiKey: "test",
			selfName: "Acme Consulting LLC",
			client,
		});

		await extractor.extract(pdfDocument(), new Uint8Array([1]));

		const firstMessage = client.calls[0]?.messages[0];
		const content = firstMessage?.content;
		if (typeof content === "string" || !content) {
			throw new Error("expected structured content blocks");
		}
		const textBlock = content.find(
			(block): block is Anthropic.TextBlockParam => block.type === "text"
		);
		expect(textBlock?.text).toContain("Acme Consulting LLC");
	});
});
