import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone.js";

describe("normalizePhone", () => {
  it("accepts E.164 input regardless of country hint", () => {
    expect(normalizePhone("+442071234567")).toEqual({ ok: true, e164: "+442071234567", country: "GB", areaCode: "" });
    expect(normalizePhone("+1 415 555 2671", "GB")).toMatchObject({ ok: true, e164: "+14155552671", country: "US", areaCode: "415" });
  });

  it("resolves national format with a country", () => {
    expect(normalizePhone("020 7123 4567", "gb")).toMatchObject({ ok: true, e164: "+442071234567" });
    expect(normalizePhone("(415) 555-2671", "US")).toMatchObject({ ok: true, e164: "+14155552671", areaCode: "415" });
    expect(normalizePhone("030 901820", "DE")).toMatchObject({ ok: true, e164: "+4930901820", country: "DE" });
  });

  it("accepts 555 test numbers, which are possible but unassigned", () => {
    expect(normalizePhone("+15551234567")).toMatchObject({ ok: true, e164: "+15551234567", country: "US", areaCode: "555" });
  });

  it("accepts 00 international prefix", () => {
    expect(normalizePhone("0044 20 7123 4567")).toMatchObject({ ok: true, e164: "+442071234567" });
  });

  it("rejects a number with no + and no country", () => {
    expect(normalizePhone("555-1234")).toMatchObject({ ok: false });
    expect(normalizePhone("4155552671")).toMatchObject({ ok: false, error: expect.stringContaining("country code") });
  });

  it("rejects invalid numbers even with a country", () => {
    expect(normalizePhone("555-1234", "US")).toMatchObject({ ok: false });
    expect(normalizePhone("+1555", "US")).toMatchObject({ ok: false });
  });

  it("rejects unsupported regions", () => {
    expect(normalizePhone("+61 2 9374 4000")).toMatchObject({ ok: false, error: expect.stringContaining("AU") });
  });
});
