// What the environment enables. Read once per request; never returns a secret.

import type { Bindings } from "./types.js";

export interface ProviderConfig {
  provider: "twilio";
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
  return { provider: "twilio", rest, voiceSdk, fromNumber: (env.TWILIO_FROM_NUMBER || "").trim(), missing };
}

/** Origin Twilio should call back. PUBLIC_APP_URL wins; otherwise the request's own origin. */
export function publicOrigin(env: Bindings, requestUrl: string): string {
  const configured = (env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return new URL(requestUrl).origin;
}
