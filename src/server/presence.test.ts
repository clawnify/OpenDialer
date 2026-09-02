import { describe, expect, it } from "vitest";
import { pickFromNumber } from "./presence.js";

const owned = [
  { e164: "+12125550100", country: "US", area_code: "212", active: 1 },
  { e164: "+14155550100", country: "US", area_code: "415", active: 1 },
  { e164: "+442075550100", country: "GB", area_code: "", active: 1 },
  { e164: "+493055501000", country: "DE", area_code: "", active: 0 },
];

describe("pickFromNumber", () => {
  it("honours an explicit, owned pick", () => {
    expect(pickFromNumber({ requested: "+442075550100", leadCountry: "US", leadAreaCode: "415", owned, fallback: "+10000000000" }))
      .toEqual({ from: "+442075550100", reason: "requested" });
  });
  it("ignores a requested number the account does not own", () => {
    expect(pickFromNumber({ requested: "+19995550100", leadCountry: "GB", leadAreaCode: "", owned, fallback: "+10000000000" }).from)
      .toBe("+442075550100");
  });
  it("prefers a matching US area code", () => {
    expect(pickFromNumber({ leadCountry: "US", leadAreaCode: "415", owned, fallback: "+10000000000" }))
      .toEqual({ from: "+14155550100", reason: "area-code" });
  });
  it("falls to any same-country number before the default", () => {
    expect(pickFromNumber({ leadCountry: "US", leadAreaCode: "650", owned, fallback: "+442075550100" }))
      .toEqual({ from: "+12125550100", reason: "same-country" });
  });
  it("falls back to the first synced number when no default is pinned", () => {
    expect(pickFromNumber({ leadCountry: "DE", leadAreaCode: "", owned, fallback: "" })).toEqual({ from: "+12125550100", reason: "default" });
    expect(pickFromNumber({ leadCountry: "DE", leadAreaCode: "", owned: [], fallback: "" }).from).toBe("");
  });
  it("never uses an inactive number, and uses the default when nothing local exists", () => {
    expect(pickFromNumber({ leadCountry: "DE", leadAreaCode: "", owned, fallback: "+10000000000" }))
      .toEqual({ from: "+10000000000", reason: "default" });
  });
});
