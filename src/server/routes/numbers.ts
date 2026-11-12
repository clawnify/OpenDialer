import { createRoute, z, type OpenAPIHono } from "@clawnify/app";
import { get, query, run } from "../db.js";
import { providerConfig, publicOrigin } from "../config.js";
import { parseHours } from "../hours.js";
import { numberWebhookUrls } from "../inbound.js";
import { normalizePhone } from "../phone.js";
import { getIncomingNumber, listIncomingNumbers, setNumberVoiceUrl, TwilioError } from "../twilio.js";
import { ErrorSchema } from "./leads.js";
import { canManageRouting, ROUTING_FORBIDDEN } from "./settings.js";
import { ROUTES, type Env, type MenuOption, type NumberRow } from "../types.js";

const MenuOptionSchema = z.object({
  digit: z.string().regex(/^[0-9]$/).openapi({ description: "0-9" }),
  label: z.string().trim().min(1).max(60).openapi({ description: "Spoken as 'For <label>, press <digit>'" }),
  team_id: z.string(),
});

const HoursSchema = z
  .object({
    tz: z.string().openapi({ description: "IANA time zone, e.g. Europe/Amsterdam" }),
    days: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))).openapi({ description: '{ "mon": [["09:00", "17:30"]] }; a missing day is closed' }),
  })
  .openapi("Hours");

const NumberSchema = z
  .object({
    id: z.string(),
    e164: z.string(),
    country: z.string(),
    area_code: z.string(),
    active: z.number().int().openapi({ description: "0 once the number is no longer in the Twilio account" }),
    label: z.string().openapi({ description: "Name shown to reps when it rings, e.g. 'Support line'" }),
    route: z.enum(ROUTES).openapi({ description: "off: no inbound. team: ring one team. menu: press-a-digit menu" }),
    team_id: z.string().nullable(),
    menu: z.array(MenuOptionSchema),
    greeting: z.string(),
    hours: HoursSchema.nullable().openapi({ description: "Null = always open" }),
    closed_message: z.string(),
    voicemail_greeting: z.string(),
    record_inbound: z.boolean(),
    connected: z.boolean().openapi({ description: "Twilio sends this number's calls to this app" }),
  })
  .openapi("Number");

const COLUMNS = "id, e164, country, area_code, active, label, route, team_id, menu, greeting, hours, closed_message, voicemail_greeting, record_inbound, connected";

function publicNumber(n: NumberRow) {
  const hours = parseHours(n.hours);
  let menu: MenuOption[] = [];
  try {
    menu = JSON.parse(n.menu || "[]");
  } catch {
    /* unreadable menu reads as empty */
  }
  return {
    id: n.id,
    e164: n.e164,
    country: n.country,
    area_code: n.area_code,
    active: n.active,
    label: n.label,
    route: (ROUTES as readonly string[]).includes(n.route) ? (n.route as (typeof ROUTES)[number]) : "off",
    team_id: n.team_id,
    menu,
    greeting: n.greeting,
    hours: hours.ok ? hours.hours : null,
    closed_message: n.closed_message,
    voicemail_greeting: n.voicemail_greeting,
    record_inbound: n.record_inbound === 1,
    connected: n.connected === 1,
  };
}

async function allNumbers() {
  return (await query<NumberRow>(`SELECT ${COLUMNS} FROM numbers ORDER BY active DESC, country, e164 LIMIT 500`)).map(publicNumber);
}

export function registerNumberRoutes(app: OpenAPIHono<Env>) {
  const list = createRoute({
    method: "get",
    path: "/api/numbers",
    tags: ["Numbers"],
    summary: "Owned numbers (synced from Twilio) with their inbound routing",
    responses: { 200: { description: "Numbers", content: { "application/json": { schema: z.object({ numbers: z.array(NumberSchema) }) } } } },
  });
  app.openapi(list, async (c) => c.json({ numbers: await allNumbers() }, 200));

  const sync = createRoute({
    method: "post",
    path: "/api/numbers/sync",
    tags: ["Numbers"],
    summary: "Pull the account's voice-capable incoming numbers into the app",
    responses: {
      200: { description: "Synced", content: { "application/json": { schema: z.object({ synced: z.number().int(), numbers: z.array(NumberSchema) }) } } },
      400: { description: "Provider not configured", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "Admins only", content: { "application/json": { schema: ErrorSchema } } },
      502: { description: "Twilio error", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(sync, async (c) => {
    if (!canManageRouting(c)) return c.json({ error: ROUTING_FORBIDDEN }, 403);
    const cfg = providerConfig(c.env);
    if (!cfg.rest) return c.json({ error: "Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." }, 400);
    let owned;
    try {
      owned = await listIncomingNumbers(c.env);
    } catch (e) {
      if (e instanceof TwilioError) return c.json({ error: e.message }, 502);
      throw e;
    }
    const inboundUrl = numberWebhookUrls(publicOrigin(c.env, c.req.url)).voice;
    const seen = new Set<string>();
    for (const n of owned) {
      const parsed = normalizePhone(n.phone_number);
      // Numbers outside the supported markets are kept but tagged with their raw country.
      const country = parsed.ok ? parsed.country : "";
      const area = parsed.ok ? parsed.areaCode : "";
      // Twilio is the truth for where calls go: someone may have repointed the number in the console.
      const connected = n.voice_url === inboundUrl && !n.voice_application_sid ? 1 : 0;
      seen.add(n.phone_number);
      await run(
        `INSERT INTO numbers (id, e164, country, area_code, twilio_sid, active, connected) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(e164) DO UPDATE SET country = excluded.country, area_code = excluded.area_code, twilio_sid = excluded.twilio_sid, active = 1, connected = excluded.connected`,
        [crypto.randomUUID(), n.phone_number, country, area, n.sid, connected],
      );
    }
    // Released numbers stay as history but can no longer be dialled from or called.
    const existing = await query<{ e164: string }>("SELECT e164 FROM numbers WHERE active = 1");
    for (const row of existing) if (!seen.has(row.e164)) await run("UPDATE numbers SET active = 0, connected = 0 WHERE e164 = ?", [row.e164]);

    return c.json({ synced: seen.size, numbers: await allNumbers() }, 200);
  });

  const patch = createRoute({
    method: "patch",
    path: "/api/numbers/{id}",
    tags: ["Numbers"],
    summary: "Set a number's inbound routing: label, team or menu, greeting, business hours, voicemail, recording",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              label: z.string().max(60).optional(),
              route: z.enum(ROUTES).optional(),
              team_id: z.string().nullable().optional(),
              menu: z.array(MenuOptionSchema).max(10).optional(),
              greeting: z.string().max(500).optional(),
              hours: HoursSchema.nullable().optional(),
              closed_message: z.string().max(500).optional(),
              voicemail_greeting: z.string().max(500).optional(),
              record_inbound: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: z.object({ number: NumberSchema }) } } },
      400: { description: "Invalid routing", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "Admins only", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(patch, async (c) => {
    if (!canManageRouting(c)) return c.json({ error: ROUTING_FORBIDDEN }, 403);
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const n = await get<NumberRow>("SELECT * FROM numbers WHERE id = ?", [id]);
    if (!n) return c.json({ error: "Number not found" }, 404);

    const route = body.route ?? n.route;
    const teamId = body.team_id === undefined ? n.team_id : body.team_id;
    const menu = body.menu ?? (JSON.parse(n.menu || "[]") as MenuOption[]);
    const teams = new Set((await query<{ id: string }>("SELECT id FROM teams")).map((t) => t.id));
    if (route === "team" && (!teamId || !teams.has(teamId))) return c.json({ error: "Pick the team that answers this number" }, 400);
    if (route === "menu") {
      if (!menu.length) return c.json({ error: "A menu needs at least one option" }, 400);
      if (new Set(menu.map((o) => o.digit)).size !== menu.length) return c.json({ error: "Each menu option needs its own digit" }, 400);
      if (menu.some((o) => !teams.has(o.team_id))) return c.json({ error: "Every menu option needs a team" }, 400);
    }
    let hours = n.hours;
    if (body.hours !== undefined) {
      const parsed = parseHours(body.hours);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      hours = parsed.hours ? JSON.stringify(parsed.hours) : "";
    }
    const record = body.record_inbound === undefined ? n.record_inbound : body.record_inbound ? 1 : 0;
    await run(
      `UPDATE numbers SET label = ?, route = ?, team_id = ?, menu = ?, greeting = ?, hours = ?, closed_message = ?, voicemail_greeting = ?, record_inbound = ? WHERE id = ?`,
      [
        (body.label ?? n.label).trim(),
        route,
        teamId,
        JSON.stringify(menu),
        (body.greeting ?? n.greeting).trim(),
        hours,
        (body.closed_message ?? n.closed_message).trim(),
        (body.voicemail_greeting ?? n.voicemail_greeting).trim(),
        record,
        id,
      ],
    );
    return c.json({ number: publicNumber((await get<NumberRow>("SELECT * FROM numbers WHERE id = ?", [id]))!) }, 200);
  });

  const connect = createRoute({
    method: "post",
    path: "/api/numbers/{id}/connect",
    tags: ["Numbers"],
    summary:
      "Send this number's incoming calls to this app (sets its voice URL in Twilio and clears any TwiML App on it). The previous voice URL is kept and restored by disconnect.",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Connected", content: { "application/json": { schema: z.object({ number: NumberSchema, previous_voice_url: z.string().openapi({ description: "What the number pointed at before: a voice URL or a TwiML App SID" }) }) } } },
      400: { description: "Cannot connect", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "Admins only", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
      502: { description: "Twilio error", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(connect, async (c) => {
    if (!canManageRouting(c)) return c.json({ error: ROUTING_FORBIDDEN }, 403);
    const id = c.req.valid("param").id;
    if (!providerConfig(c.env).rest) return c.json({ error: "Twilio is not configured" }, 400);
    const n = await get<NumberRow>("SELECT * FROM numbers WHERE id = ? AND active = 1", [id]);
    if (!n || !n.twilio_sid) return c.json({ error: "Number not found; sync numbers first" }, 404);
    const urls = numberWebhookUrls(publicOrigin(c.env, c.req.url));
    try {
      const before = await getIncomingNumber(c.env, n.twilio_sid);
      // Connecting twice must not remember our own settings as "previous".
      const ours = before.voice_url === urls.voice && !before.voice_application_sid;
      const previous = ours
        ? { url: n.previous_voice_url, app: n.previous_voice_application_sid, status: n.previous_status_callback }
        : { url: before.voice_url || "", app: before.voice_application_sid || "", status: before.status_callback || "" };
      await setNumberVoiceUrl(c.env, n.twilio_sid, { voiceUrl: urls.voice, voiceApplicationSid: "", statusCallback: urls.status });
      await run("UPDATE numbers SET connected = 1, previous_voice_url = ?, previous_voice_application_sid = ?, previous_status_callback = ? WHERE id = ?", [
        previous.url,
        previous.app,
        previous.status,
        id,
      ]);
      return c.json({ number: publicNumber((await get<NumberRow>("SELECT * FROM numbers WHERE id = ?", [id]))!), previous_voice_url: previous.url || previous.app }, 200);
    } catch (e) {
      if (e instanceof TwilioError) return c.json({ error: e.message }, 502);
      throw e;
    }
  });

  const disconnect = createRoute({
    method: "post",
    path: "/api/numbers/{id}/disconnect",
    tags: ["Numbers"],
    summary: "Stop sending this number's calls here and restore what it pointed at before: voice URL, TwiML App and status callback",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Disconnected", content: { "application/json": { schema: z.object({ number: NumberSchema }) } } },
      400: { description: "Cannot disconnect", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "Admins only", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
      502: { description: "Twilio error", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(disconnect, async (c) => {
    if (!canManageRouting(c)) return c.json({ error: ROUTING_FORBIDDEN }, 403);
    const id = c.req.valid("param").id;
    if (!providerConfig(c.env).rest) return c.json({ error: "Twilio is not configured" }, 400);
    const n = await get<NumberRow>("SELECT * FROM numbers WHERE id = ?", [id]);
    if (!n || !n.twilio_sid) return c.json({ error: "Number not found" }, 404);
    try {
      await setNumberVoiceUrl(c.env, n.twilio_sid, { voiceUrl: n.previous_voice_url, voiceApplicationSid: n.previous_voice_application_sid, statusCallback: n.previous_status_callback });
    } catch (e) {
      if (e instanceof TwilioError) return c.json({ error: e.message }, 502);
      throw e;
    }
    await run("UPDATE numbers SET connected = 0 WHERE id = ?", [id]);
    return c.json({ number: publicNumber((await get<NumberRow>("SELECT * FROM numbers WHERE id = ?", [id]))!) }, 200);
  });
}
