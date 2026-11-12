// Typed wrapper over the app's own API.

export interface Lead {
  id: string;
  first_name: string;
  last_name: string;
  company: string;
  phone: string;
  country: string;
  timezone: string | null;
  status: "new" | "calling" | "called" | "do_not_call";
  notes: string;
  created_at: string;
  updated_at: string;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number;
}

export interface Call {
  id: string;
  /** Null for an inbound caller who is not a lead yet. */
  lead_id: string | null;
  user_id: string | null;
  from_number: string;
  to_number: string;
  twilio_call_sid: string | null;
  mode: "browser" | "api" | "conference";
  direction: "outbound" | "inbound";
  status: "initiated" | "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy" | "canceled" | "missed" | "voicemail";
  number_id: string | null;
  team_id: string | null;
  /** The caller's message, streamed by the app; null when none was left. */
  voicemail_url: string | null;
  voicemail_duration: number | null;
  tags: string[];
  assigned_to: string | null;
  handled_at: string | null;
  handled_by: string | null;
  contact_name: string | null;
  user_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  record: number;
  recording_url: string | null;
  recording_duration: number | null;
  outcome: string | null;
  notes: string;
  error: string;
  created_at: string;
}

export interface MenuOption {
  digit: string;
  label: string;
  team_id: string;
}

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface Hours {
  tz: string;
  days: Partial<Record<Day, [string, string][]>>;
}

export interface OwnedNumber {
  id: string;
  e164: string;
  country: string;
  area_code: string;
  active: number;
  label: string;
  route: "off" | "team" | "menu";
  team_id: string | null;
  menu: MenuOption[];
  greeting: string;
  hours: Hours | null;
  closed_message: string;
  voicemail_greeting: string;
  record_inbound: boolean;
  connected: boolean;
}

export type NumberRouting = Partial<Pick<OwnedNumber, "label" | "route" | "team_id" | "menu" | "greeting" | "hours" | "closed_message" | "voicemail_greeting" | "record_inbound">>;

export interface Rep {
  id: string;
  name: string;
  email: string;
  available: boolean;
  online: boolean;
  on_call: boolean;
  team_ids: string[];
}

export interface Team {
  id: string;
  name: string;
  ring_seconds: number;
  member_ids: string[];
  created_at: string;
}

export interface RingingCall {
  call: Call | null;
  leg_id: string | null;
  kind: "ring" | "transfer" | null;
  team_name: string | null;
  number_label: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  created_at: string;
  total: number;
  completed: number;
}

export interface Settings {
  provider: "twilio";
  region: string;
  edge: string | null;
  configured: boolean;
  voice_sdk_enabled: boolean;
  incoming_enabled: boolean;
  missing: string[];
  default_from_number: string;
  public_url: string;
  webhooks: { voice: string; status: string; recording: string; inbound: string; inbound_status: string };
  user: { id: string; name: string } | null;
  /** This rep's key; inbound calls ring the browser registered under it. */
  identity: string;
  callback_number: string;
  preferred_from_number: string;
  record_calls: boolean;
}

export interface StartCallResponse {
  call: Call;
  mode: "browser" | "api";
  /** Browser mode only: short-lived Voice SDK token plus the params to connect with. */
  token: string | null;
  connect_params: Record<string, string> | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError((body.error as string) || `Request failed (${res.status})`, res.status, body);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export const api = {
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (patch: { callback_number?: string; preferred_from_number?: string; record_calls?: boolean }) =>
    req<{ callback_number: string; preferred_from_number: string; record_calls: boolean }>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  leads: (p: { page?: number; limit?: number; search?: string; status?: string; country?: string } = {}) =>
    req<{ leads: Lead[]; total: number; page: number; limit: number }>(`/api/leads${qs(p)}`),
  lead: (id: string) => req<{ lead: Lead; calls: Call[] }>(`/api/leads/${id}`),
  createLead: (body: Partial<Lead>) => req<{ lead: Lead }>("/api/leads", { method: "POST", body: JSON.stringify(body) }),
  updateLead: (id: string, body: Partial<Lead>) => req<{ lead: Lead }>(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLead: (id: string) => req<{ ok: boolean }>(`/api/leads/${id}`, { method: "DELETE" }),
  importLeads: (csv: string, default_country?: string) =>
    req<{ imported: number; rejected: number; duplicates: number; errors: { line: number; error: string }[] }>("/api/leads/import", {
      method: "POST",
      body: JSON.stringify({ csv, default_country: default_country || undefined }),
    }),
  countries: () => req<{ countries: string[] }>("/api/countries"),

  numbers: () => req<{ numbers: OwnedNumber[] }>("/api/numbers"),
  syncNumbers: () => req<{ synced: number; numbers: OwnedNumber[] }>("/api/numbers/sync", { method: "POST" }),
  saveNumber: (id: string, body: NumberRouting) => req<{ number: OwnedNumber }>(`/api/numbers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  connectNumber: (id: string) => req<{ number: OwnedNumber; previous_voice_url: string }>(`/api/numbers/${id}/connect`, { method: "POST" }),
  disconnectNumber: (id: string) => req<{ number: OwnedNumber }>(`/api/numbers/${id}/disconnect`, { method: "POST" }),

  presence: (available?: boolean) => req<{ available: boolean }>("/api/presence", { method: "POST", body: JSON.stringify(available === undefined ? {} : { available }) }),
  reps: () => req<{ reps: Rep[] }>("/api/reps"),
  teams: () => req<{ teams: Team[] }>("/api/teams"),
  createTeam: (body: { name: string; ring_seconds?: number; member_ids?: string[] }) => req<{ team: Team }>("/api/teams", { method: "POST", body: JSON.stringify(body) }),
  updateTeam: (id: string, body: { name?: string; ring_seconds?: number; member_ids?: string[] }) => req<{ team: Team }>(`/api/teams/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTeam: (id: string) => req<{ ok: boolean }>(`/api/teams/${id}`, { method: "DELETE" }),

  inbox: (p: { state?: "open" | "handled" | "all"; assigned?: "me" | "anyone" | "nobody" } = {}) =>
    req<{ calls: Call[]; total: number; open: number }>(`/api/inbox${qs(p)}`),
  updateCall: (id: string, body: { notes?: string; tags?: string[]; assigned_to?: string | null; handled?: boolean }) =>
    req<{ call: Call }>(`/api/calls/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  ringing: (leg_sid?: string) => req<RingingCall>(`/api/calls/ringing${qs({ leg_sid })}`),
  transfer: (id: string, body: { user_id?: string; team_id?: string; mode: "warm" | "blind" }) =>
    req<{ ringing: string[] }>(`/api/calls/${id}/transfer`, { method: "POST", body: JSON.stringify(body) }),

  calls: (p: { page?: number; limit?: number; lead_id?: string; direction?: "inbound" | "outbound"; status?: string; user_id?: string; tag?: string } = {}) =>
    req<{ calls: Call[]; total: number; page: number; limit: number }>(`/api/calls${qs(p)}`),
  call: (id: string) => req<{ call: Call }>(`/api/calls/${id}`),
  startCall: (lead_id: string, from_number?: string) =>
    req<StartCallResponse>("/api/calls", { method: "POST", body: JSON.stringify({ lead_id, from_number: from_number || undefined }) }),
  hangup: (id: string) => req<{ call: Call }>(`/api/calls/${id}/hangup`, { method: "POST" }),
  saveOutcome: (id: string, outcome: string, notes?: string) =>
    req<{ call: Call }>(`/api/calls/${id}/outcome`, { method: "POST", body: JSON.stringify({ outcome, notes }) }),
  token: () => req<{ token: string; identity: string; ttl_seconds: number }>("/api/token", { method: "POST" }),

  campaigns: () => req<{ campaigns: Campaign[] }>("/api/campaigns"),
  createCampaign: (body: { name: string; lead_ids?: string[]; filter?: { status?: string; country?: string; search?: string } }) =>
    req<{ campaign: Campaign }>("/api/campaigns", { method: "POST", body: JSON.stringify(body) }),
  nextInCampaign: (id: string) => req<{ campaign: Campaign; lead: Lead | null; position: number | null }>(`/api/campaigns/${id}/next`),
  completeInCampaign: (id: string, leadId: string) => req<{ ok: boolean }>(`/api/campaigns/${id}/leads/${leadId}/complete`, { method: "POST" }),
  deleteCampaign: (id: string) => req<{ ok: boolean }>(`/api/campaigns/${id}`, { method: "DELETE" }),
};

export const OUTCOME_LABELS: Record<string, string> = {
  connected: "Connected",
  voicemail: "Voicemail",
  no_answer: "No answer",
  busy: "Busy",
  wrong_number: "Wrong number",
  not_interested: "Not interested",
  callback: "Callback",
  do_not_call: "Do not call",
};

export function leadName(l: Pick<Lead, "first_name" | "last_name" | "phone">): string {
  return [l.first_name, l.last_name].filter(Boolean).join(" ") || l.phone;
}

/** Who the call was with: the lead's name, else the other party's number. */
export function callParty(c: Pick<Call, "contact_name" | "direction" | "from_number" | "to_number">): string {
  return c.contact_name || (c.direction === "inbound" ? c.from_number : c.to_number) || "Unknown";
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return "–";
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** SQLite's datetime('now') has no zone marker; it is UTC. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
