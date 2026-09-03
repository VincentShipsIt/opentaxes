import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Extractor } from "../core/registry.ts";
import type { Document, Extraction } from "../core/types.ts";
import { DEFAULT_MODEL, MAX_ATTEMPTS } from "./claude.ts";
import { buildExtractionPrompt } from "./prompt.ts";
import { decimalExtractionJsonSchema, extractionFromDecimalInput } from "./schema.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_COMMAND = ["claude"] as const;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface ClaudeCliRunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
}

/** Runs the CLI and returns its output, injectable so tests never spawn a real process. */
export type ClaudeCliRun = (
	argv: readonly string[],
	env: Readonly<Record<string, string>>,
	timeoutMs: number
) => Promise<ClaudeCliRunResult>;

export interface CreateClaudeCliExtractorOptions {
	/** The CLI binary and any leading args, e.g. `["claude"]` or `["bunx", "claude"]`. */
	readonly command?: readonly string[];
	readonly model?: string;
	/** Sets `CLAUDE_CONFIG_DIR` for the child process, to select a logged-in profile. */
	readonly configDir?: string;
	/** The ledger owner's own business name, passed through to the prompt. */
	readonly selfName?: string;
	readonly timeoutMs?: number;
	readonly run?: ClaudeCliRun;
}

/** The one JSON object `claude -p --output-format json` prints on stdout. */
interface ClaudeCliOutput {
	readonly is_error: boolean;
	readonly result: string;
	readonly structured_output: unknown;
}

function isClaudeCliOutput(value: unknown): value is ClaudeCliOutput {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.is_error === "boolean" && typeof candidate.result === "string";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `document.filename`'s extension when it has one; otherwise the mime subtype, so the Read tool
 * still sees a plausible file type (e.g. `application/pdf` -> `pdf`).
 */
function fileExtension(document: Document): string {
	const fromFilename = extname(document.filename).replace(/^\./, "");
	if (fromFilename) return fromFilename;
	return document.mime.split("/")[1] ?? "bin";
}

function tempFilePath(document: Document): string {
	const ext = fileExtension(document);
	return join(tmpdir(), `opentaxes-${randomBytes(8).toString("hex")}.${ext}`);
}

function defaultRun(
	argv: readonly string[],
	env: Readonly<Record<string, string>>,
	timeoutMs: number
): Promise<ClaudeCliRunResult> {
	const [command, ...args] = argv;
	if (!command) throw new Error("claude-cli run invoked with an empty argv");
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES },
			(error, stdout, stderr) => {
				if (error && !("code" in error && typeof error.code === "number")) {
					reject(error);
					return;
				}
				const code = error && "code" in error && typeof error.code === "number" ? error.code : 0;
				resolve({ stdout, stderr, code });
			}
		);
	});
}

function buildArgv(
	command: readonly string[],
	prompt: string,
	model: string,
	jsonSchema: string
): string[] {
	return [
		...command,
		"-p",
		prompt,
		"--output-format",
		"json",
		"--json-schema",
		jsonSchema,
		"--tools",
		"Read",
		"--allowedTools",
		"Read",
		"--model",
		model,
	];
}

export function createClaudeCliExtractor(options: CreateClaudeCliExtractorOptions = {}): Extractor {
	const {
		command = DEFAULT_COMMAND,
		model = DEFAULT_MODEL,
		configDir,
		selfName,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		run = defaultRun,
	} = options;
	const promptBase = buildExtractionPrompt(selfName === undefined ? {} : { selfName });
	const jsonSchema = JSON.stringify(decimalExtractionJsonSchema());
	const env: Readonly<Record<string, string>> =
		configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir };

	return {
		name: "claude-cli",
		async extract(document: Document, bytes: Uint8Array): Promise<Extraction> {
			const tempPath = tempFilePath(document);
			await writeFile(tempPath, bytes);
			try {
				let lastError: unknown;
				for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
					const prompt =
						attempt === 0
							? `${promptBase}\n\nRead the file at ${tempPath}. It is the document to extract.`
							: `${promptBase}\n\nRead the file at ${tempPath}. It is the document to extract.\n\n` +
								`The previous attempt failed: ${errorMessage(lastError)}. Correct the mistake and answer again.`;
					const argv = buildArgv(command, prompt, model, jsonSchema);
					const { stdout } = await run(argv, env, timeoutMs);

					let parsed: unknown;
					try {
						parsed = JSON.parse(stdout);
					} catch (error) {
						lastError = new Error(`claude CLI did not print valid JSON: ${errorMessage(error)}`);
						continue;
					}
					if (!isClaudeCliOutput(parsed)) {
						lastError = new Error("claude CLI output did not match the expected result shape");
						continue;
					}
					if (parsed.is_error) {
						throw new Error(parsed.result);
					}
					if (parsed.structured_output === null || parsed.structured_output === undefined) {
						lastError = new Error("claude CLI returned no structured_output");
						continue;
					}
					try {
						return extractionFromDecimalInput(parsed.structured_output, "claude");
					} catch (error) {
						lastError = error;
					}
				}
				throw new Error(
					`claude CLI extraction failed validation twice: ${errorMessage(lastError)}`
				);
			} finally {
				await rm(tempPath, { force: true });
			}
		},
	};
}
