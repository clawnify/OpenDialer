import { createRoute, z, type OpenAPIHono } from "@clawnify/app";
import { query, run } from "../db.js";
import { providerConfig } from "../config.js";
import { normalizePhone } from "../phone.js";
import { listIncomingNumbers, TwilioError } from "../twilio.js";
import { ErrorSchema } from "./leads.js";
import type { Env, NumberRow } from "../types.js";

const NumberSchema = z
  .object({
    id: z.string(),
    e164: z.string(),
    country: z.string(),
    area_code: z.string(),
    active: z.number().int().openapi({ description: "0 once the number is no longer in the Twilio account" }),
  })
  .openapi("Number");

export function registerNumberRoutes(app: OpenAPIHono<Env>) {
  const list = createRoute({
    method: "get",
    path: "/api/numbers",
    tags: ["Numbers"],
    summary: "Owned caller IDs (small fixed set, synced from Twilio)",
    responses: { 200: { description: "Numbers", content: { "application/json": { schema: z.object({ numbers: z.array(NumberSchema) }) } } } },
  });
  app.openapi(list, async (c) => {
    const numbers = await query<NumberRow>("SELECT id, e164, country, area_code, active FROM numbers ORDER BY active DESC, country, e164 LIMIT 500");
    return c.json({ numbers }, 200);
  });

  const sync = createRoute({
    method: "post",
    path: "/api/numbers/sync",
    tags: ["Numbers"],
    summary: "Pull the account's voice-capable incoming numbers into the app",
    responses: {
      200: { description: "Synced", content: { "application/json": { schema: z.object({ synced: z.number().int(), numbers: z.array(NumberSchema) }) } } },
      400: { description: "Provider not configured", content: { "application/json": { schema: ErrorSchema } } },
      502: { description: "Twilio error", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(sync, async (c) => {
    const cfg = providerConfig(c.env);
    if (!cfg.rest) return c.json({ error: "Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." }, 400);
    let owned;
    try {
      owned = await listIncomingNumbers(c.env);
    } catch (e) {
      if (e instanceof TwilioError) return c.json({ error: e.message }, 502);
      throw e;
    }
    const seen = new Set<string>();
    for (const n of owned) {
      const parsed = normalizePhone(n.phone_number);
      // Numbers outside the supported markets are kept but tagged with their raw country.
      const country = parsed.ok ? parsed.country : "";
      const area = parsed.ok ? parsed.areaCode : "";
      seen.add(n.phone_number);
      await run(
        `INSERT INTO numbers (id, e164, country, area_code, twilio_sid, active) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(e164) DO UPDATE SET country = excluded.country, area_code = excluded.area_code, twilio_sid = excluded.twilio_sid, active = 1`,
        [crypto.randomUUID(), n.phone_number, country, area, n.sid],
      );
    }
    // Released numbers stay as history but can no longer be dialled from.
    const existing = await query<{ e164: string }>("SELECT e164 FROM numbers WHERE active = 1");
    for (const row of existing) if (!seen.has(row.e164)) await run("UPDATE numbers SET active = 0 WHERE e164 = ?", [row.e164]);

    const numbers = await query<NumberRow>("SELECT id, e164, country, area_code, active FROM numbers ORDER BY active DESC, country, e164 LIMIT 500");
    return c.json({ synced: seen.size, numbers }, 200);
  });
}
