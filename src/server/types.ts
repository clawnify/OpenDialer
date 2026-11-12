export type Bindings = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  TWILIO_TWIML_APP_SID?: string;
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  /** Twilio home region: "us1" (default) or "ie1". Every Twilio credential must be created in this region. */
  TWILIO_REGION?: string;
  /** Override the origin used in Twilio callback URLs. Defaults to the request origin. */
  PUBLIC_APP_URL?: string;
};

export type Env = { Bindings: Bindings };

export const LEAD_STATUSES = ["new", "calling", "called", "do_not_call"] as const;
export const CALL_STATUSES = ["initiated", "ringing", "in-progress", "completed", "failed", "no-answer", "busy", "canceled", "missed", "voicemail"] as const;
/** Final states. `missed` and `voicemail` are inbound calls nobody answered. */
export const TERMINAL_CALL_STATUSES = ["completed", "failed", "no-answer", "busy", "canceled", "missed", "voicemail"] as const;
export const OUTCOMES = ["connected", "voicemail", "no_answer", "busy", "wrong_number", "not_interested", "callback", "do_not_call"] as const;
/** A call in one of these states blocks a second call for the same rep. */
export const ACTIVE_CALL_STATUSES = ["initiated", "ringing", "in-progress"] as const;

export interface LeadRow {
  id: string;
  first_name: string;
  last_name: string;
  company: string;
  phone: string;
  country: string;
  timezone: string | null;
  status: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface NumberRow {
  id: string;
  e164: string;
  country: string;
  area_code: string;
  twilio_sid: string;
  active: number;
  label: string;
  route: string;
  team_id: string | null;
  menu: string;
  greeting: string;
  hours: string;
  closed_message: string;
  voicemail_greeting: string;
  record_inbound: number;
  connected: number;
  previous_voice_url: string;
  previous_voice_application_sid: string;
  previous_status_callback: string;
  created_at: string;
}

export const ROUTES = ["off", "team", "menu"] as const;

export interface MenuOption {
  digit: string;
  label: string;
  team_id: string;
}

export interface TeamRow {
  id: string;
  name: string;
  ring_seconds: number;
  created_at: string;
}

export interface CallLegRow {
  id: string;
  call_id: string;
  user_id: string;
  kind: "ring" | "transfer";
  replaces_leg_id: string | null;
  twilio_call_sid: string | null;
  status: "ringing" | "joined" | "left" | "missed";
  created_at: string;
  updated_at: string;
}

export interface CallRow {
  id: string;
  lead_id: string | null;
  user_id: string | null;
  from_number: string;
  to_number: string;
  twilio_call_sid: string | null;
  parent_call_sid: string | null;
  mode: string;
  direction: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  record: number;
  recording_url: string | null;
  recording_sid: string | null;
  recording_duration: number | null;
  outcome: string | null;
  notes: string;
  number_id: string | null;
  team_id: string | null;
  voicemail_url: string | null;
  voicemail_sid: string | null;
  voicemail_duration: number | null;
  tags: string;
  assigned_to: string | null;
  handled_at: string | null;
  handled_by: string | null;
  error: string;
  created_at: string;
}
