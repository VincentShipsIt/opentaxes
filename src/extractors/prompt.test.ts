import { describe, expect, test } from "bun:test";
import { buildExtractionPrompt } from "./prompt.ts";

describe("buildExtractionPrompt", () => {
	test("includes selfName so the model can tell the counterparty apart", () => {
		const prompt = buildExtractionPrompt({ selfName: "Acme Consulting LLC" });
		expect(prompt).toContain("Acme Consulting LLC");
	});

	test("still produces guidance when selfName is omitted", () => {
		const prompt = buildExtractionPrompt();
		expect(prompt).toContain("record_extraction");
		expect(prompt.length).toBeGreaterThan(0);
	});

	test("mentions every field the tool call must fill in", () => {
		const prompt = buildExtractionPrompt({ selfName: "Acme" });
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
			expect(prompt).toContain(field);
		}
	});

	test("instructs decimal amount plus currency code for money fields", () => {
		const prompt = buildExtractionPrompt();
		expect(prompt.toLowerCase()).toContain("decimal");
		expect(prompt).toContain("currency code");
	});
});
