import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG_TEMPLATE,
	DEFAULT_ENV_EXAMPLE,
	ensureInit,
	fileExists,
	loadConfigFile,
	stripJsonComments,
} from "./config-file.ts";

describe("stripJsonComments", () => {
	it("removes line comments", () => {
		const input = '{\n\t// a comment\n\t"a": 1\n}';
		expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
	});

	it("removes block comments", () => {
		const input = '{\n\t/* a\n\tblock comment */\n\t"a": 1\n}';
		expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
	});

	it("leaves comment-like text inside string literals alone", () => {
		const input = '{ "url": "https://example.com", "note": "not a // comment" }';
		const parsed = JSON.parse(stripJsonComments(input));
		expect(parsed.url).toBe("https://example.com");
		expect(parsed.note).toBe("not a // comment");
	});

	it("does not treat an escaped quote as ending a string", () => {
		const input = String.raw`{ "note": "she said \"hi // there\"" }`;
		const parsed = JSON.parse(stripJsonComments(input));
		expect(parsed.note).toBe('she said "hi // there"');
	});

	it("strips the commented-out example blocks from the default template", () => {
		const parsed = JSON.parse(stripJsonComments(DEFAULT_CONFIG_TEMPLATE));
		expect(parsed).toEqual({
			sources: {},
			sinks: {},
			matching: { dateWindowDays: 5, threshold: 0.6 },
			categories: {},
		});
	});
});

describe("loadConfigFile", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "opentaxes-config-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("throws a clear error when the file is missing", async () => {
		const path = join(dir, "opentaxes.config.json");
		await expect(loadConfigFile(path)).rejects.toThrow(
			`no config at ${path}; run "opentaxes init" first`
		);
	});

	it("parses a config file written with comments", async () => {
		const path = join(dir, "opentaxes.config.json");
		await ensureInit(path, join(dir, ".env.example"), () => {});
		const config = await loadConfigFile(path);
		expect(config.matching.dateWindowDays).toBe(5);
		expect(config.sources).toEqual({});
	});
});

describe("fileExists", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "opentaxes-config-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("is false for a path that doesn't exist", async () => {
		expect(await fileExists(join(dir, "nope.json"))).toBe(false);
	});

	it("is true once the file has been written", async () => {
		const path = join(dir, "opentaxes.config.json");
		await ensureInit(path, join(dir, ".env.example"), () => {});
		expect(await fileExists(path)).toBe(true);
	});
});

describe("ensureInit", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "opentaxes-config-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes both files and logs each write", async () => {
		const configPath = join(dir, "opentaxes.config.json");
		const envPath = join(dir, ".env.example");
		const messages: string[] = [];
		await ensureInit(configPath, envPath, (message) => messages.push(message));
		expect(await readFile(configPath, "utf8")).toBe(DEFAULT_CONFIG_TEMPLATE);
		expect(await readFile(envPath, "utf8")).toBe(DEFAULT_ENV_EXAMPLE);
		expect(messages).toEqual([`wrote ${configPath}`, `wrote ${envPath}`]);
	});

	it("leaves existing files untouched and logs that instead", async () => {
		const configPath = join(dir, "opentaxes.config.json");
		const envPath = join(dir, ".env.example");
		await ensureInit(configPath, envPath, () => {});
		const messages: string[] = [];
		await ensureInit(configPath, envPath, (message) => messages.push(message));
		expect(messages).toEqual([
			`${configPath} already exists, leaving it as is`,
			`${envPath} already exists, leaving it as is`,
		]);
	});
});
