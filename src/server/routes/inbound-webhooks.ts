// Twilio → app, inbound side. Same rules as twilio-webhooks.ts: public routes
// (clawnify.json api.public_routes covers /api/twilio/*), and the signature
// middleware registered there runs first, so it must be registered before this.

import type { Context } from "hono";
import type { OpenAPIHono } from "@clawnify/app";
import { get, run } from "../db.js";
import { publicOrigin } from "../config.js";
import { isOpen, parseHours } from "../hours.js";
import { normalizePhone } from "../phone.js";
import { conferenceTwiml, gatherTwiml, hangupTwiml, sayTwiml, voicemailTwiml } from "../twilio.js";
import { afterClaim, availableReps, background, claimLeg, closeLegs, inboundUrls, markVoicemail, ringReps, settle, teamMemberIds } from "../inbound.js";
import { TERMINAL_CALL_STATUSES, type CallLegRow, type CallRow, type Env, type MenuOption, type NumberRow, type TeamRow } from "../types.js";

const TERMINAL = new Set<string>(TERMINAL_CALL_STATUSES);
const TWILIO_TERMINAL = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

const DEFAULT_VOICEMAIL = "Sorry, nobody can take your call right now. Please leave a message after the tone.";
const DEFAULT_CLOSED = "We are closed right now. Please leave a message after the tone and we will call you back.";

const xml = (body: string) => new Response(body, { headers: { "content-type": "text/xml" } });
const paramsOf = (c: Context<Env>) => (c.get("twilioParams" as never) as Record<string, string>) || {};

function parseMenu(raw: string): MenuOption[] {
  try {
    const m = JSON.parse(raw || "[]");
    return Array.isArray(m) ? m : [];
  } catch {
    return [];
  }
}

export function menuPrompt(number: Pick<NumberRow, "greeting">, menu: MenuOption[]): string {
  const options = menu.map((o) => `For ${o.label}, press ${o.digit}.`).join(" ");
  return [number.greeting, options].filter(Boolean).join(" ");
}

export function registerInboundWebhooks(app: OpenAPIHono<Env>) {
  /**
   * Ring a team for a call, or go straight to voicemail when nobody in it can
   * take a call. Returns the caller's TwiML.
   */
  async function routeToTeam(c: Context<Env>, call: CallRow, number: NumberRow, teamId: string | null, prefix = ""): Promise<Response> {
    const origin = publicOrigin(c.env, c.req.url);
    const urls = inboundUrls(origin, call.id);
    const team = teamId ? await get<TeamRow>("SELECT * FROM teams WHERE id = ?", [teamId]) : undefined;
    const reps = team ? await availableReps(await teamMemberIds(team.id)) : [];
    if (team) await run("UPDATE calls SET team_id = ? WHERE id = ?", [team.id, call.id]);
    if (!team || reps.length === 0) {
      await markVoicemail(call.id);
      return xml(voicemailTwiml({ greeting: number.voicemail_greeting || DEFAULT_VOICEMAIL, doneUrl: urls.voicemailDone, recordingUrl: urls.voicemailRecording }));
    }
    background(c, ringReps(c.env, origin, call, reps, { kind: "ring", timeoutSeconds: team.ring_seconds }));
    return xml(conferenceTwiml({ name: call.id, role: "caller", record: call.record === 1, recordingUrl: urls.recording, label: "caller" }, prefix));
  }

  // The number's voice URL. One row per inbound call, keyed by Twilio's CallSid
  // so a retried webhook does not create a second.
  app.post("/api/twilio/inbound", async (c) => {
    const p = paramsOf(c);
    const number = await get<NumberRow>("SELECT * FROM numbers WHERE e164 = ? AND active = 1", [p.To || ""]);
    if (!number || !number.connected || number.route === "off") return xml(hangupTwiml("This number is not taking calls."));

    let call = p.CallSid ? await get<CallRow>("SELECT * FROM calls WHERE twilio_call_sid = ? AND direction = 'inbound'", [p.CallSid]) : undefined;
    if (call) {
      // Twilio asking again for a call already routed: give the same answer, never ring twice.
      const urls = inboundUrls(publicOrigin(c.env, c.req.url), call.id);
      if (TERMINAL.has(call.status) && call.status !== "voicemail") return xml(hangupTwiml());
      if (call.status === "voicemail") {
        return xml(voicemailTwiml({ greeting: number.voicemail_greeting || DEFAULT_VOICEMAIL, doneUrl: urls.voicemailDone, recordingUrl: urls.voicemailRecording }));
      }
      const open = await get<{ n: number }>("SELECT COUNT(*) AS n FROM call_legs WHERE call_id = ?", [call.id]);
      if ((open?.n || 0) > 0) return xml(conferenceTwiml({ name: call.id, role: "caller", record: call.record === 1, recordingUrl: urls.recording, label: "caller" }));
    } else {
      const phone = normalizePhone(p.From || "");
      const fromNumber = phone.ok ? phone.e164 : p.From || "";
      const lead = fromNumber ? await get<{ id: string }>("SELECT id FROM leads WHERE phone = ? ORDER BY created_at LIMIT 1", [fromNumber]) : undefined;
      const id = crypto.randomUUID();
      await run(
        `INSERT INTO calls (id, lead_id, from_number, to_number, twilio_call_sid, mode, direction, status, number_id, record)
         VALUES (?, ?, ?, ?, ?, 'conference', 'inbound', 'ringing', ?, ?)`,
        [id, lead?.id || null, fromNumber, number.e164, p.CallSid || null, number.id, number.record_inbound],
      );
      call = (await get<CallRow>("SELECT * FROM calls WHERE id = ?", [id]))!;
    }

    const urls = inboundUrls(publicOrigin(c.env, c.req.url), call.id);
    const hours = parseHours(number.hours);
    if (hours.ok && !isOpen(hours.hours)) {
      await markVoicemail(call.id);
      return xml(voicemailTwiml({ greeting: number.closed_message || DEFAULT_CLOSED, doneUrl: urls.voicemailDone, recordingUrl: urls.voicemailRecording }));
    }

    if (number.route === "menu") {
      const menu = parseMenu(number.menu);
      if (menu.length) return xml(gatherTwiml({ prompt: menuPrompt(number, menu), actionUrl: urls.menu(1), noInputUrl: urls.menuNoInput }));
    }
    const greeting = number.greeting ? sayTwiml(number.greeting) : "";
    return routeToTeam(c, call, number, number.team_id, greeting);
  });

  // A digit was pressed (or nothing was, `none=1`).
  app.post("/api/twilio/menu", async (c) => {
    const p = paramsOf(c);
    const call = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [c.req.query("call") || ""]);
    if (!call || TERMINAL.has(call.status)) return xml(hangupTwiml());
    const number = call.number_id ? await get<NumberRow>("SELECT * FROM numbers WHERE id = ?", [call.number_id]) : undefined;
    if (!number) return xml(hangupTwiml("This number is not taking calls."));
    const urls = inboundUrls(publicOrigin(c.env, c.req.url), call.id);
    const menu = parseMenu(number.menu);
    const option = menu.find((o) => o.digit === (p.Digits || "").trim());
    if (option) return routeToTeam(c, call, number, option.team_id);

    const attempt = parseInt(c.req.query("try") || "1", 10) || 1;
    if (c.req.query("none") || attempt >= 2) {
      await markVoicemail(call.id);
      return xml(voicemailTwiml({ greeting: number.voicemail_greeting || DEFAULT_VOICEMAIL, doneUrl: urls.voicemailDone, recordingUrl: urls.voicemailRecording }));
    }
    return xml(gatherTwiml({ prompt: `Sorry, that is not an option. ${menuPrompt({ greeting: "" }, menu)}`, actionUrl: urls.menu(attempt + 1), noInputUrl: urls.menuNoInput }));
  });

  // Where `settle` redirects an unanswered caller.
  app.post("/api/twilio/voicemail", async (c) => {
    const call = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [c.req.query("call") || ""]);
    if (!call) return xml(hangupTwiml());
    const number = call.number_id ? await get<NumberRow>("SELECT voicemail_greeting, closed_message FROM numbers WHERE id = ?", [call.number_id]) : undefined;
    const urls = inboundUrls(publicOrigin(c.env, c.req.url), call.id);
    const greeting = c.req.query("closed") ? number?.closed_message || DEFAULT_CLOSED : number?.voicemail_greeting || DEFAULT_VOICEMAIL;
    return xml(voicemailTwiml({ greeting, doneUrl: urls.voicemailDone, recordingUrl: urls.voicemailRecording }));
  });

  app.post("/api/twilio/voicemail-done", () => xml(hangupTwiml("Thank you. Goodbye.")));

  // A rep answered their browser. Claim the call or step aside.
  app.post("/api/twilio/agent", async (c) => {
    const p = paramsOf(c);
    const leg = await get<CallLegRow>("SELECT * FROM call_legs WHERE id = ? AND call_id = ?", [c.req.query("leg") || "", c.req.query("call") || ""]);
    const call = leg ? await get<CallRow>("SELECT * FROM calls WHERE id = ?", [leg.call_id]) : undefined;
    if (!leg || !call || TERMINAL.has(call.status)) return xml(hangupTwiml("This call has ended."));
    if (!(await claimLeg(c.env, leg, p.CallSid))) return xml(hangupTwiml("A teammate already took this call."));
    // The caller may have hung up between the read above and the claim.
    const live = await get<{ status: string }>("SELECT status FROM calls WHERE id = ?", [call.id]);
    if (!live || TERMINAL.has(live.status)) {
      await run("UPDATE call_legs SET status = 'left', updated_at = datetime('now') WHERE id = ?", [leg.id]);
      return xml(hangupTwiml("This call has ended."));
    }
    background(c, afterClaim(c.env, leg));
    const urls = inboundUrls(publicOrigin(c.env, c.req.url), call.id);
    return xml(conferenceTwiml({ name: call.id, role: "rep", record: call.record === 1, recordingUrl: urls.recording, label: `rep-${leg.id}` }));
  });

  // A rep leg changed state. Only its end matters.
  app.post("/api/twilio/leg", async (c) => {
    const p = paramsOf(c);
    if (!TWILIO_TERMINAL.has(p.CallStatus || "")) return c.body(null, 204);
    const leg = await get<CallLegRow>("SELECT * FROM call_legs WHERE id = ? AND call_id = ?", [c.req.query("leg") || "", c.req.query("call") || ""]);
    if (!leg || (leg.status !== "ringing" && leg.status !== "joined")) return c.body(null, 204);
    const cause = leg.status === "ringing" ? "missed" : "left";
    await run("UPDATE call_legs SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?", [cause, leg.id, leg.status]);
    await settle(c.env, publicOrigin(c.env, c.req.url), leg.call_id, cause);
    return c.body(null, 204);
  });

  // The caller's own call (the number's status callback). Its end closes the row.
  app.post("/api/twilio/inbound-status", async (c) => {
    const p = paramsOf(c);
    if (!TWILIO_TERMINAL.has(p.CallStatus || "") || !p.CallSid) return c.body(null, 204);
    const call = await get<CallRow>("SELECT * FROM calls WHERE twilio_call_sid = ? AND direction = 'inbound'", [p.CallSid]);
    if (!call) return c.body(null, 204);
    // Every write is guarded on the status read here: a claim or a voicemail
    // arriving in between must win over this callback's stale view.
    const duration = "CASE WHEN started_at IS NULL THEN NULL ELSE CAST(ROUND((julianday('now') - julianday(started_at)) * 86400) AS INTEGER) END";
    if (call.status === "in-progress") {
      await run(`UPDATE calls SET status = 'completed', ended_at = COALESCE(ended_at, datetime('now')), duration_seconds = ${duration} WHERE id = ? AND status = 'in-progress'`, [call.id]);
    } else if (call.status === "ringing") {
      await run("UPDATE calls SET status = 'missed', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ? AND status = 'ringing'", [call.id]);
    } else if (call.status === "voicemail") {
      // Hung up at the greeting: missed, unless the message is already in. A
      // message still being processed flips it back to voicemail when it lands.
      await run(
        `UPDATE calls SET status = CASE WHEN voicemail_url IS NULL THEN 'missed' ELSE 'voicemail' END,
           ended_at = COALESCE(ended_at, datetime('now')), duration_seconds = COALESCE(duration_seconds, ${duration})
         WHERE id = ? AND status = 'voicemail'`,
        [call.id],
      );
    } else {
      await run("UPDATE calls SET ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?", [call.id]);
    }
    await closeLegs(c.env, call.id);
    return c.body(null, 204);
  });
}
