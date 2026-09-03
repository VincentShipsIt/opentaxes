import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type Auth, google } from "googleapis";

export const GOOGLE_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/drive.file",
	"https://www.googleapis.com/auth/spreadsheets",
] as const;

const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;

export interface GoogleAuthOptions {
	readonly clientId: string;
	readonly clientSecret: string;
	/** Path to the JSON file the interactive flow writes tokens to and loadClient reads them from. */
	readonly tokenPath: string;
	readonly log?: (message: string) => void;
}

export interface GoogleAuth {
	/** Runs the OAuth desktop loopback flow and writes the resulting tokens to tokenPath. */
	authorizeInteractive(): Promise<void>;
	/** Loads a client from a prior authorizeInteractive run; persists refreshed tokens back to tokenPath. */
	loadClient(): Promise<Auth.OAuth2Client>;
}

export function createGoogleAuth(options: GoogleAuthOptions): GoogleAuth {
	const log = options.log ?? defaultLog;

	async function authorizeInteractive(): Promise<void> {
		const server = createServer();
		await listen(server);
		const address = server.address();
		if (address === null || typeof address === "string") {
			server.close();
			throw new Error("failed to bind the OAuth loopback server on 127.0.0.1");
		}
		const redirectUri = `http://127.0.0.1:${address.port}`;
		const client = newClient(redirectUri);
		const authUrl = client.generateAuthUrl({
			access_type: "offline",
			prompt: "consent",
			scope: [...GOOGLE_SCOPES],
		});
		log(`Open this URL in a browser to authorize opentaxes:\n${authUrl}`);

		try {
			const code = await waitForCode(server, redirectUri);
			const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
			await persistTokens(options.tokenPath, tokens);
		} finally {
			server.close();
		}
	}

	async function loadClient(): Promise<Auth.OAuth2Client> {
		const stored = await readTokens(options.tokenPath);
		const client = newClient();
		client.setCredentials(stored);
		let current = stored;
		client.on("tokens", (refreshed) => {
			current = { ...current, ...refreshed };
			persistTokens(options.tokenPath, current).catch((error: unknown) => {
				log(`failed to persist refreshed Google tokens: ${errorMessage(error)}`);
			});
		});
		return client;
	}

	function newClient(redirectUri?: string): Auth.OAuth2Client {
		return new google.auth.OAuth2(
			redirectUri === undefined
				? { clientId: options.clientId, clientSecret: options.clientSecret }
				: { clientId: options.clientId, clientSecret: options.clientSecret, redirectUri }
		);
	}

	return { authorizeInteractive, loadClient };
}

async function readTokens(tokenPath: string): Promise<Auth.Credentials> {
	let raw: string;
	try {
		raw = await readFile(tokenPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`no Google tokens at ${tokenPath}; run "opentaxes auth google" first`);
		}
		throw error;
	}
	return JSON.parse(raw) as Auth.Credentials;
}

async function persistTokens(tokenPath: string, tokens: Auth.Credentials): Promise<void> {
	// The mode passed to writeFile only applies when it creates the file; chmod enforces
	// 0600 on every persist, including a refresh rewriting a file that already existed.
	await writeFile(tokenPath, `${JSON.stringify(tokens, null, "\t")}\n`, { mode: 0o600 });
	await chmod(tokenPath, 0o600);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
}

function waitForCode(
	server: ReturnType<typeof createServer>,
	redirectUri: string
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("timed out waiting for the Google authorization callback after 5 minutes"));
		}, AUTHORIZE_TIMEOUT_MS);

		server.on("request", (req, res) => {
			const url = new URL(req.url ?? "/", redirectUri);
			const error = url.searchParams.get("error");
			if (error !== null) {
				res.writeHead(400, { "content-type": "text/plain" }).end(`Authorization failed: ${error}`);
				clearTimeout(timeout);
				reject(new Error(`Google authorization failed: ${error}`));
				return;
			}
			const code = url.searchParams.get("code");
			if (code === null) {
				res.writeHead(400, { "content-type": "text/plain" }).end("Missing authorization code");
				return;
			}
			res
				.writeHead(200, { "content-type": "text/plain" })
				.end("Authorization complete. You can close this tab.");
			clearTimeout(timeout);
			resolve(code);
		});
	});
}

function isEnoent(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultLog(message: string): void {
	process.stderr.write(`${message}\n`);
}
