import { describe, expect, test } from "bun:test";
import { parseIsoDate } from "./dates.ts";
import { currency, money } from "./money.ts";
import { documentFilename, extensionOf, slug, uniqueFilenames } from "./naming.ts";
import type { Document, DocumentId, Extraction } from "./types.ts";

const USD = currency("USD");

function extraction(overrides: Partial<Extraction> = {}): Extraction {
	return {
		kind: "invoice",
		side: "expense",
		party: "Acme Supplies Ltd.",
		issuedAt: parseIsoDate("2026-08-14"),
		total: money(4250, USD),
		tax: null,
		number: null,
		category: null,
		confidence: 0.9,
		by: "claude",
		...overrides,
	};
}

function document(overrides: Partial<Document> = {}): Document {
	return {
		id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" as DocumentId,
		origin: { kind: "file", path: "/tmp/invoice.pdf" },
		filename: "Invoice #123 (final copy).pdf",
		mime: "application/pdf",
		fetchedAt: parseIsoDate("2026-08-15"),
		...overrides,
	};
}

describe("slug", () => {
	test("lowercases, ascii-folds and hyphenates", () => {
		expect(slug("Café René & Co.")).toBe("cafe-rene-co");
	});

	test("collapses repeated separators and trims edges", () => {
		expect(slug("  Acme --- Supplies!!  ")).toBe("acme-supplies");
	});

	test("caps at 40 characters without a trailing hyphen", () => {
		const long = slug("a".repeat(50));
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long.endsWith("-")).toBe(false);
	});
});

describe("extensionOf", () => {
	test("prefers the mime type", () => {
		expect(extensionOf("application/pdf", "receipt.unknown")).toBe("pdf");
	});

	test("falls back to the filename extension", () => {
		expect(extensionOf("application/octet-stream", "statement.csv")).toBe("csv");
	});

	test("defaults to bin when nothing matches", () => {
		expect(extensionOf("application/octet-stream", "statement")).toBe("bin");
	});
});

describe("documentFilename", () => {
	test("builds date_party_amount-currency with an extraction", () => {
		const doc = document();
		const name = documentFilename(doc, extraction());
		expect(name).toBe("2026-08-14_acme-supplies-ltd_42.50-USD.pdf");
	});

	test("appends the invoice number slug before the extension", () => {
		const doc = document();
		const name = documentFilename(doc, extraction({ number: "INV-2026-0091" }));
		expect(name).toBe("2026-08-14_acme-supplies-ltd_42.50-USD_inv-2026-0091.pdf");
	});

	test("falls back to the unread form without an extraction", () => {
		const doc = document({
			id: "deadbeefcafef00d0000000000000000000000000000000000000000000000" as DocumentId,
			filename: "Scan (1).pdf",
		});
		const name = documentFilename(doc, undefined);
		expect(name).toBe("unread_deadbeef_scan-1.pdf");
	});

	test("is deterministic for the same inputs", () => {
		const doc = document();
		const ext = extraction();
		expect(documentFilename(doc, ext)).toBe(documentFilename(doc, ext));
	});
});

describe("uniqueFilenames", () => {
	test("disambiguates two documents that would otherwise share a filename", () => {
		const ext = extraction();
		const first = document({
			id: "aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11" as DocumentId,
		});
		const second = document({
			id: "bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22" as DocumentId,
		});

		const filenames = uniqueFilenames([first, second], {
			[first.id]: ext,
			[second.id]: ext,
		} as Record<DocumentId, Extraction>);

		expect(filenames[first.id]).toBe(documentFilename(first, ext));
		expect(filenames[second.id]).toBe("2026-08-14_acme-supplies-ltd_42.50-USD_bb22bb22.pdf");
		expect(filenames[first.id]).not.toBe(filenames[second.id]);
	});

	test("leaves distinct filenames untouched", () => {
		const first = document({
			id: "aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11" as DocumentId,
		});
		const second = document({
			id: "bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22" as DocumentId,
		});
		const extractions = {
			[first.id]: extraction(),
			[second.id]: extraction({ party: "Totally Different Vendor" }),
		} as Record<DocumentId, Extraction>;

		const filenames = uniqueFilenames([first, second], extractions);

		expect(filenames[first.id]).toBe(documentFilename(first, extractions[first.id]));
		expect(filenames[second.id]).toBe(documentFilename(second, extractions[second.id]));
	});
});
