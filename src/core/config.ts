import { z } from "zod";

export const ConfigSchema = z.object({
	sources: z
		.object({
			wise: z
				.object({
					/** Wise business profile id. Resolved from the token when omitted. */
					profileId: z.string().optional(),
					/** Balance currencies to pull. All balances when omitted. */
					currencies: z.array(z.string().length(3)).optional(),
				})
				.optional(),
			gmail: z
				.object({
					/** Extra Gmail search terms appended to the default receipt query. */
					query: z.string().optional(),
					/** Sender addresses or domains known to send invoices. */
					senders: z.array(z.string()).default([]),
				})
				.optional(),
			stripe: z.object({}).optional(),
			wiseCsv: z.object({ dir: z.string() }).optional(),
		})
		.prefault({}),
	sinks: z
		.object({
			folder: z.object({ path: z.string() }).optional(),
			drive: z.object({ folderId: z.string() }).optional(),
			sheets: z
				.object({
					spreadsheetId: z.string(),
					/** Defaults to the month ("2026-01") so each month lands on its own tab. */
					sheetName: z.string().optional(),
				})
				.optional(),
		})
		.prefault({}),
	matching: z
		.object({
			dateWindowDays: z.number().int().min(0).default(5),
			threshold: z.number().min(0).max(1).default(0.6),
		})
		.prefault({}),
	/** party slug -> accounting category, applied when the extractor leaves category null */
	categories: z.record(z.string(), z.string()).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILENAME = "opentaxes.config.json";

export function parseConfig(raw: unknown): Config {
	return ConfigSchema.parse(raw);
}
