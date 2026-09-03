import { describe, expect, it } from "bun:test";
import { CONFIG_FILENAME } from "../core/config.ts";
import { parseMonth } from "../core/dates.ts";
import { DEFAULT_STATE_DIR } from "../core/registry.ts";
import { resolveConfigPath, resolveMonth, resolveStateDir } from "./deps.ts";

describe("resolveMonth", () => {
	it("defaults to last month when no option is given", () => {
		expect(resolveMonth(undefined, new Date("2026-03-15T00:00:00Z"))).toBe(parseMonth("2026-02"));
	});

	it("rolls over the year when last month is December", () => {
		expect(resolveMonth(undefined, new Date("2026-01-10T00:00:00Z"))).toBe(parseMonth("2025-12"));
	});

	it("parses an explicit YYYY-MM option", () => {
		expect(resolveMonth("2026-06")).toBe(parseMonth("2026-06"));
	});

	it("rejects a malformed month", () => {
		expect(() => resolveMonth("2026-13")).toThrow();
		expect(() => resolveMonth("June 2026")).toThrow();
	});
});

describe("resolveStateDir", () => {
	it("defaults to the shared state dir constant", () => {
		expect(resolveStateDir(undefined)).toBe(DEFAULT_STATE_DIR);
	});

	it("keeps an explicit state dir", () => {
		expect(resolveStateDir("/tmp/custom-state")).toBe("/tmp/custom-state");
	});
});

describe("resolveConfigPath", () => {
	it("defaults to the shared config filename constant", () => {
		expect(resolveConfigPath(undefined)).toBe(CONFIG_FILENAME);
	});

	it("keeps an explicit config path", () => {
		expect(resolveConfigPath("./custom.config.json")).toBe("./custom.config.json");
	});
});
