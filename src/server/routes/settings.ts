import { createRoute, z, user, type OpenAPIHono } from "@clawnify/app";
import { get, run } from "../db.js";
import { providerConfig, publicOrigin } from "../config.js";
import { normalizePhone } from "../phone.js";
import { ErrorSchema } from "./leads.js";
import type { Env } from "../types.js";

const SettingsSchema = z
  .object({
    provider: z.literal("twilio"),
    configured: z.boolean().openapi({ description: "Account SID, auth token and default number all present" }),
    voice_sdk_enabled: z.boolean().openapi({ description: "Browser calling available; otherwise calls fall back to ringing the rep's phone" }),
    missing: z.array(z.string()).openapi({ description: "Required env vars that are not set" }),
    default_from_number: z.string(),
    public_url: z.string(),
    webhooks: z.object({ voice: z.string(), status: z.string(), recording: z.string() }),
    user: z.object({ id: z.string(), name: z.string() }).nullable(),
    callback_number: z.string().openapi({ description: "This rep's phone for the fallback mode" }),
    preferred_from_number: z.string().openapi({ description: "This rep's preferred caller ID; empty = local presence picks" }),
  })
  .openapi("Settings");

export function userKey(c: { req: { header: (n: string) => string | undefined } }): string {
  // Off-platform (local dev) there is no identity header; one shared rep.
  return user(c)?.id || "local";
}

export function registerSettingsRoutes(app: OpenAPIHono<Env>) {
  const health = createRoute({
    method: "get",
    path: "/api/health",
    tags: ["System"],
    summary: "Liveness plus whether the telephony provider is configured",
    responses: { 200: { description: "Health", content: { "application/json": { schema: z.object({ ok: z.boolean(), provider: z.string(), configured: z.boolean(), voice_sdk_enabled: z.boolean() }) } } } },
  });
  app.openapi(health, (c) => {
    const cfg = providerConfig(c.env);
    return c.json({ ok: true, provider: cfg.provider, configured: cfg.rest && cfg.missing.length === 0, voice_sdk_enabled: cfg.voiceSdk }, 200);
  });

  const getSettings = createRoute({
    method: "get",
    path: "/api/settings",
    tags: ["System"],
    summary: "Provider status and this rep's preferences. Never returns secrets.",
    responses: { 200: { description: "Settings", content: { "application/json": { schema: SettingsSchema } } } },
  });
  app.openapi(getSettings, async (c) => {
    const cfg = providerConfig(c.env);
    const origin = publicOrigin(c.env, c.req.url);
    const u = user(c);
    const prefs = await get<{ callback_number: string; default_from_number: string }>("SELECT callback_number, default_from_number FROM user_settings WHERE user_id = ?", [userKey(c)]);
    return c.json(
      {
        provider: cfg.provider,
        configured: cfg.rest && cfg.missing.length === 0,
        voice_sdk_enabled: cfg.voiceSdk,
        missing: cfg.missing,
        default_from_number: cfg.fromNumber,
        public_url: origin,
        webhooks: { voice: `${origin}/api/twilio/voice`, status: `${origin}/api/twilio/status`, recording: `${origin}/api/twilio/recording` },
        user: u ? { id: u.id, name: u.name || u.email || "" } : null,
        callback_number: prefs?.callback_number || "",
        preferred_from_number: prefs?.default_from_number || "",
      },
      200,
    );
  });

  const putSettings = createRoute({
    method: "put",
    path: "/api/settings",
    tags: ["System"],
    summary: "Save this rep's callback number and preferred caller ID",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              callback_number: z.string().max(40).optional().openapi({ description: "E.164; empty to clear" }),
              preferred_from_number: z.string().max(40).optional().openapi({ description: "E.164 of an owned number; empty for automatic" }),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: z.object({ callback_number: z.string(), preferred_from_number: z.string() }) } } },
      400: { description: "Invalid number", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(putSettings, async (c) => {
    const body = c.req.valid("json");
    const key = userKey(c);
    const current = await get<{ callback_number: string; default_from_number: string }>("SELECT callback_number, default_from_number FROM user_settings WHERE user_id = ?", [key]);
    let callback = current?.callback_number || "";
    let preferred = current?.default_from_number || "";
    if (body.callback_number !== undefined) {
      if (body.callback_number.trim() === "") callback = "";
      else {
        const p = normalizePhone(body.callback_number);
        if (!p.ok) return c.json({ error: `Callback number: ${p.error}` }, 400);
        callback = p.e164;
      }
    }
    if (body.preferred_from_number !== undefined) {
      if (body.preferred_from_number.trim() === "") preferred = "";
      else {
        const owned = await get("SELECT id FROM numbers WHERE e164 = ? AND active = 1", [body.preferred_from_number.trim()]);
        if (!owned) return c.json({ error: "Pick a number the account owns (sync numbers first)" }, 400);
        preferred = body.preferred_from_number.trim();
      }
    }
    await run(
      `INSERT INTO user_settings (user_id, callback_number, default_from_number, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET callback_number = excluded.callback_number, default_from_number = excluded.default_from_number, updated_at = excluded.updated_at`,
      [key, callback, preferred],
    );
    return c.json({ callback_number: callback, preferred_from_number: preferred }, 200);
  });
}
