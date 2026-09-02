import { createRoute, z, user, type OpenAPIHono } from "@clawnify/app";
import { get, query, run } from "../db.js";
import { providerConfig, publicOrigin } from "../config.js";
import { normalizePhone } from "../phone.js";
import { pickFromNumber } from "../presence.js";
import { createCall, dialTwiml, endCall, fetchRecording, sayTwiml, TwilioError, voiceAccessToken, VOICE_TOKEN_TTL_SECONDS } from "../twilio.js";
import { CallSchema, ErrorSchema, loadLead, publicCall } from "./leads.js";
import { userKey } from "./settings.js";
import { ACTIVE_CALL_STATUSES, OUTCOMES, type CallRow, type Env, type NumberRow } from "../types.js";

const ACTIVE_IN = ACTIVE_CALL_STATUSES.map((s) => `'${s}'`).join(",");

/** Callback URLs for one call. Twilio signs the exact URL it requests, so these are built once and reused. */
export function callbackUrls(origin: string, callId: string) {
  const q = `?call=${encodeURIComponent(callId)}`;
  return {
    dialAction: `${origin}/api/twilio/status${q}&leg=dial`,
    numberStatus: `${origin}/api/twilio/status${q}&leg=number`,
    parentStatus: `${origin}/api/twilio/status${q}&leg=parent`,
    recording: `${origin}/api/twilio/recording${q}`,
  };
}

function paging(q: { page?: string; limit?: string }) {
  const page = Math.max(1, parseInt(q.page || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

export function registerCallRoutes(app: OpenAPIHono<Env>) {
  const token = createRoute({
    method: "post",
    path: "/api/token",
    tags: ["Calls"],
    summary: "Short-lived Twilio Voice SDK token for the current rep (browser calling only)",
    responses: {
      200: { description: "Token", content: { "application/json": { schema: z.object({ token: z.string(), identity: z.string(), ttl_seconds: z.number().int() }) } } },
      400: { description: "Voice SDK not configured", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(token, async (c) => {
    const cfg = providerConfig(c.env);
    if (!cfg.voiceSdk) return c.json({ error: "Browser calling needs TWILIO_TWIML_APP_SID, TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET." }, 400);
    const identity = userKey(c);
    return c.json({ token: await voiceAccessToken(c.env, identity), identity, ttl_seconds: VOICE_TOKEN_TTL_SECONDS }, 200);
  });

  const start = createRoute({
    method: "post",
    path: "/api/calls",
    tags: ["Calls"],
    summary: "Start an outbound call to a lead. One active call per rep. Returns a Voice token in browser mode; in API mode Twilio rings the rep's phone first.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              lead_id: z.string(),
              from_number: z.string().optional().openapi({ description: "Owned caller ID in E.164; omit for local presence" }),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Call created",
        content: {
          "application/json": {
            schema: z.object({
              call: CallSchema,
              mode: z.enum(["browser", "api"]),
              token: z.string().nullable(),
              connect_params: z.record(z.string(), z.string()).nullable().openapi({ description: "Pass to Device.connect({ params }) in browser mode" }),
            }),
          },
        },
      },
      400: { description: "Cannot dial", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Lead not found", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "A call is already in progress", content: { "application/json": { schema: ErrorSchema } } },
      502: { description: "Twilio error", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(start, async (c) => {
    const cfg = providerConfig(c.env);
    if (!cfg.rest) return c.json({ error: `Twilio is not configured. Missing: ${cfg.missing.join(", ")}` }, 400);
    const body = c.req.valid("json");
    const lead = await loadLead(body.lead_id);
    if (!lead) return c.json({ error: "Lead not found" }, 404);
    if (lead.status === "do_not_call") return c.json({ error: "This lead is marked do not call" }, 400);
    const phone = normalizePhone(lead.phone);
    if (!phone.ok) return c.json({ error: `Lead phone is not dialable: ${phone.error}` }, 400);

    const rep = userKey(c);
    const active = await get<{ id: string }>(
      `SELECT id FROM calls WHERE user_id = ? AND status IN (${ACTIVE_IN}) AND created_at > datetime('now', '-2 hours') LIMIT 1`,
      [rep],
    );
    if (active) return c.json({ error: "You already have a call in progress. Hang up before starting another." }, 409);

    const prefs = await get<{ callback_number: string; default_from_number: string; record_calls: number }>("SELECT callback_number, default_from_number, record_calls FROM user_settings WHERE user_id = ?", [rep]);
    const record = prefs ? prefs.record_calls === 1 : true;
    const owned = await query<NumberRow>("SELECT e164, country, area_code, active FROM numbers WHERE active = 1 LIMIT 500");
    const pick = pickFromNumber({
      requested: body.from_number || prefs?.default_from_number || null,
      leadCountry: phone.country,
      leadAreaCode: phone.areaCode,
      owned,
      fallback: cfg.fromNumber,
    });
    if (!pick.from) return c.json({ error: "No caller ID available. Sync your numbers on the Numbers page (or set TWILIO_FROM_NUMBER)." }, 400);
    if (body.from_number && pick.reason !== "requested") return c.json({ error: "That caller ID is not a number this account owns" }, 400);

    const mode: "browser" | "api" = cfg.voiceSdk ? "browser" : "api";
    if (mode === "api" && !prefs?.callback_number) {
      return c.json({ error: "Browser calling is not configured. Add your phone number in Settings so Twilio can call you first." }, 400);
    }

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO calls (id, lead_id, user_id, from_number, to_number, mode, status, record) VALUES (?, ?, ?, ?, ?, ?, 'initiated', ?)",
      [id, lead.id, rep, pick.from, phone.e164, mode, record ? 1 : 0],
    );
    await run("UPDATE leads SET status = 'calling', updated_at = datetime('now') WHERE id = ?", [lead.id]);

    if (mode === "browser") {
      const tok = await voiceAccessToken(c.env, rep);
      const row = (await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]))!;
      // Only the call id crosses the browser; number and caller ID are read back from the row.
      return c.json({ call: publicCall(row), mode, token: tok, connect_params: { callId: id } }, 201);
    }

    const urls = callbackUrls(publicOrigin(c.env, c.req.url), id);
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "your lead";
    try {
      const created = await createCall(c.env, {
        to: prefs!.callback_number,
        from: pick.from,
        twiml: dialTwiml(
          { to: phone.e164, callerId: pick.from, actionUrl: urls.dialAction, numberStatusUrl: urls.numberStatus, recordingUrl: urls.recording, record },
          sayTwiml(`Connecting you to ${name}.`),
        ),
        statusCallback: urls.parentStatus,
      });
      await run("UPDATE calls SET parent_call_sid = ? WHERE id = ?", [created.sid, id]);
    } catch (e) {
      const msg = e instanceof TwilioError ? e.message : "Could not reach Twilio";
      await run("UPDATE calls SET status = 'failed', error = ?, ended_at = datetime('now') WHERE id = ?", [msg, id]);
      await run("UPDATE leads SET status = 'called', updated_at = datetime('now') WHERE id = ?", [lead.id]);
      return c.json({ error: msg }, 502);
    }
    const row = (await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]))!;
    return c.json({ call: publicCall(row), mode, token: null, connect_params: null }, 201);
  });

  const list = createRoute({
    method: "get",
    path: "/api/calls",
    tags: ["Calls"],
    summary: "Call log, newest first, paginated",
    request: { query: z.object({ page: z.string().optional(), limit: z.string().optional(), lead_id: z.string().optional(), status: z.string().optional() }) },
    responses: { 200: { description: "Calls", content: { "application/json": { schema: z.object({ calls: z.array(CallSchema), total: z.number().int(), page: z.number().int(), limit: z.number().int() }) } } } },
  });
  app.openapi(list, async (c) => {
    const q = c.req.valid("query");
    const { page, limit, offset } = paging(q);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.lead_id) {
      where.push("lead_id = ?");
      params.push(q.lead_id);
    }
    if (q.status) {
      where.push("status = ?");
      params.push(q.status);
    }
    const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = await get<{ total: number }>(`SELECT COUNT(*) AS total FROM calls${sql}`, params);
    const rows = await query<CallRow>(`SELECT * FROM calls${sql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return c.json({ calls: rows.map(publicCall), total: total?.total || 0, page, limit }, 200);
  });

  const getOne = createRoute({
    method: "get",
    path: "/api/calls/{id}",
    tags: ["Calls"],
    summary: "One call; poll this during a live call",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Call", content: { "application/json": { schema: z.object({ call: CallSchema }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(getOne, async (c) => {
    const row = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [c.req.valid("param").id]);
    if (!row) return c.json({ error: "Call not found" }, 404);
    return c.json({ call: publicCall(row) }, 200);
  });

  const hangup = createRoute({
    method: "post",
    path: "/api/calls/{id}/hangup",
    tags: ["Calls"],
    summary: "End a call from the server side (used by API mode; browser mode hangs up through the SDK)",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Call", content: { "application/json": { schema: z.object({ call: CallSchema }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
      502: { description: "Twilio error", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(hangup, async (c) => {
    const id = c.req.valid("param").id;
    const row = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]);
    if (!row) return c.json({ error: "Call not found" }, 404);
    if ((ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)) {
      const sid = row.parent_call_sid || row.twilio_call_sid;
      if (sid) {
        try {
          await endCall(c.env, sid);
        } catch (e) {
          if (e instanceof TwilioError && e.status !== 404) return c.json({ error: e.message }, 502);
        }
      }
      // Twilio's completed callback normally lands within a second; if the
      // call never reached Twilio there is nothing to wait for.
      if (!sid) {
        await run("UPDATE calls SET status = 'canceled', ended_at = datetime('now') WHERE id = ?", [id]);
        await run("UPDATE leads SET status = 'called', updated_at = datetime('now') WHERE id = ? AND status = 'calling'", [row.lead_id]);
      }
    }
    return c.json({ call: publicCall((await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]))!) }, 200);
  });

  const outcome = createRoute({
    method: "post",
    path: "/api/calls/{id}/outcome",
    tags: ["Calls"],
    summary: "Record what happened on the call. 'do_not_call' also flags the lead.",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ outcome: z.enum(OUTCOMES), notes: z.string().max(4000).optional() }) } } },
    },
    responses: {
      200: { description: "Call", content: { "application/json": { schema: z.object({ call: CallSchema }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(outcome, async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const row = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]);
    if (!row) return c.json({ error: "Call not found" }, 404);
    await run("UPDATE calls SET outcome = ?, notes = ? WHERE id = ?", [body.outcome, body.notes ?? row.notes, id]);
    // A stuck "initiated" (browser never connected) is closed out here so it stops blocking the rep.
    if ((ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)) {
      await run("UPDATE calls SET status = 'canceled', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ? AND status IN (" + ACTIVE_IN + ")", [id]);
    }
    const leadStatus = body.outcome === "do_not_call" ? "do_not_call" : "called";
    await run("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?", [leadStatus, row.lead_id]);
    return c.json({ call: publicCall((await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]))!) }, 200);
  });

  // Recording proxy. Not on the OpenAPI surface: it streams audio, not JSON.
  app.get("/api/calls/:id/recording", async (c) => {
    const row = await get<CallRow>("SELECT recording_url FROM calls WHERE id = ?", [c.req.param("id")]);
    if (!row?.recording_url) return c.json({ error: "No recording for this call" }, 404);
    if (!providerConfig(c.env).rest) return c.json({ error: "Twilio is not configured" }, 400);
    // Pass Range through and echo the length headers back, so the browser's
    // player can read the duration and seek instead of showing 0:00.
    const upstream = await fetchRecording(c.env, row.recording_url, c.req.header("range"));
    if (!upstream.ok && upstream.status !== 206) return c.json({ error: `Twilio returned ${upstream.status} for the recording` }, 502);
    const headers = new Headers({ "content-type": upstream.headers.get("content-type") || "audio/mpeg", "cache-control": "private, max-age=3600" });
    for (const h of ["content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  // Keep `user` referenced for identity typing in this module.
  void user;
}
