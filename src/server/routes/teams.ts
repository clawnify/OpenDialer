// Teams (ring groups), reps and their availability.
//
// A rep is anyone who has opened the app: the heartbeat (POST /api/presence)
// records their platform name and email in user_settings. There is no
// separate invite step; the workspace's members are the reps.

import { createRoute, z, user, type OpenAPIHono } from "@clawnify/app";
import { get, query, run } from "../db.js";
import { background, ONLINE_WINDOW, sweepStale } from "../inbound.js";
import { publicOrigin } from "../config.js";
import { ErrorSchema } from "./leads.js";
import { canManageRouting, ROUTING_FORBIDDEN, userKey } from "./settings.js";
import type { Env, MenuOption, NumberRow, TeamRow } from "../types.js";

const RepSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    available: z.boolean().openapi({ description: "The rep's own switch: take inbound calls" }),
    online: z.boolean().openapi({ description: "The app is open (heartbeat in the last 90 s). Calls ring only reps who are available AND online." }),
    on_call: z.boolean(),
    team_ids: z.array(z.string()),
  })
  .openapi("Rep");

const TeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    ring_seconds: z.number().int().openapi({ description: "How long members' phones ring before the caller goes to voicemail" }),
    member_ids: z.array(z.string()),
    created_at: z.string(),
  })
  .openapi("Team");

const TeamInput = z.object({
  name: z.string().trim().min(1).max(80),
  ring_seconds: z.number().int().min(10).max(120).optional(),
  member_ids: z.array(z.string().max(100)).max(200).optional(),
});

async function loadTeams(where = "", params: unknown[] = []) {
  const teams = await query<TeamRow>(`SELECT * FROM teams ${where} ORDER BY name LIMIT 200`, params);
  const members = await query<{ team_id: string; user_id: string }>("SELECT team_id, user_id FROM team_members");
  return teams.map((t) => ({ ...t, member_ids: members.filter((m) => m.team_id === t.id).map((m) => m.user_id) }));
}

async function setMembers(teamId: string, ids: string[]) {
  await run("DELETE FROM team_members WHERE team_id = ?", [teamId]);
  for (const id of [...new Set(ids)]) await run("INSERT INTO team_members (team_id, user_id) VALUES (?, ?)", [teamId, id]);
}

/** Numbers whose routing would break if this team disappeared. */
async function numbersUsingTeam(teamId: string): Promise<string[]> {
  const numbers = await query<Pick<NumberRow, "e164" | "route" | "team_id" | "menu">>("SELECT e164, route, team_id, menu FROM numbers WHERE active = 1");
  return numbers
    .filter((n) => {
      if (n.team_id === teamId) return true;
      try {
        return (JSON.parse(n.menu || "[]") as MenuOption[]).some((o) => o.team_id === teamId);
      } catch {
        return false;
      }
    })
    .map((n) => n.e164);
}

export function registerTeamRoutes(app: OpenAPIHono<Env>) {
  const presence = createRoute({
    method: "post",
    path: "/api/presence",
    tags: ["Team"],
    summary: "Heartbeat from the open app, optionally switching the rep's availability. Sent every 30 s while the app is open.",
    request: { body: { content: { "application/json": { schema: z.object({ available: z.boolean().optional() }) } } } },
    responses: { 200: { description: "This rep", content: { "application/json": { schema: z.object({ available: z.boolean() }) } } } },
  });
  app.openapi(presence, async (c) => {
    const body = c.req.valid("json");
    const u = user(c);
    const key = userKey(c);
    const current = await get<{ available: number }>("SELECT available FROM user_settings WHERE user_id = ?", [key]);
    const available = body.available ?? current?.available === 1;
    await run(
      `INSERT INTO user_settings (user_id, name, email, available, last_seen_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, email = excluded.email, available = excluded.available, last_seen_at = excluded.last_seen_at`,
      [key, u?.name || u?.email || (key === "local" ? "You" : ""), u?.email || "", available ? 1 : 0],
    );
    // Heartbeats double as the clock that closes calls a lost Twilio callback left open.
    background(c, sweepStale(c.env, publicOrigin(c.env, c.req.url)));
    return c.json({ available }, 200);
  });

  const reps = createRoute({
    method: "get",
    path: "/api/reps",
    tags: ["Team"],
    summary: "Everyone who has opened the app, with availability and teams",
    responses: { 200: { description: "Reps", content: { "application/json": { schema: z.object({ reps: z.array(RepSchema) }) } } } },
  });
  app.openapi(reps, async (c) => {
    const rows = await query<{ user_id: string; name: string; email: string; available: number; online: number; on_call: number }>(
      `SELECT u.user_id, u.name, u.email, u.available,
         (u.last_seen_at > datetime('now', '${ONLINE_WINDOW}')) AS online,
         EXISTS (SELECT 1 FROM call_legs l JOIN calls c ON c.id = l.call_id WHERE l.user_id = u.user_id AND l.status = 'joined' AND c.status = 'in-progress')
           OR EXISTS (SELECT 1 FROM calls c WHERE c.user_id = u.user_id AND c.direction = 'outbound' AND c.status IN ('initiated', 'ringing', 'in-progress') AND c.created_at > datetime('now', '-2 hours')) AS on_call
       FROM user_settings u WHERE u.last_seen_at IS NOT NULL ORDER BY u.name LIMIT 500`,
    );
    const members = await query<{ team_id: string; user_id: string }>("SELECT team_id, user_id FROM team_members");
    return c.json(
      {
        reps: rows.map((r) => ({
          id: r.user_id,
          name: r.name || r.email || "Unnamed",
          email: r.email,
          available: r.available === 1,
          online: r.online === 1,
          on_call: r.on_call === 1,
          team_ids: members.filter((m) => m.user_id === r.user_id).map((m) => m.team_id),
        })),
      },
      200,
    );
  });

  const list = createRoute({
    method: "get",
    path: "/api/teams",
    tags: ["Team"],
    summary: "Teams (ring groups) with their members",
    responses: { 200: { description: "Teams", content: { "application/json": { schema: z.object({ teams: z.array(TeamSchema) }) } } } },
  });
  app.openapi(list, async (c) => c.json({ teams: await loadTeams() }, 200));

  const create = createRoute({
    method: "post",
    path: "/api/teams",
    tags: ["Team"],
    summary: "Create a team. Members are rep ids from GET /api/reps.",
    request: { body: { content: { "application/json": { schema: TeamInput } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: z.object({ team: TeamSchema }) } } },
      403: { description: "Admins only", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(create, async (c) => {
    if (!canManageRouting(c)) return c.json({ error: ROUTING_FORBIDDEN }, 403);
    const body = c.req.valid("json");
    const id = crypto.randomUUID();
    await run("INSERT INTO teams (id, name, ring_seconds) VALUES (?, ?, ?)", [id, body.name, body.ring_seconds ?? 25]);
    await setMembers(id, body.member_ids || []);
    return c.json({ team: (await loadTeams("WHERE id = ?", [id]))[0] }, 201);
  });

  const patch = createRoute({
    method: "patch",
    path: "/api/teams/{id}",
    tags: ["Team"],
    summary: "Rename a team, change its ring time, or replace its members",
    request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: TeamInput.partial() } } } },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: z.object({ team: TeamSchema }) } } },
      403: { description: "Admins only", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(patch, async (c) => {
    if (!canManageRouting(c)) return c.json({ error: ROUTING_FORBIDDEN }, 403);
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const team = await get<TeamRow>("SELECT * FROM teams WHERE id = ?", [id]);
    if (!team) return c.json({ error: "Team not found" }, 404);
    await run("UPDATE teams SET name = ?, ring_seconds = ? WHERE id = ?", [body.name ?? team.name, body.ring_seconds ?? team.ring_seconds, id]);
    if (body.member_ids) await setMembers(id, body.member_ids);
    return c.json({ team: (await loadTeams("WHERE id = ?", [id]))[0] }, 200);
  });

  const del = createRoute({
    method: "delete",
    path: "/api/teams/{id}",
    tags: ["Team"],
    summary: "Delete a team. Refused while a number routes calls to it.",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: "Admins only", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "In use", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(del, async (c) => {
    if (!canManageRouting(c)) return c.json({ error: ROUTING_FORBIDDEN }, 403);
    const id = c.req.valid("param").id;
    const using = await numbersUsingTeam(id);
    if (using.length) return c.json({ error: `Calls to ${using.join(", ")} ring this team. Route those numbers elsewhere first.` }, 409);
    await run("DELETE FROM teams WHERE id = ?", [id]);
    return c.json({ ok: true }, 200);
  });
}
