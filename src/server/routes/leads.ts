import { createRoute, z, type OpenAPIHono } from "@clawnify/app";
import { get, query, run } from "../db.js";
import { parseCsv } from "../csv.js";
import { normalizePhone, SUPPORTED_COUNTRIES } from "../phone.js";
import { LEAD_STATUSES, type CallRow, type Env, type LeadRow } from "../types.js";

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

export const LeadSchema = z
  .object({
    id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    company: z.string(),
    phone: z.string().openapi({ description: "E.164" }),
    country: z.string(),
    timezone: z.string().nullable(),
    status: z.string().openapi({ description: "new | calling | called | do_not_call" }),
    notes: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    last_outcome: z.string().nullable().openapi({ description: "Outcome of the most recent call, if any" }),
    last_called_at: z.string().nullable(),
    call_count: z.number().int(),
  })
  .openapi("Lead");

export const CallSchema = z
  .object({
    id: z.string(),
    lead_id: z.string(),
    user_id: z.string().nullable(),
    from_number: z.string(),
    to_number: z.string(),
    twilio_call_sid: z.string().nullable(),
    mode: z.string(),
    direction: z.string(),
    status: z.string(),
    started_at: z.string().nullable(),
    ended_at: z.string().nullable(),
    duration_seconds: z.number().int().nullable(),
    record: z.number().int().openapi({ description: "1 when recording was requested for this call" }),
    recording_url: z.string().nullable().openapi({ description: "App route that streams the recording; null until Twilio delivers one" }),
    recording_duration: z.number().int().nullable().openapi({ description: "Seconds, once Twilio reports it" }),
    outcome: z.string().nullable(),
    notes: z.string(),
    error: z.string(),
    created_at: z.string(),
  })
  .openapi("Call");

/** Every lead read joins its latest call so list rows never need a second query. */
export const LEAD_SELECT = `
  l.*,
  (SELECT outcome FROM calls c WHERE c.lead_id = l.id AND c.outcome IS NOT NULL ORDER BY c.created_at DESC LIMIT 1) AS last_outcome,
  (SELECT created_at FROM calls c WHERE c.lead_id = l.id ORDER BY c.created_at DESC LIMIT 1) AS last_called_at,
  (SELECT COUNT(*) FROM calls c WHERE c.lead_id = l.id) AS call_count`;

export type LeadOut = LeadRow & { last_outcome: string | null; last_called_at: string | null; call_count: number };

export async function loadLead(id: string): Promise<LeadOut | undefined> {
  return get<LeadOut>(`SELECT ${LEAD_SELECT} FROM leads l WHERE l.id = ?`, [id]);
}

/** Never expose Twilio's media URL (it needs the auth token); point at our proxy. */
export function publicCall(row: CallRow) {
  const { recording_sid: _sid, parent_call_sid: _p, ...rest } = row;
  return { ...rest, recording_url: row.recording_url ? `/api/calls/${row.id}/recording` : null };
}

function paging(q: { page?: string; limit?: string }) {
  const page = Math.max(1, parseInt(q.page || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

const LeadInput = z.object({
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  phone: z.string().min(3).max(40).openapi({ description: "E.164, or national format together with `country`" }),
  country: z.string().length(2).optional().openapi({ description: "ISO alpha-2; required when phone is not E.164" }),
  timezone: z.string().max(64).optional(),
  notes: z.string().max(4000).optional(),
});

export function registerLeadRoutes(app: OpenAPIHono<Env>) {
  const listLeads = createRoute({
    method: "get",
    path: "/api/leads",
    tags: ["Leads"],
    summary: "List leads with search and pagination",
    request: {
      query: z.object({
        page: z.string().optional(),
        limit: z.string().optional().openapi({ description: "Max 100" }),
        search: z.string().optional().openapi({ description: "Matches name, company, phone" }),
        status: z.enum(LEAD_STATUSES).optional(),
        country: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Paginated leads",
        content: { "application/json": { schema: z.object({ leads: z.array(LeadSchema), total: z.number().int(), page: z.number().int(), limit: z.number().int() }) } },
      },
    },
  });

  app.openapi(listLeads, async (c) => {
    const q = c.req.valid("query");
    const { page, limit, offset } = paging(q);
    const where: string[] = [];
    const params: unknown[] = [];
    const search = (q.search || "").trim();
    if (search) {
      where.push("(l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ? OR l.phone LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (q.status) {
      where.push("l.status = ?");
      params.push(q.status);
    }
    if (q.country) {
      where.push("l.country = ?");
      params.push(q.country.toUpperCase());
    }
    const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = await get<{ total: number }>(`SELECT COUNT(*) AS total FROM leads l${sql}`, params);
    const leads = await query<LeadOut>(
      `SELECT ${LEAD_SELECT} FROM leads l${sql} ORDER BY l.created_at DESC, l.id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return c.json({ leads, total: total?.total || 0, page, limit }, 200);
  });

  const createLead = createRoute({
    method: "post",
    path: "/api/leads",
    tags: ["Leads"],
    summary: "Add one lead. The phone is normalised to E.164 or the request is rejected.",
    request: { body: { content: { "application/json": { schema: LeadInput } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: z.object({ lead: LeadSchema }) } } },
      400: { description: "Invalid phone", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(createLead, async (c) => {
    const body = c.req.valid("json");
    const phone = normalizePhone(body.phone, body.country);
    if (!phone.ok) return c.json({ error: phone.error }, 400);
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO leads (id, first_name, last_name, company, phone, country, timezone, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, body.first_name?.trim() || "", body.last_name?.trim() || "", body.company?.trim() || "", phone.e164, phone.country, body.timezone || null, body.notes || ""],
    );
    return c.json({ lead: (await loadLead(id))! }, 201);
  });

  const getLead = createRoute({
    method: "get",
    path: "/api/leads/{id}",
    tags: ["Leads"],
    summary: "One lead with its call history",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Lead", content: { "application/json": { schema: z.object({ lead: LeadSchema, calls: z.array(CallSchema) }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(getLead, async (c) => {
    const lead = await loadLead(c.req.valid("param").id);
    if (!lead) return c.json({ error: "Lead not found" }, 404);
    const calls = await query<CallRow>("SELECT * FROM calls WHERE lead_id = ? ORDER BY created_at DESC LIMIT 100", [lead.id]);
    return c.json({ lead, calls: calls.map(publicCall) }, 200);
  });

  const patchLead = createRoute({
    method: "patch",
    path: "/api/leads/{id}",
    tags: ["Leads"],
    summary: "Edit a lead",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: LeadInput.partial().extend({ status: z.enum(LEAD_STATUSES).optional() }) } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: z.object({ lead: LeadSchema }) } } },
      400: { description: "Invalid input", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(patchLead, async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const existing = await get<LeadRow>("SELECT * FROM leads WHERE id = ?", [id]);
    if (!existing) return c.json({ error: "Lead not found" }, 404);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (body.phone !== undefined) {
      const phone = normalizePhone(body.phone, body.country || existing.country);
      if (!phone.ok) return c.json({ error: phone.error }, 400);
      set("phone", phone.e164);
      set("country", phone.country);
    }
    for (const k of ["first_name", "last_name", "company", "notes", "status"] as const) {
      if (body[k] !== undefined) set(k, body[k]);
    }
    if (body.timezone !== undefined) set("timezone", body.timezone || null);
    if (sets.length === 0) return c.json({ error: "Nothing to update" }, 400);
    sets.push("updated_at = datetime('now')");
    await run(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
    return c.json({ lead: (await loadLead(id))! }, 200);
  });

  const deleteLead = createRoute({
    method: "delete",
    path: "/api/leads/{id}",
    tags: ["Leads"],
    summary: "Delete a lead and its call log",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(deleteLead, async (c) => {
    const id = c.req.valid("param").id;
    const res = await run("DELETE FROM leads WHERE id = ?", [id]);
    if (!res.changes) return c.json({ error: "Lead not found" }, 404);
    await run("DELETE FROM calls WHERE lead_id = ?", [id]);
    await run("DELETE FROM campaign_leads WHERE lead_id = ?", [id]);
    return c.json({ ok: true }, 200);
  });

  const importLeads = createRoute({
    method: "post",
    path: "/api/leads/import",
    tags: ["Leads"],
    summary: "Import leads from CSV text (first_name,last_name,company,phone,country,notes). Bad phones are skipped and counted.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              csv: z.string().min(1).max(2_000_000).openapi({ description: "Raw CSV with a header row. Phone may be national format if `country` is filled." }),
              default_country: z.string().length(2).optional().openapi({ description: "Used for rows with no country column" }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Import summary",
        content: {
          "application/json": {
            schema: z.object({
              imported: z.number().int(),
              rejected: z.number().int(),
              duplicates: z.number().int().openapi({ description: "Rows whose phone already existed; skipped" }),
              errors: z.array(z.object({ line: z.number().int(), error: z.string() })).openapi({ description: "First 50 rejections" }),
            }),
          },
        },
      },
      400: { description: "Missing phone column", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(importLeads, async (c) => {
    const body = c.req.valid("json");
    const { headers, rows } = parseCsv(body.csv);
    const col = (name: string) => headers.indexOf(name);
    const iPhone = col("phone");
    if (iPhone < 0) return c.json({ error: "CSV needs a phone column" }, 400);
    const iFirst = col("first_name"), iLast = col("last_name"), iCompany = col("company"), iCountry = col("country"), iNotes = col("notes");
    const cell = (r: string[], i: number) => (i >= 0 ? (r[i] || "").trim() : "");

    let imported = 0, rejected = 0, duplicates = 0;
    const errors: { line: number; error: string }[] = [];
    for (let n = 0; n < rows.length; n++) {
      const r = rows[n];
      const phone = normalizePhone(cell(r, iPhone), cell(r, iCountry) || body.default_country);
      if (!phone.ok) {
        rejected++;
        if (errors.length < 50) errors.push({ line: n + 2, error: phone.error });
        continue;
      }
      const dup = await get("SELECT id FROM leads WHERE phone = ?", [phone.e164]);
      if (dup) {
        duplicates++;
        continue;
      }
      await run(
        `INSERT INTO leads (id, first_name, last_name, company, phone, country, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), cell(r, iFirst), cell(r, iLast), cell(r, iCompany), phone.e164, phone.country, cell(r, iNotes)],
      );
      imported++;
    }
    return c.json({ imported, rejected, duplicates, errors }, 200);
  });

  const countries = createRoute({
    method: "get",
    path: "/api/countries",
    tags: ["Leads"],
    summary: "Supported countries (fixed reference set)",
    responses: { 200: { description: "Countries", content: { "application/json": { schema: z.object({ countries: z.array(z.string()) }) } } } },
  });
  app.openapi(countries, (c) => c.json({ countries: [...SUPPORTED_COUNTRIES] }, 200));
}
