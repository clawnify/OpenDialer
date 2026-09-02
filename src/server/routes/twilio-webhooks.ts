// Twilio → app. Declared public in clawnify.json (api.public_routes), so the
// signature check below is the only thing standing between the internet and
// these handlers. They are plain Hono routes, kept off the OpenAPI surface:
// nothing but Twilio should ever call them.

import type { OpenAPIHono } from "@clawnify/app";
import { get, run } from "../db.js";
import { publicOrigin } from "../config.js";
import { dialTwiml, rejectTwiml, verifySignature } from "../twilio.js";
import { callbackUrls } from "./calls.js";
import { ACTIVE_CALL_STATUSES, type CallRow, type Env } from "../types.js";

const TERMINAL = new Set(["completed", "failed", "no-answer", "busy", "canceled"]);

/** Twilio's CallStatus vocabulary → ours. */
function mapStatus(s: string): string {
  if (s === "queued" || s === "initiated") return "initiated";
  if (s === "answered") return "in-progress";
  return s;
}

const xml = (body: string) => new Response(body, { headers: { "content-type": "text/xml" } });

export function registerTwilioWebhooks(app: OpenAPIHono<Env>) {
  // Signature check + form parse, shared by all three.
  app.use("/api/twilio/*", async (c, next) => {
    const raw = await c.req.text();
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    const token = c.env.TWILIO_AUTH_TOKEN;
    if (token) {
      // Verify against the URL Twilio was told to call, which may differ from
      // the URL this worker sees behind the platform edge.
      const u = new URL(c.req.url);
      const signedUrl = `${publicOrigin(c.env, c.req.url)}${u.pathname}${u.search}`;
      const ok = await verifySignature(token, signedUrl, params, c.req.header("X-Twilio-Signature"));
      if (!ok) return c.text("Invalid signature", 403);
    }
    c.set("twilioParams" as never, params as never);
    await next();
  });

  const paramsOf = (c: { get: (k: never) => unknown }) => (c.get("twilioParams" as never) as Record<string, string>) || {};

  // TwiML for a browser-originated call. The SDK posts the custom params from
  // Device.connect({ params }) alongside CallSid and From (client:<identity>).
  app.post("/api/twilio/voice", async (c) => {
    const p = paramsOf(c);
    const call = p.callId ? await get<CallRow>("SELECT * FROM calls WHERE id = ?", [p.callId]) : undefined;
    if (!call || call.mode !== "browser") return xml(rejectTwiml("This call is not valid."));
    if (!(ACTIVE_CALL_STATUSES as readonly string[]).includes(call.status)) return xml(rejectTwiml("This call has already ended."));
    if (p.CallSid) await run("UPDATE calls SET parent_call_sid = ? WHERE id = ?", [p.CallSid, call.id]);
    const urls = callbackUrls(publicOrigin(c.env, c.req.url), call.id);
    return xml(
      dialTwiml({
        to: call.to_number,
        callerId: call.from_number,
        actionUrl: urls.dialAction,
        numberStatusUrl: urls.numberStatus,
        recordingUrl: urls.recording,
        record: true,
      }),
    );
  });

  // Status updates. `leg` says which Twilio leg is talking:
  //   number — the PSTN leg (the lead): the source of truth for status/duration
  //   dial   — <Dial> finished (action URL): final DialCallStatus + duration
  //   parent — API mode only: the rep's own phone
  app.post("/api/twilio/status", async (c) => {
    const p = paramsOf(c);
    const id = c.req.query("call") || "";
    const leg = c.req.query("leg") || "number";
    const call = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]);
    if (!call) return leg === "dial" ? xml("<Response><Hangup/></Response>") : c.body(null, 204);

    if (leg === "number") {
      const status = mapStatus(p.CallStatus || "");
      const sets: string[] = [];
      const args: unknown[] = [];
      if (p.CallSid) {
        sets.push("twilio_call_sid = ?");
        args.push(p.CallSid);
      }
      if (status === "in-progress") sets.push("started_at = COALESCE(started_at, datetime('now'))");
      if (TERMINAL.has(status)) {
        sets.push("ended_at = COALESCE(ended_at, datetime('now'))");
        if (p.CallDuration) {
          sets.push("duration_seconds = ?");
          args.push(parseInt(p.CallDuration, 10) || 0);
        }
      }
      // Callbacks can arrive out of order: never let a live status overwrite a final one.
      if (status && !(TERMINAL.has(call.status) && !TERMINAL.has(status))) {
        sets.push("status = ?");
        args.push(status);
      }
      if (sets.length) await run(`UPDATE calls SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
      if (TERMINAL.has(status)) await run("UPDATE leads SET status = 'called', updated_at = datetime('now') WHERE id = ? AND status = 'calling'", [call.lead_id]);
      return c.body(null, 204);
    }

    if (leg === "dial") {
      const status = mapStatus(p.DialCallStatus || "completed");
      const duration = p.DialCallDuration ? parseInt(p.DialCallDuration, 10) || 0 : null;
      if (!TERMINAL.has(call.status) || call.status === "completed") {
        await run(
          `UPDATE calls SET status = ?, ended_at = COALESCE(ended_at, datetime('now')), duration_seconds = COALESCE(?, duration_seconds), twilio_call_sid = COALESCE(twilio_call_sid, ?) WHERE id = ?`,
          [TERMINAL.has(status) ? status : "completed", duration, p.DialCallSid || null, id],
        );
      }
      await run("UPDATE leads SET status = 'called', updated_at = datetime('now') WHERE id = ? AND status = 'calling'", [call.lead_id]);
      // The bridge is over; end the parent leg (browser or the rep's phone).
      return xml("<Response><Hangup/></Response>");
    }

    // parent (API mode): the rep's phone. Only failures before the bridge matter.
    const status = mapStatus(p.CallStatus || "");
    if (["failed", "busy", "no-answer", "canceled"].includes(status) && !TERMINAL.has(call.status)) {
      await run("UPDATE calls SET status = 'failed', error = ?, ended_at = datetime('now') WHERE id = ?", ["Your phone did not answer, so the lead was not called.", id]);
      await run("UPDATE leads SET status = 'called', updated_at = datetime('now') WHERE id = ? AND status = 'calling'", [call.lead_id]);
    } else if (status === "completed" && !TERMINAL.has(call.status)) {
      await run("UPDATE calls SET status = 'completed', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?", [id]);
      await run("UPDATE leads SET status = 'called', updated_at = datetime('now') WHERE id = ? AND status = 'calling'", [call.lead_id]);
    }
    return c.body(null, 204);
  });

  // Recording ready. Only the URL is stored; audio stays at Twilio and is
  // streamed through GET /api/calls/:id/recording with the server's auth.
  app.post("/api/twilio/recording", async (c) => {
    const p = paramsOf(c);
    const id = c.req.query("call") || "";
    if (p.RecordingStatus && p.RecordingStatus !== "completed") return c.body(null, 204);
    if (id && p.RecordingUrl) {
      await run("UPDATE calls SET recording_url = ?, recording_sid = ? WHERE id = ?", [p.RecordingUrl, p.RecordingSid || null, id]);
    }
    return c.body(null, 204);
  });
}
