import { describe, expect, test } from "bun:test";
import { ATTACHMENT_BASE64URL, ATTACHMENT_BYTES } from "../../fixtures/gmail/attachments.ts";
import {
	brokenMessageId,
	invoiceMessage,
	nestedInvoiceMessage,
	noAttachmentMessage,
	tinyAttachmentMessage,
} from "../../fixtures/gmail/messages.ts";
import type { Month } from "../core/types.ts";
import {
	buildGmailQuery,
	createGmailSource,
	decodeBase64Url,
	type GmailAttachmentParams,
	type GmailClient,
	type GmailGetParams,
	type GmailListParams,
	type GmailListResponse,
	type GmailMessage,
} from "./gmail.ts";

const DEFAULT_TERMS =
	'has:attachment filename:pdf (invoice OR receipt OR facture OR reçu OR "payment confirmation" OR "order confirmation")';

describe("buildGmailQuery", () => {
	test("scopes to the month with no senders and no extra query", () => {
		const query = buildGmailQuery({ month: "2024-01" as Month });
		expect(query).toBe(`${DEFAULT_TERMS} after:2024/01/01 before:2024/02/01`);
	});

	test("adds an OR'd from: clause when senders are given", () => {
		const query = buildGmailQuery({
			month: "2024-01" as Month,
			senders: ["billing@vendor.example", "receipts@shop.example"],
		});
		expect(query).toBe(
			`${DEFAULT_TERMS} after:2024/01/01 before:2024/02/01 from:(billing@vendor.example OR receipts@shop.example)`
		);
	});

	test("ignores an empty senders list", () => {
		const query = buildGmailQuery({ month: "2024-01" as Month, senders: [] });
		expect(query).toBe(`${DEFAULT_TERMS} after:2024/01/01 before:2024/02/01`);
	});

	test("appends the caller's extra query verbatim", () => {
		const query = buildGmailQuery({ month: "2024-01" as Month, query: "-label:archived" });
		expect(query).toBe(`${DEFAULT_TERMS} after:2024/01/01 before:2024/02/01 -label:archived`);
	});

	test("uses the first day of the next month as the exclusive upper bound, across a year boundary", () => {
		const query = buildGmailQuery({ month: "2024-12" as Month });
		expect(query).toContain("after:2024/12/01");
		expect(query).toContain("before:2025/01/01");
	});

	test("handles a leap-year February", () => {
		const query = buildGmailQuery({ month: "2024-02" as Month });
		expect(query).toContain("after:2024/02/01");
		expect(query).toContain("before:2024/03/01");
	});
});

describe("decodeBase64Url", () => {
	test("round-trips the exact bytes Gmail's attachments.get would return", () => {
		const decoded = decodeBase64Url(ATTACHMENT_BASE64URL["att-invoice-1"] as string);
		expect(
			Buffer.from(decoded).equals(Buffer.from(ATTACHMENT_BYTES["att-invoice-1"] as Uint8Array))
		).toBe(true);
	});
});

interface FakeGmailConfig {
	readonly pages: readonly GmailListResponse[];
	readonly messages: Readonly<Record<string, GmailMessage>>;
	readonly attachments?: Readonly<Record<string, string>>;
	readonly failing?: ReadonlySet<string>;
}

interface FakeGmailCalls {
	list: number;
	get: string[];
	attachments: string[];
}

function createFakeGmail(config: FakeGmailConfig): { gmail: GmailClient; calls: FakeGmailCalls } {
	const calls: FakeGmailCalls = { list: 0, get: [], attachments: [] };
	let pageIndex = 0;

	const gmail: GmailClient = {
		users: {
			messages: {
				list(_params: GmailListParams) {
					const page = config.pages[pageIndex];
					pageIndex += 1;
					calls.list += 1;
					if (page === undefined) throw new Error("fake gmail: no more pages configured");
					return Promise.resolve({ data: page });
				},
				get(params: GmailGetParams) {
					calls.get.push(params.id);
					if (config.failing?.has(params.id)) {
						return Promise.reject(new Error(`synthetic failure for ${params.id}`));
					}
					const message = config.messages[params.id];
					if (message === undefined) {
						return Promise.reject(new Error(`fake gmail: no fixture message for ${params.id}`));
					}
					return Promise.resolve({ data: message });
				},
				attachments: {
					get(params: GmailAttachmentParams) {
						calls.attachments.push(params.id);
						const data = config.attachments?.[params.id];
						if (data === undefined) {
							return Promise.reject(
								new Error(`fake gmail: no fixture attachment for ${params.id}`)
							);
						}
						return Promise.resolve({ data: { data } });
					},
				},
			},
		},
	};

	return { gmail, calls };
}

const MONTH = "2024-01" as Month;

describe("createGmailSource", () => {
	test("paginates through nextPageToken and collects messages from every page", async () => {
		const { gmail, calls } = createFakeGmail({
			pages: [
				{ messages: [{ id: invoiceMessage.id as string }], nextPageToken: "page-2" },
				{ messages: [{ id: nestedInvoiceMessage.id as string }], nextPageToken: null },
			],
			messages: {
				[invoiceMessage.id as string]: invoiceMessage,
				[nestedInvoiceMessage.id as string]: nestedInvoiceMessage,
			},
			attachments: ATTACHMENT_BASE64URL,
		});

		const source = createGmailSource({ gmail });
		const documents = await source.fetchDocuments(MONTH);

		expect(calls.list).toBe(2);
		expect(documents.length).toBe(2);
	});

	test("walks a nested multipart tree and extracts the PDF regardless of depth or mime naming", async () => {
		const { gmail } = createFakeGmail({
			pages: [{ messages: [{ id: nestedInvoiceMessage.id as string }] }],
			messages: { [nestedInvoiceMessage.id as string]: nestedInvoiceMessage },
			attachments: ATTACHMENT_BASE64URL,
		});

		const source = createGmailSource({ gmail });
		const [document] = await source.fetchDocuments(MONTH);

		expect(document?.filename).toBe("receipt.PDF");
		expect(document?.mime).toBe("application/pdf");
		expect(document?.origin).toEqual({
			kind: "gmail",
			messageId: "msg-invoice-2",
			attachmentId: "att-invoice-2",
			from: "receipts@shop.example",
			subject: "Receipt attached",
			receivedAt: "2024-02-01",
		});
	});

	test("decodes the downloaded attachment to the exact original bytes", async () => {
		const { gmail } = createFakeGmail({
			pages: [{ messages: [{ id: invoiceMessage.id as string }] }],
			messages: { [invoiceMessage.id as string]: invoiceMessage },
			attachments: ATTACHMENT_BASE64URL,
		});

		const source = createGmailSource({ gmail });
		const [document] = await source.fetchDocuments(MONTH);

		expect(document).toBeDefined();
		expect(
			Buffer.from(document?.bytes as Uint8Array).equals(
				Buffer.from(ATTACHMENT_BYTES["att-invoice-1"] as Uint8Array)
			)
		).toBe(true);
	});

	test("skips an attachment already reported under the 1KB floor without downloading it", async () => {
		const { gmail, calls } = createFakeGmail({
			pages: [{ messages: [{ id: tinyAttachmentMessage.id as string }] }],
			messages: { [tinyAttachmentMessage.id as string]: tinyAttachmentMessage },
			attachments: ATTACHMENT_BASE64URL,
		});

		const source = createGmailSource({ gmail });
		const documents = await source.fetchDocuments(MONTH);

		expect(documents.length).toBe(0);
		expect(calls.attachments).not.toContain("att-tiny");
	});

	test("returns no documents for a message with no PDF part", async () => {
		const { gmail } = createFakeGmail({
			pages: [{ messages: [{ id: noAttachmentMessage.id as string }] }],
			messages: { [noAttachmentMessage.id as string]: noAttachmentMessage },
		});

		const source = createGmailSource({ gmail });
		const documents = await source.fetchDocuments(MONTH);

		expect(documents.length).toBe(0);
	});

	test("logs and skips a message that fails, while still returning the others", async () => {
		const logs: string[] = [];
		const { gmail } = createFakeGmail({
			pages: [
				{
					messages: [
						{ id: invoiceMessage.id as string },
						{ id: brokenMessageId },
						{ id: nestedInvoiceMessage.id as string },
					],
				},
			],
			messages: {
				[invoiceMessage.id as string]: invoiceMessage,
				[nestedInvoiceMessage.id as string]: nestedInvoiceMessage,
			},
			attachments: ATTACHMENT_BASE64URL,
			failing: new Set([brokenMessageId]),
		});

		const source = createGmailSource({ gmail, log: (message) => logs.push(message) });
		const documents = await source.fetchDocuments(MONTH);

		expect(documents.length).toBe(2);
		expect(logs.some((line) => line.includes(brokenMessageId))).toBe(true);
	});
});
