/** Synthetic PDF-shaped bytes for gmail.test.ts; no real document content. */
function fakePdfBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	const header = new TextEncoder().encode("%PDF-1.4\n");
	bytes.set(header.subarray(0, Math.min(header.length, size)));
	return bytes;
}

/** Raw synthetic attachment bytes keyed by the attachmentId used in fixtures/gmail/messages.ts. */
export const ATTACHMENT_BYTES: Readonly<Record<string, Uint8Array>> = {
	"att-invoice-1": fakePdfBytes(20_480),
	"att-invoice-2": fakePdfBytes(8_192),
	"att-tiny": fakePdfBytes(42),
};

/** Same payloads, base64url encoded the way users.messages.attachments.get returns them. */
export const ATTACHMENT_BASE64URL: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(ATTACHMENT_BYTES).map(([id, bytes]) => [
		id,
		Buffer.from(bytes).toString("base64url"),
	])
);
