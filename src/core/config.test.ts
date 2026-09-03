import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
	test("fills defaults for an empty config", () => {
		const config = parseConfig({});
		expect(config.matching).toEqual({ dateWindowDays: 5, threshold: 0.6 });
		expect(config.sources).toEqual({});
		expect(config.sinks).toEqual({});
		expect(config.categories).toEqual({});
	});

	test("keeps explicit values and defaults nested fields", () => {
		const config = parseConfig({
			sources: { gmail: {} },
			sinks: { sheets: { spreadsheetId: "abc" } },
			matching: { threshold: 0.8 },
		});
		expect(config.sources.gmail?.senders).toEqual([]);
		expect(config.sinks.sheets?.sheetName).toBe("Ledger");
		expect(config.matching).toEqual({ dateWindowDays: 5, threshold: 0.8 });
	});

	test("rejects a threshold above 1", () => {
		expect(() => parseConfig({ matching: { threshold: 2 } })).toThrow();
	});
});
