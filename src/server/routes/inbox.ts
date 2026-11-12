// The shared inbox (missed calls and voicemails until someone handles them),
// call notes and tags, and the live-call actions for inbound calls: finding
// the call that is ringing this browser, and transferring it.

import { createRoute, z, type OpenAPIHono } from "@clawnify/app";
import { get, query, run } from "../db.js";
import { providerConfig, publicOrigin } from "../config.js";
import { availableReps, ringReps, teamMemberIds } from "../inbound.js";
import { CALL_SELECT, CallSchema, ErrorSchema, loadCall, publicCall } from "./leads.js";
import { userKey } from "./settings.js";
import type { CallLegRow, CallRow, Env, TeamRow } from "../types.js";

const INBOX_WHERE = "c.direction = 'inbound' AND c.status IN ('missed', 'voicemail')";

export function registerInboxRoutes(app: OpenAPIHono<Env>) {
  const inbox = createRoute({
    method: "get",
    path: "/api/inbox",
    tags: ["Inbox"],
    summary: "Missed inbound calls and voicemails. `open` (default) = not yet handled.",
    request: {
      query: z.object({
        state: z.enum(["open", "handled", "all"]).optional(),
        assigned: z.enum(["me", "anyone", "nobody"]).optional(),
        page: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: { 200: { description: "Inbox", content: { "application/json": { schema: z.object({ calls: z.array(CallSchema), total: z.number().int(), open: z.number().int() }) } } } },
  });
  app.openapi(inbox, async (c) => {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "50", 10) || 50));
    const where = [INBOX_WHERE];
    const params: unknown[] = [];
    const state = q.state || "open";
    if (state === "open") where.push("c.handled_at IS NULL");
    if (state === "handled") where.push("c.handled_at IS NOT NULL");
    if (q.assigned === "me") {
      where.push("c.assigned_to = ?");
      params.push(userKey(c));
    }
    if (q.assigned === "nobody") where.push("c.assigned_to IS NULL");
    const sql = where.join(" AND ");
    const total = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM calls c WHERE ${sql}`, params);
    const open = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM calls c WHERE ${INBOX_WHERE} AND c.handled_at IS NULL`);
    const rows = await query<CallRow>(`SELECT ${CALL_SELECT} FROM calls c WHERE ${sql} ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    return c.json({ calls: rows.map(publicCall), total: total?.n || 0, open: open?.n || 0 }, 200);
  });

  const patch = createRoute({
    method: "patch",
    path: "/api/calls/{id}",
    tags: ["Inbox"],
    summary: "Notes and tags on any call; assignment and handled state for inbox items",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              notes: z.string().max(4000).optional(),
              tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
              assigned_to: z.string().max(100).nullable().optional().openapi({ description: "Rep id from GET /api/reps; null to unassign" }),
              handled: z.boolean().optional().openapi({ description: "true closes the inbox item, false reopens it" }),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Call", content: { "application/json": { schema: z.object({ call: CallSchema }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(patch, async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const row = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]);
    if (!row) return c.json({ error: "Call not found" }, 404);
    const tags = body.tags ? JSON.stringify([...new Set(body.tags.map((t) => t.toLowerCase()))]) : row.tags;
    const assigned = body.assigned_to === undefined ? row.assigned_to : body.assigned_to;
    let handledAt = row.handled_at;
    let handledBy = row.handled_by;
    if (body.handled === true && !row.handled_at) {
      handledAt = new Date().toISOString().replace("T", " ").slice(0, 19);
      handledBy = userKey(c);
    } else if (body.handled === false) {
      handledAt = null;
      handledBy = null;
    }
    await run("UPDATE calls SET notes = ?, tags = ?, assigned_to = ?, handled_at = ?, handled_by = ? WHERE id = ?", [body.notes ?? row.notes, tags, assigned, handledAt, handledBy, id]);
    return c.json({ call: publicCall((await loadCall(id))!) }, 200);
  });

  const ringing = createRoute({
    method: "get",
    path: "/api/calls/ringing",
    tags: ["Calls"],
    summary: "The inbound call ringing this rep's browser now, matched by the Twilio leg SID the browser sees",
    request: { query: z.object({ leg_sid: z.string().optional() }) },
    responses: {
      200: {
        description: "Ringing call, or null",
        content: { "application/json": { schema: z.object({ call: CallSchema.nullable(), leg_id: z.string().nullable(), kind: z.string().nullable(), team_name: z.string().nullable(), number_label: z.string().nullable() }) } },
      },
    },
  });
  app.openapi(ringing, async (c) => {
    const q = c.req.valid("query");
    const me = userKey(c);
    const leg = await get<CallLegRow>(
      `SELECT * FROM call_legs WHERE user_id = ? AND status IN ('ringing', 'joined') ${q.leg_sid ? "AND twilio_call_sid = ?" : ""} ORDER BY created_at DESC LIMIT 1`,
      q.leg_sid ? [me, q.leg_sid] : [me],
    );
    if (!leg) return c.json({ call: null, leg_id: null, kind: null, team_name: null, number_label: null }, 200);
    const call = (await loadCall(leg.call_id))!;
    const team = call.team_id ? await get<TeamRow>("SELECT name FROM teams WHERE id = ?", [call.team_id]) : undefined;
    const number = call.number_id ? await get<{ label: string; e164: string }>("SELECT label, e164 FROM numbers WHERE id = ?", [call.number_id]) : undefined;
    return c.json({ call: publicCall(call), leg_id: leg.id, kind: leg.kind, team_name: team?.name || null, number_label: number ? number.label || number.e164 : null }, 200);
  });

  const transfer = createRoute({
    method: "post",
    path: "/api/calls/{id}/transfer",
    tags: ["Calls"],
    summary:
      "Transfer a live inbound call to a teammate or a team. warm: you stay on the line until they answer and you hang up. blind: you are dropped the moment they answer. Either way, if nobody answers the caller stays with you; if you have already hung up, the caller goes to voicemail.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              user_id: z.string().optional().openapi({ description: "One rep" }),
              team_id: z.string().optional().openapi({ description: "Ring a whole team" }),
              mode: z.enum(["warm", "blind"]),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Ringing", content: { "application/json": { schema: z.object({ ringing: z.array(z.string()).openapi({ description: "Rep ids being rung" }) }) } } },
      400: { description: "Cannot transfer", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(transfer, async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    if (!body.user_id === !body.team_id) return c.json({ error: "Pick one teammate or one team" }, 400);
    if (!providerConfig(c.env).rest) return c.json({ error: "Twilio is not configured" }, 400);
    const call = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]);
    if (!call) return c.json({ error: "Call not found" }, 404);
    if (call.direction !== "inbound" || call.status !== "in-progress") return c.json({ error: "Only a live inbound call can be transferred" }, 400);
    const me = userKey(c);
    const mine = await get<CallLegRow>("SELECT * FROM call_legs WHERE call_id = ? AND user_id = ? AND status = 'joined'", [id, me]);
    if (!mine) return c.json({ error: "You are not on this call" }, 400);
    const pending = await get<{ n: number }>("SELECT COUNT(*) AS n FROM call_legs WHERE call_id = ? AND status = 'ringing'", [id]);
    if ((pending?.n || 0) > 0) return c.json({ error: "A transfer is already ringing" }, 400);

    let ringSeconds = 25;
    let candidates: string[];
    if (body.team_id) {
      const team = await get<TeamRow>("SELECT * FROM teams WHERE id = ?", [body.team_id]);
      if (!team) return c.json({ error: "Team not found" }, 404);
      ringSeconds = team.ring_seconds;
      candidates = await teamMemberIds(team.id);
    } else {
      candidates = [body.user_id!];
    }
    const reps = await availableReps(candidates, [me]);
    if (!reps.length) return c.json({ error: body.team_id ? "Nobody in that team is available" : "That teammate is not available" }, 400);
    await ringReps(c.env, publicOrigin(c.env, c.req.url), call, reps, { kind: "transfer", timeoutSeconds: ringSeconds, replacesLegId: body.mode === "blind" ? mine.id : null });
    return c.json({ ringing: reps }, 200);
  });
}
