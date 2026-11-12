// Inbound calls: who rings, who gets the call, and what happens when nobody
// takes it.
//
// The caller waits in a Twilio conference named after the call id (hold music
// until a rep joins). Every rep phone rung for the call is a `call_legs` row
// and a REST-created call to `client:<user id>`, the rep's browser. Twilio
// fetches the leg's TwiML when the rep answers; that handler claims the call
// (first answer wins) and joins the conference. Because the caller sits in a
// conference rather than a direct bridge, a transfer is just another leg
// joining, and the first rep can stay (warm) or be dropped (blind).
//
// `settle` is the one place that decides what a call does once no rep is
// ringing or on the line: voicemail if nobody answered (or a transfer found
// nobody), hang up if the last rep simply left.

import { get, query, run } from "./db.js";
import { createCall, endCall, redirectCall, TwilioError } from "./twilio.js";
import { TERMINAL_CALL_STATUSES, type Bindings, type CallLegRow, type CallRow } from "./types.js";

const TERMINAL = new Set<string>(TERMINAL_CALL_STATUSES);

/** A rep counts as online for this long after their last heartbeat. */
export const ONLINE_WINDOW = "-90 seconds";
/**
 * A leg older than this that is still "ringing" or "joined" is assumed to be a
 * lost Twilio callback: it no longer makes its rep busy, and the sweep closes it.
 */
export const STALE_CALL = "-4 hours";

/** Work a webhook's caller need not wait for: run it after the response is sent. */
export function background(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, work: Promise<unknown>) {
  const logged = work.catch((e) => console.error("inbound background", e));
  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    /* no execution context (tests): the promise still runs */
  }
}

export function inboundUrls(origin: string, callId: string) {
  const q = `?call=${encodeURIComponent(callId)}`;
  return {
    menu: (attempt: number) => `${origin}/api/twilio/menu${q}&try=${attempt}`,
    menuNoInput: `${origin}/api/twilio/menu${q}&none=1`,
    voicemail: (closed: boolean) => `${origin}/api/twilio/voicemail${q}${closed ? "&closed=1" : ""}`,
    voicemailDone: `${origin}/api/twilio/voicemail-done${q}`,
    recording: `${origin}/api/twilio/recording${q}`,
    voicemailRecording: `${origin}/api/twilio/recording${q}&kind=voicemail`,
    agent: (legId: string) => `${origin}/api/twilio/agent${q}&leg=${encodeURIComponent(legId)}`,
    legStatus: (legId: string) => `${origin}/api/twilio/leg${q}&leg=${encodeURIComponent(legId)}`,
  };
}

/** Number webhooks: set on the Twilio number by POST /api/numbers/{id}/connect. */
export function numberWebhookUrls(origin: string) {
  return { voice: `${origin}/api/twilio/inbound`, status: `${origin}/api/twilio/inbound-status` };
}

/**
 * Reps who can take a call now: available, the app open in the last 90 s, and
 * not already ringing for or talking on another call. `candidates` narrows to
 * a team's members or one named rep.
 */
export async function availableReps(candidates: string[], exclude: string[] = []): Promise<string[]> {
  const ids = candidates.filter((id) => !exclude.includes(id)).slice(0, 50);
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = await query<{ user_id: string }>(
    `SELECT u.user_id FROM user_settings u
     WHERE u.user_id IN (${marks})
       AND u.available = 1
       AND u.last_seen_at > datetime('now', '${ONLINE_WINDOW}')
       AND NOT EXISTS (
         SELECT 1 FROM call_legs l JOIN calls c ON c.id = l.call_id
         WHERE l.user_id = u.user_id AND l.status IN ('ringing', 'joined') AND c.status IN ('ringing', 'in-progress')
           AND l.updated_at > datetime('now', '${STALE_CALL}'))
       AND NOT EXISTS (
         SELECT 1 FROM calls c
         WHERE c.user_id = u.user_id AND c.direction = 'outbound' AND c.status IN ('initiated', 'ringing', 'in-progress')
           AND c.created_at > datetime('now', '-2 hours'))
     ORDER BY u.last_seen_at DESC
     LIMIT 10`,
    ids,
  );
  // Capped at 10: every leg is a billed Twilio call, and more is a crowd, not a ring group.
  return rows.map((r) => r.user_id);
}

export async function teamMemberIds(teamId: string): Promise<string[]> {
  return (await query<{ user_id: string }>("SELECT user_id FROM team_members WHERE team_id = ?", [teamId])).map((r) => r.user_id);
}

/**
 * Ring reps' browsers for a call. Legs are written first so a fast failure
 * can settle against them; the REST calls are placed after.
 */
export async function ringReps(
  env: Bindings,
  origin: string,
  call: Pick<CallRow, "id" | "from_number" | "to_number">,
  userIds: string[],
  opts: { kind: "ring" | "transfer"; timeoutSeconds: number; replacesLegId?: string | null },
): Promise<CallLegRow[]> {
  const legs: CallLegRow[] = [];
  for (const userId of userIds) {
    const id = crypto.randomUUID();
    await run("INSERT INTO call_legs (id, call_id, user_id, kind, replaces_leg_id, status) VALUES (?, ?, ?, ?, ?, 'ringing')", [
      id,
      call.id,
      userId,
      opts.kind,
      opts.replacesLegId || null,
    ]);
    legs.push((await get<CallLegRow>("SELECT * FROM call_legs WHERE id = ?", [id]))!);
  }
  const urls = inboundUrls(origin, call.id);
  // The browser shows `From` before it has looked the call up; a withheld or
  // odd caller ID falls back to the number that was dialled.
  const from = /^\+\d{6,15}$/.test(call.from_number) ? call.from_number : call.to_number;
  await Promise.all(
    legs.map(async (leg) => {
      try {
        const created = await createCall(env, {
          to: `client:${leg.user_id}`,
          from,
          url: urls.agent(leg.id),
          statusCallback: urls.legStatus(leg.id),
          timeoutSeconds: opts.timeoutSeconds,
        });
        await run("UPDATE call_legs SET twilio_call_sid = ?, updated_at = datetime('now') WHERE id = ?", [created.sid, leg.id]);
        leg.twilio_call_sid = created.sid;
        // The caller hung up (or another rep answered) while this call was being
        // placed: the leg was closed before it had a SID to cancel, so cancel it now.
        const now = await get<{ status: string }>("SELECT status FROM call_legs WHERE id = ?", [leg.id]);
        if (now && now.status !== "ringing") {
          leg.status = now.status as CallLegRow["status"];
          await endCall(env, created.sid, "canceled").catch(() => {});
        }
      } catch (e) {
        console.error("ring leg failed", leg.id, e instanceof TwilioError ? e.message : e);
        await run("UPDATE call_legs SET status = 'missed', updated_at = datetime('now') WHERE id = ? AND status = 'ringing'", [leg.id]);
        leg.status = "missed";
      }
    }),
  );
  if (legs.every((l) => l.status === "missed")) await settle(env, origin, call.id, "missed");
  return legs;
}

/**
 * First answer wins. Returns false when another rep already has the call (or
 * the caller is gone), in which case the leg is closed and the rep told so.
 */
export async function claimLeg(env: Bindings, leg: CallLegRow, callSid: string | undefined): Promise<boolean> {
  // Twilio fetching the answer URL again for the same answered leg: still theirs.
  if (leg.status === "joined" && callSid && leg.twilio_call_sid === callSid) return true;
  if (leg.status !== "ringing") return false;
  if (leg.kind === "ring") {
    const r = await run(
      "UPDATE calls SET user_id = ?, status = 'in-progress', started_at = COALESCE(started_at, datetime('now')) WHERE id = ? AND user_id IS NULL AND status = 'ringing'",
      [leg.user_id, leg.call_id],
    );
    if (r.changes === 0) {
      await run("UPDATE call_legs SET status = 'missed', updated_at = datetime('now') WHERE id = ?", [leg.id]);
      return false;
    }
    await run("UPDATE call_legs SET status = 'joined', twilio_call_sid = COALESCE(twilio_call_sid, ?), updated_at = datetime('now') WHERE id = ?", [callSid || null, leg.id]);
    return true;
  }
  // A transfer to a team rings several reps; the first to answer takes it. One
  // statement, so two answers at the same instant cannot both pass: no transfer
  // leg of this batch (created at or after this one; a new transfer cannot start
  // while one is ringing) may already be joined.
  const r = await run(
    `UPDATE call_legs SET status = 'joined', twilio_call_sid = COALESCE(twilio_call_sid, ?), updated_at = datetime('now')
     WHERE id = ? AND status = 'ringing'
       AND EXISTS (SELECT 1 FROM calls WHERE id = ? AND status = 'in-progress')
       AND NOT EXISTS (
         SELECT 1 FROM call_legs o
         WHERE o.call_id = ? AND o.id != ? AND o.kind = 'transfer' AND o.status IN ('joined', 'left') AND o.created_at >= ?)`,
    [callSid || null, leg.id, leg.call_id, leg.call_id, leg.id, leg.created_at],
  );
  if (r.changes === 0) {
    await run("UPDATE call_legs SET status = 'missed', updated_at = datetime('now') WHERE id = ? AND status = 'ringing'", [leg.id]);
    return false;
  }
  // The new rep becomes the call's owner.
  await run("UPDATE calls SET user_id = ? WHERE id = ?", [leg.user_id, leg.call_id]);
  return true;
}

/** After a claim: stop the other phones ringing, and drop the transferring rep on a blind transfer. */
export async function afterClaim(env: Bindings, leg: CallLegRow): Promise<void> {
  const others = await query<CallLegRow>("SELECT * FROM call_legs WHERE call_id = ? AND id != ? AND status = 'ringing' AND kind = ?", [leg.call_id, leg.id, leg.kind]);
  await Promise.all(others.map((o) => stopLeg(env, o, "canceled")));
  if (leg.replaces_leg_id) {
    const old = await get<CallLegRow>("SELECT * FROM call_legs WHERE id = ? AND status = 'joined'", [leg.replaces_leg_id]);
    if (old) await stopLeg(env, old, "completed");
  }
}

async function stopLeg(env: Bindings, leg: CallLegRow, how: "canceled" | "completed"): Promise<void> {
  await run("UPDATE call_legs SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?", [
    how === "canceled" ? "missed" : "left",
    leg.id,
    how === "canceled" ? "ringing" : "joined",
  ]);
  if (!leg.twilio_call_sid) return;
  try {
    await endCall(env, leg.twilio_call_sid, how);
  } catch (e) {
    // 404 / already ended: the leg is gone either way.
    if (!(e instanceof TwilioError)) throw e;
  }
}

/**
 * The caller hung up: stop every rep phone still ringing, and take reps off a
 * conference that is over (one who joined in the last instant would otherwise
 * sit in a fresh, empty conference of the same name).
 */
export async function closeLegs(env: Bindings, callId: string): Promise<void> {
  const open = await query<CallLegRow>("SELECT * FROM call_legs WHERE call_id = ? AND status IN ('ringing', 'joined')", [callId]);
  await Promise.all(open.map((l) => stopLeg(env, l, l.status === "ringing" ? "canceled" : "completed")));
}

/**
 * Move an unanswered caller to voicemail. Guarded so two legs failing at the
 * same moment send the caller there once, not twice (which would restart the
 * greeting). Returns whether this call did the move.
 */
export async function markVoicemail(callId: string): Promise<boolean> {
  const r = await run("UPDATE calls SET status = 'voicemail' WHERE id = ? AND status IN ('ringing', 'in-progress')", [callId]);
  return r.changes > 0;
}

/**
 * Called whenever a leg ends. With nobody ringing and nobody on the line:
 * - `missed` (the last phone rang out): voicemail, also after a transfer nobody took
 * - `left` (the last rep hung up): end the caller's call
 */
export async function settle(env: Bindings, origin: string, callId: string, cause: "missed" | "left"): Promise<void> {
  const call = await get<CallRow>("SELECT * FROM calls WHERE id = ?", [callId]);
  if (!call || TERMINAL.has(call.status) || !call.twilio_call_sid) return;
  const open = await get<{ n: number }>("SELECT COUNT(*) AS n FROM call_legs WHERE call_id = ? AND status IN ('ringing', 'joined')", [callId]);
  if ((open?.n || 0) > 0) return;
  if (cause === "missed" || !call.user_id) {
    if (!(await markVoicemail(callId))) return;
    try {
      await withRetry(() => redirectCall(env, call.twilio_call_sid!, inboundUrls(origin, callId).voicemail(false)));
    } catch (e) {
      if (callerGone(e)) return;
      // Put the status back so the sweep (or the next leg event) tries again,
      // rather than leaving the caller on hold under a status that says voicemail.
      await run("UPDATE calls SET status = ? WHERE id = ? AND status = 'voicemail'", [call.status, callId]);
      throw e;
    }
  } else {
    try {
      await withRetry(() => endCall(env, call.twilio_call_sid!, "completed"));
    } catch (e) {
      if (!callerGone(e)) throw e;
    }
  }
}

/** Twilio says the caller's call no longer exists or is no longer live: nothing to do. */
function callerGone(e: unknown): boolean {
  // 404: unknown call. 21220: "Call is not in-progress. Cannot redirect."
  return e instanceof TwilioError && (e.status === 404 || e.code === 21220);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // One retry for Twilio's rate limit or a 5xx; anything else is final.
    if (!(e instanceof TwilioError) || callerGone(e) || (e.status !== 429 && e.status < 500)) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return fn();
  }
}

/**
 * Close what lost Twilio callbacks left open. Every exit from the hold depends
 * on a callback arriving, so this runs on each rep heartbeat (every 30 s while
 * anyone has the app open).
 * shortcut: heartbeat-driven, not a cron; with nobody online no rep can be rung
 * either, so a stuck caller needs a cron only once the app has one.
 */
export async function sweepStale(env: Bindings, origin: string): Promise<void> {
  // A rep phone that has been "ringing" past any team's ring time (max 120 s).
  const ringing = await query<CallLegRow>("SELECT * FROM call_legs WHERE status = 'ringing' AND updated_at < datetime('now', '-3 minutes') LIMIT 20");
  for (const leg of ringing) {
    await stopLeg(env, leg, "canceled");
    await settle(env, origin, leg.call_id, "missed");
  }
  // A caller still "ringing" with no phone ringing for them (lost leg callback,
  // failed redirect) for over 5 minutes: voicemail, or the hang-up gets recorded.
  const stuck = await query<{ id: string }>(
    `SELECT c.id FROM calls c
     WHERE c.direction = 'inbound' AND c.status IN ('ringing', 'in-progress') AND c.created_at < datetime('now', '-5 minutes')
       AND NOT EXISTS (SELECT 1 FROM call_legs l WHERE l.call_id = c.id AND l.status IN ('ringing', 'joined') AND l.updated_at > datetime('now', '${STALE_CALL}'))
     LIMIT 20`,
  );
  for (const c of stuck) await settle(env, origin, c.id, "missed").catch((e) => console.error("sweep settle", c.id, e));
}
