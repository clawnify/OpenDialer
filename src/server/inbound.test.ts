/// <reference types="node" />
// The inbound state machine end to end: the real Hono app on an in-memory
// SQLite (the schema.sql that ships), with Twilio faked at fetch level and
// every webhook signed exactly as Twilio signs it.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDB } from "@clawnify/db";
import app from "./index";
import { claimLeg, sweepStale } from "./inbound";
import { expectedSignature } from "./twilio";
import type { CallLegRow } from "./types";

const ORIGIN = "http://localhost";
const TOKEN = "test-auth-token";
const NUMBER = "+31201234567";
const CALLER = "+31612345678";

/** Just enough of D1 for @clawnify/db, backed by node:sqlite. */
function d1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind: (...p: unknown[]) => {
          const args = p.map((v) => (typeof v === "boolean" ? Number(v) : v)) as never[];
          return {
            all: async () => ({ results: stmt.all(...args) }),
            first: async () => stmt.get(...args) ?? null,
            run: async () => {
              const r = stmt.run(...args);
              return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
            },
          };
        },
      };
    },
  };
}

type Sent = { method: string; path: string; body: Record<string, string> };

let db: DatabaseSync;
let env: Record<string, unknown>;
let sent: Sent[];
let nextLeg: number;
/** Per-test hooks into the fake Twilio. */
let hooks: { onCreateCall?: (body: Record<string, string>) => void; failCall?: (sid: string) => number | undefined };

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  env = { DB: d1(db), TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: TOKEN };
  sent = [];
  nextLeg = 0;
  hooks = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/2010-04-01\/Accounts\/ACtest/, "");
    const body = Object.fromEntries(new URLSearchParams(typeof init.body === "string" ? init.body : init.body ? String(init.body) : ""));
    const method = init.method || "GET";
    sent.push({ method, path, body });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/IncomingPhoneNumbers.json")
      return json({ incoming_phone_numbers: [{ sid: "PN1", phone_number: NUMBER, friendly_name: "", capabilities: { voice: true }, voice_url: "https://old.example/voice" }], next_page_uri: null });
    if (path === "/IncomingPhoneNumbers/PN1.json")
      return json({ sid: "PN1", phone_number: NUMBER, capabilities: { voice: true }, voice_url: "https://old.example/voice", voice_application_sid: "APold", status_callback: "https://old.example/status" });
    if (path === "/Calls.json") {
      hooks.onCreateCall?.(body);
      return json({ sid: `CL${++nextLeg}`, status: "queued" });
    }
    if (path.startsWith("/Calls/")) {
      const sid = path.slice(7, -5);
      const fail = hooks.failCall?.(sid);
      if (fail) return new Response(JSON.stringify({ code: 20500, message: "Internal error" }), { status: fail });
      return json({ sid, status: body.Status || "in-progress" });
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

/** Background work (ringing reps, cancelling legs) runs after the response. */
const flush = () => new Promise((r) => setTimeout(r, 20));

function as(user: string, role = "admin") {
  return { "X-Clawnify-User-Id": user, "X-Clawnify-User-Name": user.toUpperCase(), "X-Clawnify-User-Role": role, "content-type": "application/json" };
}

async function api(method: string, path: string, user: string, body?: unknown, role = "admin") {
  const res = await app.request(`${ORIGIN}${path}`, { method, headers: as(user, role), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, body: (await res.json()) as any };
}

/** POST a webhook the way Twilio does: form-encoded, signed over URL + sorted params. */
async function twilio(path: string, params: Record<string, string>, signature?: string) {
  const url = `${ORIGIN}${path}`;
  const sig = signature ?? (await expectedSignature(TOKEN, url, params));
  const res = await app.request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig }, body: new URLSearchParams(params).toString() }, env);
  return { status: res.status, text: await res.text() };
}

const row = <T,>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T;
const rows = <T,>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as T[];

/** Two reps online, two teams, the number connected behind a 1/2 menu. */
async function setup() {
  await api("POST", "/api/presence", "rep-a", { available: true });
  await api("POST", "/api/presence", "rep-b", { available: true });
  const sales = (await api("POST", "/api/teams", "rep-a", { name: "Sales", member_ids: ["rep-a", "rep-b"], ring_seconds: 20 })).body.team;
  const support = (await api("POST", "/api/teams", "rep-a", { name: "Support", member_ids: ["rep-b"] })).body.team;
  const synced = await api("POST", "/api/numbers/sync", "rep-a");
  expect(synced.status).toBe(200);
  const numberId = synced.body.numbers[0].id;
  const connected = await api("POST", `/api/numbers/${numberId}/connect`, "rep-a");
  expect(connected.status).toBe(200);
  expect(connected.body.previous_voice_url).toBe("https://old.example/voice");
  const routed = await api("PATCH", `/api/numbers/${numberId}`, "rep-a", {
    label: "Main line",
    route: "menu",
    greeting: "Thanks for calling Acme.",
    menu: [
      { digit: "1", label: "sales", team_id: sales.id },
      { digit: "2", label: "support", team_id: support.id },
    ],
  });
  expect(routed.status).toBe(200);
  return { sales, support, numberId };
}

async function incoming(callSid: string) {
  const res = await twilio("/api/twilio/inbound", { CallSid: callSid, From: CALLER, To: NUMBER, CallStatus: "ringing" });
  const call = row<{ id: string; status: string }>("SELECT id, status FROM calls WHERE twilio_call_sid = ?", callSid);
  return { res, call };
}

describe("inbound calls", () => {
  it("connecting a number points its voice URL here and clears any TwiML App", async () => {
    await setup();
    const update = sent.find((s) => s.method === "POST" && s.path === "/IncomingPhoneNumbers/PN1.json")!;
    expect(update.body).toMatchObject({ VoiceUrl: `${ORIGIN}/api/twilio/inbound`, VoiceApplicationSid: "", StatusCallback: `${ORIGIN}/api/twilio/inbound-status` });
  });

  it("disconnecting puts back the voice URL, TwiML App and status callback the number had", async () => {
    const { numberId } = await setup();
    sent = [];
    expect((await api("POST", `/api/numbers/${numberId}/disconnect`, "rep-a")).status).toBe(200);
    const update = sent.find((s) => s.method === "POST" && s.path === "/IncomingPhoneNumbers/PN1.json")!;
    expect(update.body).toMatchObject({ VoiceUrl: "https://old.example/voice", VoiceApplicationSid: "APold", StatusCallback: "https://old.example/status" });
  });

  it("only admins can rewire numbers and teams", async () => {
    const { numberId, support } = await setup();
    expect((await api("POST", `/api/numbers/${numberId}/connect`, "rep-b", undefined, "member")).status).toBe(403);
    expect((await api("PATCH", `/api/numbers/${numberId}`, "rep-b", { route: "off" }, "member")).status).toBe(403);
    expect((await api("PATCH", `/api/teams/${support.id}`, "rep-b", { member_ids: [] }, "member")).status).toBe(403);
    // No person behind the request: an agent's browser or a sibling app.
    for (const who of ["agent-browser", "app"]) {
      const res = await app.request(`${ORIGIN}/api/numbers/${numberId}/connect`, { method: "POST", headers: { "X-Clawnify-Caller": who } }, env);
      expect(res.status).toBe(403);
    }
    // Reading and answering are for everyone.
    expect((await api("GET", "/api/numbers", "rep-b", undefined, "member")).status).toBe(200);
    expect((await api("GET", "/api/inbox", "rep-b", undefined, "member")).status).toBe(200);
  });

  it("rejects a webhook with a bad signature", async () => {
    const res = await twilio("/api/twilio/inbound", { CallSid: "CAx", From: CALLER, To: NUMBER }, "forged");
    expect(res.status).toBe(403);
  });

  it("menu → ring the team → first answer wins → blind transfer → hang up", async () => {
    await setup();
    const { res, call } = await incoming("CA1");
    expect(res.text).toContain("<Gather");
    expect(res.text).toContain("Thanks for calling Acme. For sales, press 1. For support, press 2.");

    const picked = await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA1", Digits: "1" });
    expect(picked.text).toContain(`<Conference startConferenceOnEnter="false" endConferenceOnExit="true"`);
    await flush();
    const legs = rows<{ id: string; user_id: string; twilio_call_sid: string }>("SELECT id, user_id, twilio_call_sid FROM call_legs WHERE call_id = ? ORDER BY user_id", call.id);
    expect(legs.map((l) => l.user_id)).toEqual(["rep-a", "rep-b"]);
    const ringCalls = sent.filter((s) => s.path === "/Calls.json");
    expect(ringCalls.map((s) => s.body.To).sort()).toEqual(["client:rep-a", "client:rep-b"]);
    expect(ringCalls[0].body.From).toBe(CALLER);
    expect(ringCalls[0].body.Timeout).toBe("20");

    // The browser looks up what is ringing it.
    const ringingA = await api("GET", `/api/calls/ringing?leg_sid=${legs[0].twilio_call_sid}`, "rep-a");
    expect(ringingA.body).toMatchObject({ kind: "ring", team_name: "Sales", number_label: "Main line" });
    expect(ringingA.body.call.from_number).toBe(CALLER);

    // Both answer at the same moment: exactly one gets the caller.
    const [a, b] = await Promise.all(legs.map((l) => twilio(`/api/twilio/agent?call=${call.id}&leg=${l.id}`, { CallSid: l.twilio_call_sid })));
    const joined = [a, b].filter((r) => r.text.includes(`startConferenceOnEnter="true" endConferenceOnExit="false"`));
    const refused = [a, b].filter((r) => r.text.includes("A teammate already took this call."));
    expect([joined.length, refused.length]).toEqual([1, 1]);
    await flush();
    const winner = joined[0] === a ? "rep-a" : "rep-b";
    expect(row<{ user_id: string; status: string }>("SELECT user_id, status FROM calls WHERE id = ?", call.id)).toEqual({ user_id: winner, status: "in-progress" });
    expect(rows<{ status: string }>("SELECT status FROM call_legs WHERE call_id = ? ORDER BY status", call.id).map((l) => l.status)).toEqual(["joined", "missed"]);
    // From here on the test names the winner A and the other rep B.
    if (winner === "rep-b") legs.reverse();
    const [repA, repB] = winner === "rep-a" ? ["rep-a", "rep-b"] : ["rep-b", "rep-a"];
    // A late answer after the cleanup is refused too.
    const late = await twilio(`/api/twilio/agent?call=${call.id}&leg=${legs[1].id}`, { CallSid: legs[1].twilio_call_sid });
    expect(late.text).toContain("A teammate already took this call.");

    // B's late leg is closed; its status callback must not disturb the live call.
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${legs[1].id}`, { CallSid: legs[1].twilio_call_sid, CallStatus: "completed" });
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("in-progress");

    // A transfers to B, blind.
    const t = await api("POST", `/api/calls/${call.id}/transfer`, repA, { user_id: repB, mode: "blind" });
    expect(t.status).toBe(200);
    expect(t.body.ringing).toEqual([repB]);
    const tLeg = row<{ id: string; twilio_call_sid: string }>("SELECT id, twilio_call_sid FROM call_legs WHERE call_id = ? AND kind = 'transfer'", call.id);
    await twilio(`/api/twilio/agent?call=${call.id}&leg=${tLeg.id}`, { CallSid: tLeg.twilio_call_sid });
    await flush();
    // A is dropped the moment B joins, and B now owns the call.
    expect(sent.some((s) => s.path === `/Calls/${legs[0].twilio_call_sid}.json` && s.body.Status === "completed")).toBe(true);
    expect(row<{ user_id: string }>("SELECT user_id FROM calls WHERE id = ?", call.id).user_id).toBe(repB);
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${legs[0].id}`, { CallSid: legs[0].twilio_call_sid, CallStatus: "completed" });
    expect(sent.some((s) => s.path === "/Calls/CA1.json")).toBe(false);

    // B hangs up: the last rep is gone, so the caller is hung up, not sent to voicemail.
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${tLeg.id}`, { CallSid: tLeg.twilio_call_sid, CallStatus: "completed" });
    expect(sent.find((s) => s.path === "/Calls/CA1.json")?.body).toEqual({ Status: "completed" });
    await twilio("/api/twilio/inbound-status", { CallSid: "CA1", CallStatus: "completed" });
    const done = row<{ status: string; ended_at: string | null; duration_seconds: number | null }>("SELECT status, ended_at, duration_seconds FROM calls WHERE id = ?", call.id);
    expect(done.status).toBe("completed");
    expect(done.ended_at).not.toBeNull();
    expect(done.duration_seconds).not.toBeNull();
  });

  it("nobody picks up → voicemail → inbox until handled", async () => {
    await setup();
    await api("POST", "/api/presence", "rep-b", { available: false });
    const { call } = await incoming("CA2");
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA2", Digits: "1" });
    await flush();
    const leg = row<{ id: string; twilio_call_sid: string; user_id: string }>("SELECT * FROM call_legs WHERE call_id = ?", call.id);
    expect(leg.user_id).toBe("rep-a");

    // A's phone rings out: the caller is redirected to voicemail, once.
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${leg.id}`, { CallSid: leg.twilio_call_sid, CallStatus: "no-answer" });
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${leg.id}`, { CallSid: leg.twilio_call_sid, CallStatus: "no-answer" });
    const redirects = sent.filter((s) => s.path === "/Calls/CA2.json");
    expect(redirects).toHaveLength(1);
    expect(redirects[0].body.Url).toBe(`${ORIGIN}/api/twilio/voicemail?call=${call.id}`);
    const vm = await twilio(`/api/twilio/voicemail?call=${call.id}`, { CallSid: "CA2" });
    expect(vm.text).toContain("<Record");

    // The caller leaves a message, hangs up; the recording lands after the hang-up.
    await twilio("/api/twilio/inbound-status", { CallSid: "CA2", CallStatus: "completed" });
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("missed");
    await twilio(`/api/twilio/recording?call=${call.id}&kind=voicemail`, { RecordingStatus: "completed", RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingSid: "RE1", RecordingDuration: "14" });
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("voicemail");

    const inbox = await api("GET", "/api/inbox", "rep-a");
    expect(inbox.body.open).toBe(1);
    expect(inbox.body.calls[0]).toMatchObject({ id: call.id, status: "voicemail", voicemail_url: `/api/calls/${call.id}/voicemail`, recording_url: null, lead_id: null });
    await api("PATCH", `/api/calls/${call.id}`, "rep-a", { tags: ["Billing", "billing"], assigned_to: "rep-b", notes: "Wants a refund" });
    const handled = await api("PATCH", `/api/calls/${call.id}`, "rep-b", { handled: true });
    expect(handled.body.call).toMatchObject({ tags: ["billing"], assigned_to: "rep-b", handled_by: "rep-b" });
    expect((await api("GET", "/api/inbox", "rep-a")).body.open).toBe(0);

    // Saving the caller as a lead files the call under it.
    const lead = await api("POST", "/api/leads", "rep-a", { phone: CALLER, first_name: "Mara" });
    expect(row<{ lead_id: string }>("SELECT lead_id FROM calls WHERE id = ?", call.id).lead_id).toBe(lead.body.lead.id);
  });

  it("goes straight to voicemail when no member is available, and when closed", async () => {
    const { numberId } = await setup();
    await api("POST", "/api/presence", "rep-b", { available: false });
    const { call } = await incoming("CA3");
    const res = await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA3", Digits: "2" });
    expect(res.text).toContain("<Record");
    expect(sent.filter((s) => s.path === "/Calls.json")).toHaveLength(0);

    // Closed every day: the closed message plays before any menu.
    await api("PATCH", `/api/numbers/${numberId}`, "rep-a", { hours: { tz: "Europe/Amsterdam", days: {} }, closed_message: "We open at nine." });
    const closed = await incoming("CA4");
    expect(closed.res.text).toContain("We open at nine.");
    expect(closed.res.text).not.toContain("<Gather");
    expect(closed.call.status).toBe("voicemail");
  });

  it("the caller hanging up while it rings stops every rep's phone", async () => {
    await setup();
    const { call } = await incoming("CA5");
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA5", Digits: "1" });
    await flush();
    await twilio("/api/twilio/inbound-status", { CallSid: "CA5", CallStatus: "completed" });
    const legs = rows<{ twilio_call_sid: string; status: string }>("SELECT twilio_call_sid, status FROM call_legs WHERE call_id = ?", call.id);
    expect(legs.every((l) => l.status === "missed")).toBe(true);
    for (const l of legs) expect(sent.some((s) => s.path === `/Calls/${l.twilio_call_sid}.json` && s.body.Status === "canceled")).toBe(true);
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("missed");
  });

  it("two reps who both saw the call ringing cannot both claim it", async () => {
    // Two server instances each read the leg as ringing before either writes:
    // only the conditional UPDATE on calls stands between them.
    initDB({ DB: d1(db) } as never);
    db.exec(`INSERT INTO calls (id, from_number, to_number, mode, direction, status) VALUES ('c1', '${CALLER}', '${NUMBER}', 'conference', 'inbound', 'ringing');
             INSERT INTO call_legs (id, call_id, user_id) VALUES ('la', 'c1', 'rep-a'), ('lb', 'c1', 'rep-b');`);
    const [la, lb] = rows<CallLegRow>("SELECT * FROM call_legs WHERE call_id = 'c1' ORDER BY id");
    expect(await claimLeg(env as never, la, "CLa")).toBe(true);
    expect(await claimLeg(env as never, lb, "CLb")).toBe(false);
    expect(row<{ user_id: string }>("SELECT user_id FROM calls WHERE id = 'c1'").user_id).toBe("rep-a");
    expect(rows<{ status: string }>("SELECT status FROM call_legs WHERE call_id = 'c1' ORDER BY id").map((l) => l.status)).toEqual(["joined", "missed"]);
  });

  it("two reps answering a team transfer at the same instant: one takes it", async () => {
    initDB({ DB: d1(db) } as never);
    db.exec(`INSERT INTO calls (id, user_id, from_number, to_number, mode, direction, status) VALUES ('c2', 'rep-a', '${CALLER}', '${NUMBER}', 'conference', 'inbound', 'in-progress');
             INSERT INTO call_legs (id, call_id, user_id, kind, status, created_at) VALUES ('first', 'c2', 'rep-a', 'ring', 'joined', datetime('now', '-60 seconds'));
             INSERT INTO call_legs (id, call_id, user_id, kind, replaces_leg_id) VALUES ('tb', 'c2', 'rep-b', 'transfer', 'first'), ('tc', 'c2', 'rep-c', 'transfer', 'first');`);
    const [tb, tc] = rows<CallLegRow>("SELECT * FROM call_legs WHERE kind = 'transfer' ORDER BY id");
    expect(await claimLeg(env as never, tb, "CLb")).toBe(true);
    expect(await claimLeg(env as never, tc, "CLc")).toBe(false);
    expect(row<{ user_id: string }>("SELECT user_id FROM calls WHERE id = 'c2'").user_id).toBe("rep-b");
    // The same answer fetched again (a Twilio retry) is still the winner's.
    const joined = row<CallLegRow>("SELECT * FROM call_legs WHERE id = 'tb'");
    expect(await claimLeg(env as never, joined, "CLb")).toBe(true);
  });

  it("a retried inbound webhook and a retried answer do not ring twice or drop the rep", async () => {
    await setup();
    const { call } = await incoming("CA6");
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA6", Digits: "1" });
    await flush();
    const ringsBefore = sent.filter((s) => s.path === "/Calls.json").length;
    const again = await twilio("/api/twilio/inbound", { CallSid: "CA6", From: CALLER, To: NUMBER, CallStatus: "ringing" });
    expect(again.text).toContain("<Conference");
    await flush();
    expect(sent.filter((s) => s.path === "/Calls.json").length).toBe(ringsBefore);

    const leg = row<{ id: string; twilio_call_sid: string }>("SELECT id, twilio_call_sid FROM call_legs WHERE call_id = ? AND user_id = 'rep-a'", call.id);
    const first = await twilio(`/api/twilio/agent?call=${call.id}&leg=${leg.id}`, { CallSid: leg.twilio_call_sid });
    const retry = await twilio(`/api/twilio/agent?call=${call.id}&leg=${leg.id}`, { CallSid: leg.twilio_call_sid });
    expect(first.text).toContain("<Conference");
    expect(retry.text).toContain("<Conference");
  });

  it("a rep leg placed after the caller hung up is cancelled, not left ringing", async () => {
    await setup();
    const { call } = await incoming("CA7");
    // The caller hangs up while Twilio is still creating the rep calls.
    hooks.onCreateCall = () => db.exec(`UPDATE call_legs SET status = 'missed' WHERE call_id = '${call.id}'`);
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA7", Digits: "1" });
    await flush();
    const legs = rows<{ twilio_call_sid: string }>("SELECT twilio_call_sid FROM call_legs WHERE call_id = ?", call.id);
    expect(legs).toHaveLength(2);
    for (const l of legs) expect(sent.some((s) => s.path === `/Calls/${l.twilio_call_sid}.json` && s.body.Status === "canceled")).toBe(true);
  });

  it("a voicemail redirect Twilio refuses is undone, and the sweep sends the caller there later", async () => {
    await setup();
    await api("POST", "/api/presence", "rep-b", { available: false });
    const { call } = await incoming("CA8");
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA8", Digits: "1" });
    await flush();
    const leg = row<{ id: string; twilio_call_sid: string }>("SELECT id, twilio_call_sid FROM call_legs WHERE call_id = ?", call.id);
    hooks.failCall = (sid) => (sid === "CA8" ? 500 : undefined);
    const res = await twilio(`/api/twilio/leg?call=${call.id}&leg=${leg.id}`, { CallSid: leg.twilio_call_sid, CallStatus: "no-answer" });
    expect(res.status).toBe(500);
    // Not marked voicemail while the caller still hears hold music.
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("ringing");

    hooks.failCall = undefined;
    db.exec(`UPDATE calls SET created_at = datetime('now', '-6 minutes') WHERE id = '${call.id}'`);
    await sweepStale(env as never, ORIGIN);
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("voicemail");
    expect(sent.filter((s) => s.path === "/Calls/CA8.json" && s.body.Url).length).toBeGreaterThanOrEqual(2);
  });

  it("the sweep closes a rep phone whose ring-out callback never came", async () => {
    await setup();
    await api("POST", "/api/presence", "rep-b", { available: false });
    const { call } = await incoming("CA9");
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA9", Digits: "1" });
    await flush();
    db.exec(`UPDATE call_legs SET updated_at = datetime('now', '-4 minutes') WHERE call_id = '${call.id}'`);
    await sweepStale(env as never, ORIGIN);
    expect(row<{ status: string }>("SELECT status FROM call_legs WHERE call_id = ?", call.id).status).toBe("missed");
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("voicemail");
  });

  it("an answered call whose transfer nobody took keeps its recording apart from the message", async () => {
    await setup();
    const { call } = await incoming("CA10");
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA10", Digits: "1" });
    await flush();
    const [la, lb] = rows<{ id: string; twilio_call_sid: string }>("SELECT id, twilio_call_sid FROM call_legs WHERE call_id = ? ORDER BY user_id", call.id);
    await twilio(`/api/twilio/agent?call=${call.id}&leg=${la.id}`, { CallSid: la.twilio_call_sid });
    await flush();
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${lb.id}`, { CallSid: lb.twilio_call_sid, CallStatus: "canceled" });
    await twilio(`/api/twilio/recording?call=${call.id}`, { RecordingStatus: "completed", RecordingUrl: "https://api.twilio.com/rec/CONV", RecordingSid: "RECONV", RecordingDuration: "60" });
    // A warm transfer to B; A hangs up while it rings; B never answers.
    expect((await api("POST", `/api/calls/${call.id}/transfer`, "rep-a", { user_id: "rep-b", mode: "warm" })).status).toBe(200);
    const t = row<{ id: string; twilio_call_sid: string }>("SELECT id, twilio_call_sid FROM call_legs WHERE call_id = ? AND kind = 'transfer'", call.id);
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${la.id}`, { CallSid: la.twilio_call_sid, CallStatus: "completed" });
    expect(sent.some((s) => s.path === "/Calls/CA10.json")).toBe(false); // the transfer is still ringing
    await twilio(`/api/twilio/leg?call=${call.id}&leg=${t.id}`, { CallSid: t.twilio_call_sid, CallStatus: "no-answer" });
    expect(sent.find((s) => s.path === "/Calls/CA10.json")?.body.Url).toContain("/api/twilio/voicemail");
    // The caller hangs up at the greeting: the conversation recording is not a message.
    await twilio("/api/twilio/inbound-status", { CallSid: "CA10", CallStatus: "completed" });
    const done = row<{ status: string; recording_url: string; voicemail_url: string | null; duration_seconds: number | null }>(
      "SELECT status, recording_url, voicemail_url, duration_seconds FROM calls WHERE id = ?",
      call.id,
    );
    expect(done).toMatchObject({ status: "missed", recording_url: "https://api.twilio.com/rec/CONV", voicemail_url: null });
    expect(done.duration_seconds).not.toBeNull();
  });

  it("the caller hanging up takes a rep who just joined off the line", async () => {
    await setup();
    const { call } = await incoming("CA11");
    await twilio(`/api/twilio/menu?call=${call.id}&try=1`, { CallSid: "CA11", Digits: "1" });
    await flush();
    const leg = row<{ id: string; twilio_call_sid: string }>("SELECT id, twilio_call_sid FROM call_legs WHERE call_id = ? AND user_id = 'rep-a'", call.id);
    await twilio(`/api/twilio/agent?call=${call.id}&leg=${leg.id}`, { CallSid: leg.twilio_call_sid });
    await flush();
    await twilio("/api/twilio/inbound-status", { CallSid: "CA11", CallStatus: "completed" });
    expect(sent.some((s) => s.path === `/Calls/${leg.twilio_call_sid}.json` && s.body.Status === "completed")).toBe(true);
    expect(row<{ status: string }>("SELECT status FROM calls WHERE id = ?", call.id).status).toBe("completed");
  });

  it("refuses to delete a team a number still routes to", async () => {
    const { support } = await setup();
    const res = await api("DELETE", `/api/teams/${support.id}`, "rep-a");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(NUMBER);
  });
});
