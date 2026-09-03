import { access, readFile, writeFile } from "node:fs/promises";
import { type Config, parseConfig } from "../core/config.ts";

/**
 * Strips `//` and `/* *\/` comments that fall outside string literals, so the config file can
 * carry human-readable defaults even though `JSON.parse` cannot.
 */
export function stripJsonComments(text: string): string {
	let result = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				result += ch;
			}
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			result += ch;
			if (ch === "\\") {
				result += next;
				i++;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			result += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		result += ch;
	}
	return result;
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function loadConfigFile(path: string): Promise<Config> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`no config at ${path}; run "opentaxes init" first`);
		}
		throw error;
	}
	return parseConfig(JSON.parse(stripJsonComments(raw)));
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

export const DEFAULT_CONFIG_TEMPLATE = `{
	// Transaction sources. Both "wise" (the live API) and "wiseCsv" (manually exported
	// statement CSVs) can run at once — set WISE_API_TOKEN in .env for the former.
	// "sources": {
	// 	"wise": { "currencies": ["USD", "EUR"] },
	// 	"wiseCsv": { "dir": "./wise-exports" },
	// 	"gmail": { "senders": ["billing@example.com"] },
	// 	"folder": { "dir": "./receipts" }
	// },
	"sources": {},

	// Publish targets. "folder" copies files onto local disk; "drive" and "sheets" need
	// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in .env and "opentaxes auth google" once.
	// "sinks": {
	// 	"folder": { "path": "./output" },
	// 	"drive": { "folderId": "your-google-drive-folder-id" },
	// 	"sheets": { "spreadsheetId": "your-spreadsheet-id" }
	// },
	"sinks": {},

	"matching": {
		"dateWindowDays": 5,
		"threshold": 0.6
	},

	// Document extractor. Defaults to the Anthropic API when ANTHROPIC_API_KEY is set in .env,
	// otherwise falls back to the local Claude Code CLI (no API key needed, just "claude" on PATH).
	// "extractor": { "kind": "claude-api" },
	// "extractor": { "kind": "claude-cli", "model": "claude-opus-5" },

	// vendor slug -> accounting category, applied when the extractor leaves it null
	"categories": {}
}
`;

export const DEFAULT_ENV_EXAMPLE = `# Wise business API token (Wise dashboard -> Settings -> API tokens)
WISE_API_TOKEN=
# Only needed for a non-default Wise API host
WISE_API_URL=
# Only needed if your Wise profile requires a signed SCA private key
WISE_PRIVATE_KEY_PATH=

# Google OAuth client, for Gmail/Drive/Sheets (console.cloud.google.com credentials)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Stripe secret key, for pulling invoices and payouts
STRIPE_SECRET_KEY=

# Anthropic API key, for the built-in document extractor
ANTHROPIC_API_KEY=

# Where opentaxes keeps its ledgers, documents, and Google token. Defaults to .opentaxes
OPENTAXES_STATE_DIR=
`;

/** Writes opentaxes.config.json and .env.example if they don't already exist. Idempotent. */
export async function ensureInit(
	configPath: string,
	envExamplePath: string,
	log: (message: string) => void
): Promise<void> {
	if (await fileExists(configPath)) {
		log(`${configPath} already exists, leaving it as is`);
	} else {
		await writeFile(configPath, DEFAULT_CONFIG_TEMPLATE, "utf8");
		log(`wrote ${configPath}`);
	}
	if (await fileExists(envExamplePath)) {
		log(`${envExamplePath} already exists, leaving it as is`);
	} else {
		await writeFile(envExamplePath, DEFAULT_ENV_EXAMPLE, "utf8");
		log(`wrote ${envExamplePath}`);
	}
}
