import type { IsoDate, Month } from "./types.ts";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function parseMonth(value: string): Month {
	if (!MONTH.test(value)) throw new Error(`invalid month "${value}", expected YYYY-MM`);
	return value as Month;
}

export function parseIsoDate(value: string): IsoDate {
	if (!ISO_DATE.test(value)) throw new Error(`invalid date "${value}", expected YYYY-MM-DD`);
	const time = Date.parse(`${value}T00:00:00Z`);
	if (Number.isNaN(time) || toIsoDate(new Date(time)) !== value) {
		throw new Error(`invalid calendar date "${value}"`);
	}
	return value as IsoDate;
}

/** UTC calendar date of a Date or of any string Date.parse accepts. */
export function toIsoDate(value: Date | string): IsoDate {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`unparseable date "${String(value)}"`);
	return date.toISOString().slice(0, 10) as IsoDate;
}

export function monthOf(date: IsoDate): Month {
	return date.slice(0, 7) as Month;
}

/** First and last calendar day of the month, inclusive. */
export function monthBounds(month: Month): { readonly start: IsoDate; readonly end: IsoDate } {
	const [year, monthNumber] = month.split("-").map(Number) as [number, number];
	const start = new Date(Date.UTC(year, monthNumber - 1, 1));
	const end = new Date(Date.UTC(year, monthNumber, 0));
	return { start: toIsoDate(start), end: toIsoDate(end) };
}

export function previousMonth(now: Date = new Date()): Month {
	const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
	return toIsoDate(first).slice(0, 7) as Month;
}

/** Absolute distance in whole days. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
	const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
	return Math.round(ms / 86_400_000);
}

export function isInMonth(date: IsoDate, month: Month): boolean {
	return monthOf(date) === month;
}
