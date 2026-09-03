import { z } from "zod";

const optional = z
	.string()
	.trim()
	.transform((value) => (value === "" ? undefined : value))
	.optional();

export const EnvSchema = z.object({
	WISE_API_TOKEN: optional,
	WISE_API_URL: optional,
	WISE_PRIVATE_KEY_PATH: optional,
	GOOGLE_CLIENT_ID: optional,
	GOOGLE_CLIENT_SECRET: optional,
	STRIPE_SECRET_KEY: optional,
	ANTHROPIC_API_KEY: optional,
	OPENTAXES_STATE_DIR: optional,
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: Readonly<Record<string, string | undefined>>): Env {
	return EnvSchema.parse(raw);
}
