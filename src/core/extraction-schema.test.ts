import { describe, expect, test } from "bun:test";
import { parseIsoDate } from "./dates.ts";
import { extractionJsonSchema, parseExtraction } from "./extraction-schema.ts";
import { currency } from "./money.ts";

function validRaw() {
	return {
		kind: "invoice",
		side: "expense",
		party: "Acme Vendor",
		issuedAt: "2026-01-15",
		total: { minor: 12345, currency: "usd" },
		tax: { minor: 2345, currency: "USD" },
		number: "INV-1",
		category: "software",
		confidence: 0.9,
	};
}

describe("parseExtraction", () => {
	test("parses a valid raw extraction and stamps by", () => {
		const extraction = parseExtraction(validRaw(), "claude");
		expect(extraction).toEqual({
			kind: "invoice",
			side: "expense",
			party: "Acme Vendor",
			issuedAt: parseIsoDate("2026-01-15"),
			total: { minor: 12345, currency: currency("USD") },
			tax: { minor: 2345, currency: currency("USD") },
			number: "INV-1",
			category: "software",
			confidence: 0.9,
			by: "claude",
		});
	});

	test("allows null tax, number and category", () => {
		const raw = { ...validRaw(), tax: null, number: null, category: null };
		const extraction = parseExtraction(raw, "agent");
		expect(extraction.tax).toBeNull();
		expect(extraction.number).toBeNull();
		expect(extraction.category).toBeNull();
		expect(extraction.by).toBe("agent");
	});

	test("stamps by from the argument, ignoring any by on the raw input", () => {
		const raw = { ...validRaw(), by: "source" };
		expect(parseExtraction(raw, "claude").by).toBe("claude");
	});

	test("rejects an invalid issuedAt", () => {
		expect(() => parseExtraction({ ...validRaw(), issuedAt: "2026-13-40" }, "claude")).toThrow();
		expect(() => parseExtraction({ ...validRaw(), issuedAt: "not-a-date" }, "claude")).toThrow();
	});

	test("rejects an invalid currency", () => {
		expect(() =>
			parseExtraction({ ...validRaw(), total: { minor: 100, currency: "US" } }, "claude")
		).toThrow();
	});

	test("rejects confidence out of range", () => {
		expect(() => parseExtraction({ ...validRaw(), confidence: 1.5 }, "claude")).toThrow();
		expect(() => parseExtraction({ ...validRaw(), confidence: -0.1 }, "claude")).toThrow();
	});

	test("rejects non-integer minor units", () => {
		expect(() =>
			parseExtraction({ ...validRaw(), total: { minor: 12.5, currency: "USD" } }, "claude")
		).toThrow();
	});

	test("rejects an empty party", () => {
		expect(() => parseExtraction({ ...validRaw(), party: "" }, "claude")).toThrow();
	});

	test("rejects an unknown kind or side", () => {
		expect(() => parseExtraction({ ...validRaw(), kind: "warranty" }, "claude")).toThrow();
		expect(() => parseExtraction({ ...validRaw(), side: "neither" }, "claude")).toThrow();
	});
});

describe("extractionJsonSchema", () => {
	test("describes the model-facing fields as a JSON schema object", () => {
		expect(extractionJsonSchema.type).toBe("object");
		const properties = extractionJsonSchema.properties as Record<string, unknown>;
		for (const field of [
			"kind",
			"side",
			"party",
			"issuedAt",
			"total",
			"tax",
			"number",
			"category",
			"confidence",
		]) {
			expect(properties[field]).toBeDefined();
		}
		expect(properties.by).toBeUndefined();
	});
});
