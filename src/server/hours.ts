// Business hours for a number. Stored as JSON on numbers.hours:
//   { "tz": "Europe/Amsterdam", "days": { "mon": [["09:00", "17:30"]], ... } }
// An empty string means always open. A day missing from `days` (or with no
// ranges) is closed all day. Ranges are local wall-clock time in `tz` and do
// not cross midnight: split an overnight shift into two days' ranges.

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];

export interface Hours {
  tz: string;
  days: Partial<Record<Day, [string, string][]>>;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate and canonicalise. Returns an error string for the user, or the hours. */
export function parseHours(input: unknown): { ok: true; hours: Hours | null } | { ok: false; error: string } {
  if (input === null || input === undefined || input === "") return { ok: true, hours: null };
  const h = (typeof input === "string" ? safeJson(input) : input) as Hours | undefined;
  if (!h || typeof h !== "object" || typeof h.tz !== "string") return { ok: false, error: "Business hours need a time zone" };
  if (!validTimeZone(h.tz)) return { ok: false, error: `Unknown time zone: ${h.tz}` };
  const days: Hours["days"] = {};
  for (const [d, ranges] of Object.entries(h.days || {})) {
    if (!(DAYS as readonly string[]).includes(d)) return { ok: false, error: `Unknown day: ${d}` };
    if (!Array.isArray(ranges)) return { ok: false, error: `Hours for ${d} must be a list of [open, close]` };
    const out: [string, string][] = [];
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !HHMM.test(r[0]) || !HHMM.test(r[1])) return { ok: false, error: `Hours for ${d} must be HH:MM pairs` };
      if (r[0] >= r[1]) return { ok: false, error: `On ${d}, opening time must be before closing time` };
      out.push([r[0], r[1]]);
    }
    if (out.length) days[d as Day] = out;
  }
  return { ok: true, hours: { tz: h.tz, days } };
}

/** Is the line open at `now`? Null hours = always open. */
export function isOpen(hours: Hours | null, now: Date = new Date()): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: hours.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const day = get("weekday").slice(0, 3).toLowerCase() as Day;
  const time = `${get("hour")}:${get("minute")}`;
  return (hours.days[day] || []).some(([open, close]) => time >= open && time < close);
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
