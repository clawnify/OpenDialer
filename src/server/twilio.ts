// Twilio, spoken directly over HTTPS. No helper library: the official SDK
// leans on Node internals that misbehave on Workers, and the four calls this
// app makes are small. Everything here runs server-side; the browser only
// ever sees a short-lived Voice access token.

import { TWILIO_REGIONS, twilioRegion } from "./config.js";
import type { Bindings } from "./types.js";

export class TwilioError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = "TwilioError";
  }
}

/** REST root for the configured region, e.g. https://api.dublin.ie1.twilio.com/2010-04-01. */
function apiRoot(env: Bindings): string {
  return `https://${TWILIO_REGIONS[twilioRegion(env)].restHost}/2010-04-01`;
}

function basicAuth(env: Bindings): string {
  // API key + secret is preferred (rotatable); auth token works too.
  const user = env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET ? env.TWILIO_API_KEY_SID : env.TWILIO_ACCOUNT_SID!;
  const pass = env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET ? env.TWILIO_API_KEY_SECRET : env.TWILIO_AUTH_TOKEN!;
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

/** Twilio error bodies are { code, message, more_info }; turn them into one readable line. */
async function twilioFetch<T>(env: Bindings, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiRoot(env)}/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`, {
    ...init,
    headers: { Authorization: basicAuth(env), ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const code = typeof body.code === "number" ? body.code : undefined;
    const msg = typeof body.message === "string" ? body.message : text.slice(0, 200) || res.statusText;
    throw new TwilioError(friendlyTwilioMessage(res.status, code, msg), res.status, code);
  }
  return body as T;
}

function friendlyTwilioMessage(status: number, code: number | undefined, msg: string): string {
  if (status === 401) return "Twilio rejected the credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, and that they were created in the configured TWILIO_REGION.";
  if (code === 21211 || code === 21217) return "Twilio rejected this number as invalid.";
  if (code === 21219 || code === 32100) return "Trial account: Twilio blocks bridged calls until the account is upgraded.";
  if (code === 21215 || code === 21216) return "Calling this destination is disabled on your Twilio account (geographic permissions).";
  if (code === 21212 || code === 21210) return "The caller ID is not a number this Twilio account owns.";
  return `Twilio: ${msg}`;
}

const form = (fields: Record<string, string | string[] | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else p.append(k, v);
  }
  return p;
};

export interface IncomingNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities: { voice?: boolean };
  voice_url?: string | null;
  voice_application_sid?: string | null;
  status_callback?: string | null;
}

/** Every voice-capable number the account owns, following pagination. */
export async function listIncomingNumbers(env: Bindings): Promise<IncomingNumber[]> {
  const out: IncomingNumber[] = [];
  let path: string | null = `/IncomingPhoneNumbers.json?PageSize=100`;
  while (path) {
    const page: { incoming_phone_numbers: IncomingNumber[]; next_page_uri: string | null } = await twilioFetch(env, path);
    out.push(...page.incoming_phone_numbers);
    // next_page_uri is absolute from the API root (/2010-04-01/Accounts/...); strip to our base.
    path = page.next_page_uri ? page.next_page_uri.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "") : null;
  }
  return out.filter((n) => n.capabilities?.voice !== false);
}

export interface CreateCallInput {
  to: string;
  from: string;
  /** Inline TwiML, or `url` that Twilio fetches when the call is answered. One of the two. */
  twiml?: string;
  url?: string;
  statusCallback: string;
  timeoutSeconds?: number;
}

/**
 * REST-originated call: the fallback mode's call to the rep's phone, and every
 * rep leg of an inbound call (`to: "client:<identity>"`). Returns the call SID.
 */
export async function createCall(env: Bindings, input: CreateCallInput): Promise<{ sid: string; status: string }> {
  return twilioFetch<{ sid: string; status: string }>(env, "/Calls.json", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      To: input.to,
      From: input.from,
      Twiml: input.twiml,
      Url: input.url,
      StatusCallback: input.statusCallback,
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: String(input.timeoutSeconds ?? 30),
    }),
  });
}

/** Hang up a call. `canceled` stops one that is still queued or ringing; `completed` ends one in progress. */
export async function endCall(env: Bindings, callSid: string, status: "completed" | "canceled" = "completed"): Promise<void> {
  await twilioFetch(env, `/Calls/${encodeURIComponent(callSid)}.json`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ Status: status }),
  });
}

/** Send a live call to new TwiML (the caller's leg to voicemail, for instance). */
export async function redirectCall(env: Bindings, callSid: string, url: string): Promise<void> {
  await twilioFetch(env, `/Calls/${encodeURIComponent(callSid)}.json`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ Url: url, Method: "POST" }),
  });
}

export async function getIncomingNumber(env: Bindings, numberSid: string): Promise<IncomingNumber> {
  return twilioFetch<IncomingNumber>(env, `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`);
}

/**
 * Set where a number's incoming calls go. A TwiML App on the number wins over
 * VoiceUrl, so connecting passes an empty one; disconnecting puts back
 * whatever was there. Returns the number as Twilio now has it.
 */
export async function setNumberVoiceUrl(
  env: Bindings,
  numberSid: string,
  o: { voiceUrl: string; voiceApplicationSid: string; statusCallback: string },
): Promise<IncomingNumber> {
  return twilioFetch<IncomingNumber>(env, `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ VoiceUrl: o.voiceUrl, VoiceMethod: "POST", VoiceApplicationSid: o.voiceApplicationSid, StatusCallback: o.statusCallback, StatusCallbackMethod: "POST" }),
  });
}

/** Stream a recording through our auth; the browser never holds Twilio credentials. */
export async function fetchRecording(env: Bindings, recordingUrl: string, range?: string): Promise<Response> {
  const url = recordingUrl.endsWith(".mp3") || recordingUrl.endsWith(".wav") ? recordingUrl : `${recordingUrl}.mp3`;
  return fetch(url, { headers: { Authorization: basicAuth(env), ...(range ? { Range: range } : {}) } });
}

// ── Voice access token ──────────────────────────────────────────────
//
// The Voice JS SDK authenticates with a JWT signed by an API key secret.
// Format per Twilio's access-token spec: HS256, header cty "twilio-fpa;v=1",
// payload { jti, iss: API key SID, sub: Account SID, iat, exp, grants }.

const b64url = (input: ArrayBuffer | string) => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const VOICE_TOKEN_TTL_SECONDS = 3600;

export async function voiceAccessToken(env: Bindings, identity: string): Promise<string> {
  const keySid = env.TWILIO_API_KEY_SID!;
  const now = Math.floor(Date.now() / 1000);
  // Regional tokens carry the home region in the header (`twr`); the API key
  // and TwiML App named inside must exist in that same region.
  const region = twilioRegion(env);
  const header: Record<string, string> = { alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1", ...(region === "us1" ? {} : { twr: region }) };
  const payload = {
    jti: `${keySid}-${now}`,
    iss: keySid,
    sub: env.TWILIO_ACCOUNT_SID,
    iat: now,
    exp: now + VOICE_TOKEN_TTL_SECONDS,
    grants: {
      identity,
      // incoming.allow lets the page register and ring for inbound calls;
      // outgoing needs the TwiML App, which inbound-only setups can skip.
      voice: { incoming: { allow: true }, ...(env.TWILIO_TWIML_APP_SID ? { outgoing: { application_sid: env.TWILIO_TWIML_APP_SID } } : {}) },
    },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TWILIO_API_KEY_SECRET!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

// ── Webhook signature ───────────────────────────────────────────────
//
// X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + concat(sorted(key+value))))
// over the exact URL Twilio requested (query string included) and the POST
// form fields sorted by key.

export async function expectedSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function verifySignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  const expected = await expectedSignature(authToken, url, params);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// ── TwiML ───────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface DialOptions {
  to: string;
  callerId: string;
  actionUrl: string;
  numberStatusUrl: string;
  recordingUrl: string;
  record: boolean;
  timeoutSeconds?: number;
}

/**
 * Bridge the current leg to a PSTN number. Used verbatim for browser calls
 * (the browser leg is the parent) and after a greeting in fallback mode (the
 * rep's phone is the parent).
 */
export function dialTwiml(o: DialOptions, prefix = ""): string {
  const record = o.record ? ` record="record-from-answer-dual" recordingStatusCallback="${esc(o.recordingUrl)}" recordingStatusCallbackEvent="completed"` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>${prefix}` +
    `<Dial callerId="${esc(o.callerId)}" timeout="${o.timeoutSeconds ?? 30}" action="${esc(o.actionUrl)}" method="POST"${record}>` +
    `<Number statusCallback="${esc(o.numberStatusUrl)}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed">${esc(o.to)}</Number>` +
    `</Dial></Response>`
  );
}

export function sayTwiml(text: string): string {
  return `<Say>${esc(text)}</Say>`;
}

export function rejectTwiml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(text)}</Say><Hangup/></Response>`;
}

const xmlDoc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

export function hangupTwiml(say?: string): string {
  return xmlDoc(`${say ? `<Say>${esc(say)}</Say>` : ""}<Hangup/>`);
}

/** Press-a-digit menu. Silence falls through to `noInputUrl`. */
export function gatherTwiml(o: { prompt: string; actionUrl: string; noInputUrl: string }): string {
  return xmlDoc(
    `<Gather input="dtmf" numDigits="1" timeout="6" action="${esc(o.actionUrl)}" method="POST"><Say>${esc(o.prompt)}</Say></Gather>` +
      `<Redirect method="POST">${esc(o.noInputUrl)}</Redirect>`,
  );
}

/** Leave a message. The recording arrives on `recordingUrl`; `doneUrl` runs after the beep-and-talk ends. */
export function voicemailTwiml(o: { greeting: string; doneUrl: string; recordingUrl: string }): string {
  return xmlDoc(
    `<Say>${esc(o.greeting)}</Say>` +
      `<Record maxLength="180" playBeep="true" timeout="5" action="${esc(o.doneUrl)}" method="POST" recordingStatusCallback="${esc(o.recordingUrl)}" recordingStatusCallbackEvent="completed"/>` +
      `<Hangup/>`,
  );
}

export interface ConferenceOptions {
  name: string;
  /** The caller waits (hold music, muted) until a rep joins; reps start it. */
  role: "caller" | "rep";
  record: boolean;
  recordingUrl: string;
  label: string;
}

/**
 * Join the call's conference. The caller ends it by leaving; a rep leaving
 * does not, so a transfer can hand the caller from one rep to the next. Every
 * participant carries the same record setting, so it holds whoever starts it.
 */
export function conferenceTwiml(o: ConferenceOptions, prefix = ""): string {
  const caller = o.role === "caller";
  const record = o.record ? ` record="record-from-start" recordingStatusCallback="${esc(o.recordingUrl)}" recordingStatusCallbackEvent="completed"` : "";
  return xmlDoc(
    `${prefix}<Dial><Conference startConferenceOnEnter="${caller ? "false" : "true"}" endConferenceOnExit="${caller ? "true" : "false"}" beep="false" participantLabel="${esc(o.label)}"${record}>${esc(o.name)}</Conference></Dial>`,
  );
}
