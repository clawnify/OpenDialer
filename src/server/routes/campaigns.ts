import { createRoute, z, type OpenAPIHono } from "@clawnify/app";
import { get, query, run } from "../db.js";
import { ErrorSchema, LEAD_SELECT, LeadSchema, type LeadOut } from "./leads.js";
import type { Env } from "../types.js";

const CampaignSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    created_at: z.string(),
    total: z.number().int(),
    completed: z.number().int(),
  })
  .openapi("Campaign");

const CAMPAIGN_SELECT = `
  c.*,
  (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) AS total,
  (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.completed = 1) AS completed`;

type CampaignOut = { id: string; name: string; created_at: string; total: number; completed: number };

export function registerCampaignRoutes(app: OpenAPIHono<Env>) {
  const list = createRoute({
    method: "get",
    path: "/api/campaigns",
    tags: ["Campaigns"],
    summary: "List campaigns, newest first (max 50)",
    responses: { 200: { description: "Campaigns", content: { "application/json": { schema: z.object({ campaigns: z.array(CampaignSchema) }) } } } },
  });
  app.openapi(list, async (c) => {
    const campaigns = await query<CampaignOut>(`SELECT ${CAMPAIGN_SELECT} FROM campaigns c ORDER BY c.created_at DESC LIMIT 50`);
    return c.json({ campaigns }, 200);
  });

  const create = createRoute({
    method: "post",
    path: "/api/campaigns",
    tags: ["Campaigns"],
    summary: "Create a campaign from explicit lead ids or from a filter (status/country/search). Do-not-call leads are never included.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(120),
              lead_ids: z.array(z.string()).max(1000).optional(),
              filter: z
                .object({
                  status: z.enum(["new", "called", "calling"]).optional(),
                  country: z.string().optional(),
                  search: z.string().optional(),
                })
                .optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
      400: { description: "No leads matched", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(create, async (c) => {
    const body = c.req.valid("json");
    let ids: string[] = [];
    if (body.lead_ids?.length) {
      ids = body.lead_ids;
    } else {
      const where = ["status != 'do_not_call'"];
      const params: unknown[] = [];
      const f = body.filter || {};
      if (f.status) {
        where.push("status = ?");
        params.push(f.status);
      }
      if (f.country) {
        where.push("country = ?");
        params.push(f.country.toUpperCase());
      }
      if (f.search?.trim()) {
        where.push("(first_name LIKE ? OR last_name LIKE ? OR company LIKE ? OR phone LIKE ?)");
        const s = `%${f.search.trim()}%`;
        params.push(s, s, s, s);
      }
      const rows = await query<{ id: string }>(`SELECT id FROM leads WHERE ${where.join(" AND ")} ORDER BY created_at ASC LIMIT 1000`, params);
      ids = rows.map((r) => r.id);
    }
    if (ids.length === 0) return c.json({ error: "No leads matched. Add leads first." }, 400);

    const id = crypto.randomUUID();
    await run("INSERT INTO campaigns (id, name) VALUES (?, ?)", [id, body.name.trim()]);
    let pos = 0;
    for (const leadId of ids) {
      // Explicit ids are trusted only if they exist and are callable.
      const ok = await get("SELECT id FROM leads WHERE id = ? AND status != 'do_not_call'", [leadId]);
      if (!ok) continue;
      await run("INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, position) VALUES (?, ?, ?)", [id, leadId, pos++]);
    }
    const campaign = (await get<CampaignOut>(`SELECT ${CAMPAIGN_SELECT} FROM campaigns c WHERE c.id = ?`, [id]))!;
    return c.json({ campaign }, 201);
  });

  const next = createRoute({
    method: "get",
    path: "/api/campaigns/{id}/next",
    tags: ["Campaigns"],
    summary: "The next lead to work in this campaign (lowest incomplete position), or null when done",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Next lead", content: { "application/json": { schema: z.object({ campaign: CampaignSchema, lead: LeadSchema.nullable(), position: z.number().int().nullable() }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(next, async (c) => {
    const id = c.req.valid("param").id;
    const campaign = await get<CampaignOut>(`SELECT ${CAMPAIGN_SELECT} FROM campaigns c WHERE c.id = ?`, [id]);
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);
    const row = await get<LeadOut & { position: number }>(
      `SELECT ${LEAD_SELECT}, cl.position AS position FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ? AND cl.completed = 0 AND l.status != 'do_not_call' ORDER BY cl.position ASC LIMIT 1`,
      [id],
    );
    if (!row) return c.json({ campaign, lead: null, position: null }, 200);
    const { position, ...lead } = row;
    return c.json({ campaign, lead, position }, 200);
  });

  const complete = createRoute({
    method: "post",
    path: "/api/campaigns/{id}/leads/{leadId}/complete",
    tags: ["Campaigns"],
    summary: "Mark a lead done in this campaign (the rep clicked Next)",
    request: { params: z.object({ id: z.string(), leadId: z.string() }) },
    responses: {
      200: { description: "Marked", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      404: { description: "Not in campaign", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(complete, async (c) => {
    const { id, leadId } = c.req.valid("param");
    const res = await run("UPDATE campaign_leads SET completed = 1 WHERE campaign_id = ? AND lead_id = ?", [id, leadId]);
    if (!res.changes) return c.json({ error: "Lead is not in this campaign" }, 404);
    return c.json({ ok: true }, 200);
  });

  const remove = createRoute({
    method: "delete",
    path: "/api/campaigns/{id}",
    tags: ["Campaigns"],
    summary: "Delete a campaign (leads are kept)",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(remove, async (c) => {
    const id = c.req.valid("param").id;
    const res = await run("DELETE FROM campaigns WHERE id = ?", [id]);
    if (!res.changes) return c.json({ error: "Campaign not found" }, 404);
    await run("DELETE FROM campaign_leads WHERE campaign_id = ?", [id]);
    return c.json({ ok: true }, 200);
  });
}
