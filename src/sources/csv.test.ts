import { describe, expect, test } from "bun:test";
import { parseCsv, parseCsvRecords } from "./csv.ts";

describe("parseCsv", () => {
	test("splits plain comma-separated rows", () => {
		expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
			["a", "b", "c"],
			["1", "2", "3"],
		]);
	});

	test("keeps a comma inside a quoted field", () => {
		expect(parseCsv('"Doe, Jane",42\n')).toEqual([["Doe, Jane", "42"]]);
	});

	test("unescapes doubled quotes inside a quoted field", () => {
		expect(parseCsv('"She said ""hi""",ok\n')).toEqual([['She said "hi"', "ok"]]);
	});

	test("handles CRLF line endings", () => {
		expect(parseCsv("a,b\r\n1,2\r\n3,4\r\n")).toEqual([
			["a", "b"],
			["1", "2"],
			["3", "4"],
		]);
	});

	test("handles a bare LF file with no trailing newline", () => {
		expect(parseCsv("a,b\n1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	test("returns only the header for a header-only file", () => {
		expect(parseCsv("a,b,c\n")).toEqual([["a", "b", "c"]]);
	});

	test("returns nothing for an empty file", () => {
		expect(parseCsv("")).toEqual([]);
	});

	test("keeps empty fields", () => {
		expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
	});
});

describe("parseCsvRecords", () => {
	test("keys each row by the header", () => {
		const records = parseCsvRecords('name,age\n"Doe, Jane",30\nBob,25\n');
		expect(records).toEqual([
			{ name: "Doe, Jane", age: "30" },
			{ name: "Bob", age: "25" },
		]);
	});

	test("returns no records for a header-only file", () => {
		expect(parseCsvRecords("name,age\n")).toEqual([]);
	});

	test("fills a short row's missing trailing columns with empty strings", () => {
		expect(parseCsvRecords("a,b,c\n1,2\n")).toEqual([{ a: "1", b: "2", c: "" }]);
	});
});
