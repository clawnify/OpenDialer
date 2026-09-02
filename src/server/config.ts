// What the environment enables. Read once per request; never returns a secret.

import type { Bindings } from "./types.js";

/**
 * Twilio home regions this app knows how to address. A region is a full
 * credential set: the Auth Token, API key and TwiML App all have to be created
 * in it, and REST + the browser SDK must talk to it. One deployment = one region.
 */
export const TWILIO_REGIONS = {
  us1: { restHost: "api.twilio.com", edge: null as string | null },
  ie1: { restHost: "api.dublin.ie1.twilio.com", edge: "dublin" },
} as const;
export type TwilioRegion = keyof typeof TWILIO_REGIONS;

export function twilioRegion(env: Bindings): TwilioRegion {
  const r = (env.TWILIO_REGION || "us1").trim().toLowerCase();
  return r in TWILIO_REGIONS ? (r as TwilioRegion) : "us1";
}

export interface ProviderConfig {
  provider: "twilio";
  region: TwilioRegion;
  /** Voice SDK edge for this region; null lets the SDK pick. */
  edge: string | null;
  /** REST calls, number sync and webhooks work. */
  rest: boolean;
  /** Browser calling through the Voice SDK works (TwiML App + API key present). */
  voiceSdk: boolean;
  fromNumber: string;
  missing: string[];
}

export function providerConfig(env: Bindings): ProviderConfig {
  const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
  const missing: string[] = [];
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const) if (!has(env[k])) missing.push(k);
  const rest = has(env.TWILIO_ACCOUNT_SID) && has(env.TWILIO_AUTH_TOKEN);
  const voiceSdk = rest && has(env.TWILIO_TWIML_APP_SID) && has(env.TWILIO_API_KEY_SID) && has(env.TWILIO_API_KEY_SECRET);
  const region = twilioRegion(env);
  return { provider: "twilio", region, edge: TWILIO_REGIONS[region].edge, rest, voiceSdk, fromNumber: (env.TWILIO_FROM_NUMBER || "").trim(), missing };
}

/** Origin Twilio should call back. PUBLIC_APP_URL wins; otherwise the request's own origin. */
export function publicOrigin(env: Bindings, requestUrl: string): string {
  const configured = (env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return new URL(requestUrl).origin;
}
