// Phone normalisation. Everything stored or dialled is E.164; this is the one
// place that decides what is accepted.

import { parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from "libphonenumber-js";

/** Markets this app is built for. Anything else is refused before dialling. */
export const SUPPORTED_COUNTRIES = [
  "US", "CA",
  "GB", "IE",
  "DE", "FR", "ES", "IT", "NL", "BE", "AT", "CH", "SE", "NO", "DK", "FI", "PL", "PT",
] as const;

export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];

export const COUNTRY_NAMES: Record<SupportedCountry, string> = {
  US: "United States", CA: "Canada",
  GB: "United Kingdom", IE: "Ireland",
  DE: "Germany", FR: "France", ES: "Spain", IT: "Italy", NL: "Netherlands", BE: "Belgium",
  AT: "Austria", CH: "Switzerland", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland",
  PL: "Poland", PT: "Portugal",
};

export function isSupportedCountry(c: string): c is SupportedCountry {
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(c);
}

export type Normalized =
  | { ok: true; e164: string; country: SupportedCountry; areaCode: string }
  | { ok: false; error: string };

/**
 * Parse a raw phone string to E.164.
 *
 * `defaultCountry` lets a national-format number ("020 7123 4567") resolve
 * when the row says which country it belongs to. A number with a leading `+`
 * ignores the hint. Without either a `+` or a country, the number is rejected:
 * guessing a country is how a rep dials the wrong continent.
 */
export function normalizePhone(raw: string, defaultCountry?: string): Normalized {
  const input = (raw || "").trim();
  if (!input) return { ok: false, error: "Phone number is empty" };

  const hint = (defaultCountry || "").trim().toUpperCase();
  const hasPlus = input.startsWith("+") || input.startsWith("00");
  if (!hasPlus && !hint) {
    return { ok: false, error: "Phone number needs a + country code or a country" };
  }
  if (!hasPlus && !isSupportedCountry(hint)) {
    return { ok: false, error: `Country "${hint}" is not supported` };
  }

  const parsed = parsePhoneNumberFromString(
    input.startsWith("00") ? `+${input.slice(2)}` : input,
    hasPlus ? undefined : (hint as CountryCode),
  );
  // isPossible (length/shape) rather than isValid (live numbering plan):
  // test ranges such as +1 555 xxx xxxx and freshly opened area codes must
  // still dial. The + and country code are the hard requirement.
  if (!parsed || !parsed.isPossible()) {
    return { ok: false, error: `"${input}" is not a valid phone number` };
  }
  const country = resolveCountry(parsed);
  if (!isSupportedCountry(country)) {
    return { ok: false, error: `Numbers in ${country || "that region"} are not supported` };
  }
  return { ok: true, e164: parsed.number, country, areaCode: areaCodeOf(parsed.nationalNumber, country) };
}

/**
 * The country of a parsed number. libphonenumber leaves `country` undefined
 * when the number is possible but not assigned (a 555 test number), so fall
 * back to the numbering plan's candidates, preferring one we support.
 */
function resolveCountry(parsed: PhoneNumber): string {
  if (parsed.country) return parsed.country;
  const candidates = parsed.getPossibleCountries();
  return candidates.find((c) => isSupportedCountry(c)) || candidates[0] || (parsed.countryCallingCode === "1" ? "US" : "");
}

/** NANP area code (first three national digits) for US/CA; empty elsewhere. */
export function areaCodeOf(nationalNumber: string, country: string): string {
  return country === "US" || country === "CA" ? nationalNumber.slice(0, 3) : "";
}

/** Human display, e.g. "+1 415 555 0132" — never used for dialling. */
export function formatInternational(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}
