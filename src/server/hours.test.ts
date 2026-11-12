import { describe, expect, it } from "vitest";
import { isOpen, parseHours } from "./hours";

const weekdays = { tz: "Europe/Amsterdam", days: { mon: [["09:00", "17:30"]], tue: [["09:00", "17:30"]], wed: [["09:00", "17:30"]], thu: [["09:00", "17:30"]], fri: [["09:00", "12:00"], ["13:00", "17:00"]] } };

describe("business hours", () => {
  const h = parseHours(weekdays);
  if (!h.ok) throw new Error(h.error);

  it("is open inside a range, in the number's own time zone", () => {
    // Monday 2026-11-09 08:30 UTC = 09:30 in Amsterdam (CET, UTC+1)
    expect(isOpen(h.hours, new Date("2026-11-09T08:30:00Z"))).toBe(true);
  });
  it("is closed before opening, even when UTC says otherwise", () => {
    // 07:30 UTC = 08:30 Amsterdam
    expect(isOpen(h.hours, new Date("2026-11-09T07:30:00Z"))).toBe(false);
  });
  it("closes exactly at closing time", () => {
    expect(isOpen(h.hours, new Date("2026-11-09T16:30:00Z"))).toBe(false);
  });
  it("honours a lunch break", () => {
    expect(isOpen(h.hours, new Date("2026-11-13T11:30:00Z"))).toBe(false); // Fri 12:30 local
    expect(isOpen(h.hours, new Date("2026-11-13T12:30:00Z"))).toBe(true); // Fri 13:30 local
  });
  it("treats a missing day as closed", () => {
    expect(isOpen(h.hours, new Date("2026-11-14T10:00:00Z"))).toBe(false); // Saturday
  });
  it("treats no hours as always open", () => {
    expect(isOpen(null, new Date("2026-11-14T03:00:00Z"))).toBe(true);
  });
  it("rejects bad input with a readable error", () => {
    expect(parseHours({ tz: "Mars/Olympus", days: {} })).toEqual({ ok: false, error: "Unknown time zone: Mars/Olympus" });
    expect(parseHours({ tz: "UTC", days: { mon: [["17:00", "09:00"]] } }).ok).toBe(false);
    expect(parseHours({ tz: "UTC", days: { mon: [["9:00", "17:00"]] } }).ok).toBe(false);
  });
});
