import { describe, expect, it } from "vitest";
import { calendarDateSchema, isCalendarDate } from "../src/lib/date.js";
import { normalizeTrade } from "../src/modules/trades/schema.js";

describe("calendar date validation", () => {
  it("accepts real dates, including leap day", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(calendarDateSchema.parse("2026-08-09")).toBe("2026-08-09");
  });

  it("rejects impossible trade and expiry dates before PostgreSQL coercion", () => {
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(() => normalizeTrade({
      symbol: "AAPL",
      direction: "Long",
      entry: 100,
      size: 1,
      date: "2026-02-30",
      expiry: "2026-04-31",
    })).toThrow();
  });
});
