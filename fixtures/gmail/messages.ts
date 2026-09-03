import type { GmailMessage } from "../../src/sources/gmail.ts";

/** Single-part message: one PDF invoice attachment, well above the 1KB floor. */
export const invoiceMessage: GmailMessage = {
	id: "msg-invoice-1",
	internalDate: "1704067200000",
	payload: {
		mimeType: "multipart/mixed",
		headers: [
			{ name: "From", value: "billing@vendor.example" },
			{ name: "Subject", value: "Your January invoice" },
		],
		parts: [
			{ mimeType: "text/plain", body: { data: "aGVsbG8", size: 5 } },
			{
				mimeType: "application/pdf",
				filename: "invoice-2024-01.pdf",
				body: { attachmentId: "att-invoice-1", size: 20_480 },
			},
		],
	},
};

/** Nested multipart/alternative wrapping a PDF two levels deep, with no size hint on the body. */
export const nestedInvoiceMessage: GmailMessage = {
	id: "msg-invoice-2",
	internalDate: "1706745600000",
	payload: {
		mimeType: "multipart/mixed",
		headers: [
			{ name: "From", value: "receipts@shop.example" },
			{ name: "Subject", value: "Receipt attached" },
		],
		parts: [
			{
				mimeType: "multipart/alternative",
				parts: [
					{ mimeType: "text/plain", body: { data: "aGk", size: 2 } },
					{ mimeType: "text/html", body: { data: "PGI+aGk8L2I+", size: 12 } },
				],
			},
			{
				mimeType: "application/octet-stream",
				filename: "receipt.PDF",
				body: { attachmentId: "att-invoice-2" },
			},
		],
	},
};

/** Attachment metadata already reports a size under the 1KB floor; must be skipped without a download. */
export const tinyAttachmentMessage: GmailMessage = {
	id: "msg-tiny",
	internalDate: "1704067200000",
	payload: {
		mimeType: "multipart/mixed",
		headers: [
			{ name: "From", value: "noise@example.com" },
			{ name: "Subject", value: "Not really a receipt" },
		],
		parts: [
			{
				mimeType: "application/pdf",
				filename: "tiny.pdf",
				body: { attachmentId: "att-tiny", size: 42 },
			},
		],
	},
};

/** No PDF anywhere in the tree; must contribute zero documents. */
export const noAttachmentMessage: GmailMessage = {
	id: "msg-no-attachment",
	internalDate: "1704067200000",
	payload: {
		mimeType: "text/plain",
		headers: [
			{ name: "From", value: "person@example.com" },
			{ name: "Subject", value: "Just saying hi" },
		],
		body: { data: "aGVsbG8", size: 5 },
	},
};

/** get() for this id throws in the fake client, to test per-message failure isolation. */
export const brokenMessageId = "msg-broken";
