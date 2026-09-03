import type { Currency, Money } from "./types.ts";

const ZERO_DECIMAL = new Set([
	"JPY",
	"KRW",
	"VND",
	"CLP",
	"ISK",
	"HUF",
	"TWD",
	"UGX",
	"XAF",
	"XOF",
]);
const CODE = /^[A-Z]{3}$/;

export function currency(code: string): Currency {
	const upper = code.trim().toUpperCase();
	if (!CODE.test(upper)) throw new Error(`invalid currency "${code}"`);
	return upper as Currency;
}

export function decimalsOf(code: Currency): number {
	return ZERO_DECIMAL.has(code) ? 0 : 2;
}

export function money(minor: number, code: Currency): Money {
	if (!Number.isInteger(minor) || minor < 0) {
		throw new Error(`money minor units must be a non-negative integer, got ${minor}`);
	}
	return { minor, currency: code };
}

/**
 * Parses a decimal amount as banks and invoices print it: "20.00", "1,234.56", "1 234,56", "-12.5".
 * The sign is dropped; direction is the owner's job.
 */
export function moneyFromDecimal(value: string | number, code: Currency): Money {
	const text = typeof value === "number" ? value.toString() : value.trim();
	const normalized = normalizeDecimal(text);
	const parsed = Number(normalized);
	if (!Number.isFinite(parsed)) throw new Error(`invalid amount "${value}"`);
	const factor = 10 ** decimalsOf(code);
	return money(Math.round(Math.abs(parsed) * factor), code);
}

function normalizeDecimal(text: string): string {
	const cleaned = text.replace(/[^\d.,-]/g, "");
	const lastComma = cleaned.lastIndexOf(",");
	const lastDot = cleaned.lastIndexOf(".");
	if (lastComma > lastDot) return cleaned.replace(/\./g, "").replace(",", ".");
	return cleaned.replace(/,/g, "");
}

export function formatDecimal(value: Money): string {
	const decimals = decimalsOf(value.currency);
	return (value.minor / 10 ** decimals).toFixed(decimals);
}

/** "20.00 USD" */
export function formatMoney(value: Money): string {
	return `${formatDecimal(value)} ${value.currency}`;
}

export function sameMoney(a: Money, b: Money): boolean {
	return a.currency === b.currency && a.minor === b.minor;
}
