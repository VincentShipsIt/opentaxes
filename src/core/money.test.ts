import { describe, expect, test } from "bun:test";
import {
	currency,
	formatDecimal,
	formatMoney,
	money,
	moneyFromDecimal,
	sameMoney,
} from "./money.ts";

const USD = currency("usd");
const JPY = currency("JPY");

describe("money", () => {
	test("currency normalizes case and rejects junk", () => {
		expect<string>(USD).toBe("USD");
		expect(() => currency("US")).toThrow();
		expect(() => currency("dollars")).toThrow();
	});

	test("money requires non-negative integer minor units", () => {
		expect(money(0, USD)).toEqual({ minor: 0, currency: USD });
		expect(() => money(1.5, USD)).toThrow();
		expect(() => money(-1, USD)).toThrow();
	});

	test("moneyFromDecimal reads dot, comma and grouped formats", () => {
		expect(moneyFromDecimal("20.00", USD).minor).toBe(2000);
		expect(moneyFromDecimal("1,234.56", USD).minor).toBe(123456);
		expect(moneyFromDecimal("1 234,56", USD).minor).toBe(123456);
		expect(moneyFromDecimal("1.234,56", USD).minor).toBe(123456);
		expect(moneyFromDecimal("-12.5", USD).minor).toBe(1250);
		expect(moneyFromDecimal(19.99, USD).minor).toBe(1999);
		expect(moneyFromDecimal("$ 7.30", USD).minor).toBe(730);
	});

	test("zero-decimal currencies keep whole units", () => {
		expect(moneyFromDecimal("1500", JPY).minor).toBe(1500);
		expect(formatDecimal(money(1500, JPY))).toBe("1500");
	});

	test("format round-trips", () => {
		const value = moneyFromDecimal("20.5", USD);
		expect(formatDecimal(value)).toBe("20.50");
		expect(formatMoney(value)).toBe("20.50 USD");
	});

	test("sameMoney compares currency and amount", () => {
		expect(sameMoney(money(100, USD), money(100, USD))).toBe(true);
		expect(sameMoney(money(100, USD), money(100, currency("EUR")))).toBe(false);
		expect(sameMoney(money(100, USD), money(101, USD))).toBe(false);
	});
});
