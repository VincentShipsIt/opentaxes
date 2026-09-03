import { describe, expect, test } from "bun:test";
import {
	daysBetween,
	isInMonth,
	monthBounds,
	monthOf,
	parseIsoDate,
	parseMonth,
	previousMonth,
	toIsoDate,
} from "./dates.ts";

describe("dates", () => {
	test("parseMonth accepts YYYY-MM only", () => {
		expect<string>(parseMonth("2026-09")).toBe("2026-09");
		expect(() => parseMonth("2026-13")).toThrow();
		expect(() => parseMonth("2026-9")).toThrow();
	});

	test("parseIsoDate rejects impossible calendar dates", () => {
		expect<string>(parseIsoDate("2026-02-28")).toBe("2026-02-28");
		expect(() => parseIsoDate("2026-02-30")).toThrow();
		expect(() => parseIsoDate("2026-2-3")).toThrow();
	});

	test("toIsoDate uses the UTC calendar day", () => {
		expect<string>(toIsoDate("2026-09-03T23:30:00+02:00")).toBe("2026-09-03");
		expect<string>(toIsoDate(new Date(Date.UTC(2026, 0, 31, 23, 59)))).toBe("2026-01-31");
	});

	test("monthBounds covers leap and short months", () => {
		expect<Record<string, string>>(monthBounds(parseMonth("2024-02"))).toEqual({
			start: "2024-02-01",
			end: "2024-02-29",
		});
		expect<Record<string, string>>(monthBounds(parseMonth("2026-12"))).toEqual({
			start: "2026-12-01",
			end: "2026-12-31",
		});
	});

	test("previousMonth wraps the year", () => {
		expect<string>(previousMonth(new Date(Date.UTC(2026, 0, 15)))).toBe("2025-12");
		expect<string>(previousMonth(new Date(Date.UTC(2026, 8, 3)))).toBe("2026-08");
	});

	test("daysBetween is symmetric and whole", () => {
		const a = parseIsoDate("2026-09-01");
		const b = parseIsoDate("2026-09-06");
		expect(daysBetween(a, b)).toBe(5);
		expect(daysBetween(b, a)).toBe(5);
		expect(daysBetween(a, a)).toBe(0);
	});

	test("monthOf and isInMonth agree", () => {
		const date = parseIsoDate("2026-09-30");
		expect<string>(monthOf(date)).toBe("2026-09");
		expect(isInMonth(date, parseMonth("2026-09"))).toBe(true);
		expect(isInMonth(date, parseMonth("2026-10"))).toBe(false);
	});
});
