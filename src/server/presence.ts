// Local presence: which owned number to show the lead.
//
// Order is strict and deliberate. A same-country number always beats the
// default, so a rep never shows a foreign caller ID to a lead in a market
// where they own a local number.

import type { NumberRow } from "./types.js";

export function pickFromNumber(opts: {
  requested?: string | null;
  leadCountry: string;
  leadAreaCode: string;
  owned: Pick<NumberRow, "e164" | "country" | "area_code" | "active">[];
  fallback: string;
}): { from: string; reason: "requested" | "area-code" | "same-country" | "default" } {
  const active = opts.owned.filter((n) => n.active);
  if (opts.requested) {
    const match = active.find((n) => n.e164 === opts.requested);
    if (match) return { from: match.e164, reason: "requested" };
  }
  if ((opts.leadCountry === "US" || opts.leadCountry === "CA") && opts.leadAreaCode) {
    const area = active.find((n) => n.country === opts.leadCountry && n.area_code === opts.leadAreaCode);
    if (area) return { from: area.e164, reason: "area-code" };
  }
  const same = active.find((n) => n.country === opts.leadCountry);
  if (same) return { from: same.e164, reason: "same-country" };
  return { from: opts.fallback, reason: "default" };
}
