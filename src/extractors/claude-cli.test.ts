import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseIsoDate } from "../core/dates.ts";
import { currency } from "../core/money.ts";
import type { Document, DocumentId } from "../core/types.ts";
import { type ClaudeCliRun, createClaudeCliExtractor } from "./claude-cli.ts";

function documentFixture(id: string, mime: string, filename: string): Document {
	return {
		id: id as DocumentId,
		origin: { kind: "file", path: `/fixtures/${filename}` },
		filename,
		mime,
		fetchedAt: parseIsoDate("2026-01-15"),
	};
}

function pdfDocument(): Document {
	return documentFixture("doc_1", "application/pdf", "invoice.pdf");
}

function validStructuredOutput() {
	return {
		kind: "invoice",
		side: "expense",
		party: "Acme Vendor",
		issuedAt: "2026-01-15",
		total: { amount: "123.45", currency: "USD" },
		tax: { amount: "23.45", currency: "USD" },
		number: "INV-1",
		category: "software",
		confidence: 0.9,
	};
}

function cliOutput(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		is_error: false,
		result: JSON.stringify(validStructuredOutput()),
		structured_output: validStructuredOutput(),
		...overrides,
	});
}

interface RecordedCall {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
}

/** Fake CLI runner returning one canned stdout per call, in order. */
function queuedRun(outputs: readonly string[]): { calls: RecordedCall[]; run: ClaudeCliRun } {
	const calls: RecordedCall[] = [];
	let index = 0;
	return {
		calls,
		run: async (argv, env, timeoutMs) => {
			calls.push({ argv, env, timeoutMs });
			const stdout = outputs[index];
			index += 1;
			if (stdout === undefined) throw new Error("queuedRun ran out of canned outputs");
			return { stdout, stderr: "", code: 0 };
		},
	};
}

/** Recovers the temp file path from the `-p` prompt argv entry the extractor built. */
function tempPathFromArgv(argv: readonly string[]): string {
	const flagIndex = argv.indexOf("-p");
	const prompt = argv[flagIndex + 1];
	const match = prompt ? /Read the file at (\S+)\./.exec(prompt) : null;
	if (!match?.[1]) throw new Error("prompt did not contain a file path");
	return match[1];
}

describe("createClaudeCliExtractor", () => {
	test("builds argv with the expected flags and a temp path matching the document extension", async () => {
		const { calls, run } = queuedRun([cliOutput()]);
		const extractor = createClaudeCliExtractor({ run });

		await extractor.extract(pdfDocument(), new Uint8Array([1, 2, 3]));

		expect(calls).toHaveLength(1);
		const argv = calls[0]?.argv ?? [];
		expect(argv).toContain("-p");
		expect(argv).toContain("--output-format");
		expect(argv).toContain("json");
		expect(argv).toContain("--json-schema");
		expect(argv).toContain("--tools");
		expect(argv).toContain("Read");
		expect(argv).toContain("--allowedTools");
		expect(argv).toContain("--model");
		expect(argv).toContain("claude-opus-5");
		expect(tempPathFromArgv(argv).endsWith(".pdf")).toBe(true);
	});

	test("passes a custom command and model through to argv", async () => {
		const { calls, run } = queuedRun([cliOutput()]);
		const extractor = createClaudeCliExtractor({
			run,
			command: ["bunx", "claude"],
			model: "sonnet",
		});

		await extractor.extract(pdfDocument(), new Uint8Array([1]));

		const argv = calls[0]?.argv ?? [];
		expect(argv.slice(0, 2)).toEqual(["bunx", "claude"]);
		expect(argv).toContain("sonnet");
	});

	test("sets CLAUDE_CONFIG_DIR only when configDir is given", async () => {
		const { calls, run } = queuedRun([cliOutput(), cliOutput()]);
		const withConfig = createClaudeCliExtractor({ run, configDir: "/fake/config" });
		await withConfig.extract(pdfDocument(), new Uint8Array([1]));
		expect(calls[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: "/fake/config" });

		const withoutConfig = createClaudeCliExtractor({ run });
		await withoutConfig.extract(pdfDocument(), new Uint8Array([1]));
		expect(calls[1]?.env).toEqual({});
	});

	test("maps a successful run to an Extraction", async () => {
		const { run } = queuedRun([cliOutput()]);
		const extractor = createClaudeCliExtractor({ run });

		const extraction = await extractor.extract(pdfDocument(), new Uint8Array([1]));

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

	test("throws with the result message when is_error is true", async () => {
		const { run } = queuedRun([
			JSON.stringify({ is_error: true, result: "claude CLI failed: no credentials found" }),
		]);
		const extractor = createClaudeCliExtractor({ run });

		await expect(extractor.extract(pdfDocument(), new Uint8Array([1]))).rejects.toThrow(
			/no credentials found/
		);
	});

	test("retries once on a null structured_output and succeeds on the second attempt", async () => {
		const { calls, run } = queuedRun([
			JSON.stringify({ is_error: false, result: "", structured_output: null }),
			cliOutput(),
		]);
		const extractor = createClaudeCliExtractor({ run });

		const extraction = await extractor.extract(pdfDocument(), new Uint8Array([1]));

		expect(extraction.party).toBe("Acme Vendor");
		expect(calls).toHaveLength(2);
	});

	test("throws after two failed attempts", async () => {
		const { calls, run } = queuedRun([
			JSON.stringify({ is_error: false, result: "", structured_output: null }),
			JSON.stringify({ is_error: false, result: "", structured_output: null }),
		]);
		const extractor = createClaudeCliExtractor({ run });

		await expect(extractor.extract(pdfDocument(), new Uint8Array([1]))).rejects.toThrow(
			/failed validation twice/
		);
		expect(calls).toHaveLength(2);
	});

	test("removes the temp file after a successful extraction", async () => {
		const { calls, run } = queuedRun([cliOutput()]);
		const extractor = createClaudeCliExtractor({ run });

		await extractor.extract(pdfDocument(), new Uint8Array([1]));

		expect(existsSync(tempPathFromArgv(calls[0]?.argv ?? []))).toBe(false);
	});

	test("removes the temp file after a failed extraction", async () => {
		const { calls, run } = queuedRun([JSON.stringify({ is_error: true, result: "boom" })]);
		const extractor = createClaudeCliExtractor({ run });

		await expect(extractor.extract(pdfDocument(), new Uint8Array([1]))).rejects.toThrow();

		expect(existsSync(tempPathFromArgv(calls[0]?.argv ?? []))).toBe(false);
	});
});
