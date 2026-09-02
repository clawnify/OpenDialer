import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Mic, Phone, PhoneOff, TriangleAlert } from "lucide-react";
import { Toolbar } from "../app";
import { api, fmtDate, fmtDuration, leadName, OUTCOME_LABELS, type Call, type Campaign, type Lead, type OwnedNumber, type Settings } from "../api";
import { Button, Card, Chip, Empty, Eyebrow, Zone } from "../components/ui";
import { CallStatusBadge, OutcomeChip } from "../components/status";
import { VoiceClient } from "../voice";

const LEGAL =
  "You are placing a live outbound call. You are responsible for complying with US TCPA, DNC rules, and European GDPR/ePrivacy and country-specific calling rules. Recording laws vary. Get required consent.";

const TERMINAL = new Set<Call["status"]>(["completed", "failed", "no-answer", "busy", "canceled"]);
const OUTCOME_ORDER = ["connected", "voicemail", "no_answer", "busy", "wrong_number", "not_interested", "callback", "do_not_call"];

type Phase = "idle" | "starting" | "live" | "ended";

export function Dialer({ settings }: { settings: Settings | null }) {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const campaignId = sp.get("campaign");
  const leadId = sp.get("lead");

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [history, setHistory] = useState<Call[]>([]);
  const [numbers, setNumbers] = useState<OwnedNumber[]>([]);
  const [from, setFrom] = useState("");
  const [call, setCall] = useState<Call | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [savedOutcome, setSavedOutcome] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);
  const [done, setDone] = useState(false);
  const liveSince = useRef<number | null>(null);
  const voice = useRef<VoiceClient | null>(null);

  useEffect(() => {
    voice.current = new VoiceClient();
    return () => voice.current?.destroy();
  }, []);

  const loadLead = useCallback(async (id: string) => {
    const r = await api.lead(id);
    setLead(r.lead);
    setHistory(r.calls);
  }, []);

  const loadNext = useCallback(async () => {
    setError(null);
    setCall(null);
    setPhase("idle");
    setSavedOutcome(null);
    setNotes("");
    liveSince.current = null;
    try {
      if (campaignId) {
        const r = await api.nextInCampaign(campaignId);
        setCampaign(r.campaign);
        if (!r.lead) {
          setLead(null);
          setDone(true);
          return;
        }
        await loadLead(r.lead.id);
      } else if (leadId) {
        await loadLead(leadId);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [campaignId, leadId, loadLead]);

  useEffect(() => {
    void loadNext();
    api.numbers().then((r) => setNumbers(r.numbers.filter((n) => n.active))).catch(() => {});
  }, [loadNext]);

  useEffect(() => {
    if (settings?.preferred_from_number) setFrom(settings.preferred_from_number);
  }, [settings?.preferred_from_number]);

  // Poll the call row once a second while it is live; stop when Twilio reports a final status.
  useEffect(() => {
    if (!call || TERMINAL.has(call.status)) return;
    const t = setInterval(async () => {
      try {
        const { call: c } = await api.call(call.id);
        setCall(c);
        if (c.status === "in-progress" && liveSince.current === null) liveSince.current = Date.now();
        if (TERMINAL.has(c.status)) setPhase("ended");
      } catch {
        /* keep polling */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [call?.id, call?.status]);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const elapsed = useMemo(() => {
    if (call?.duration_seconds != null && TERMINAL.has(call.status)) return call.duration_seconds;
    if (liveSince.current === null) return 0;
    return Math.floor((Date.now() - liveSince.current) / 1000);
    // tick forces recomputation every second
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, call]);

  async function startCall() {
    if (!lead) return;
    setError(null);
    setPhase("starting");
    let created: Call | null = null;
    try {
      const r = await api.startCall(lead.id, from || undefined);
      created = r.call;
      setCall(r.call);
      if (r.mode === "browser") {
        if (!VoiceClient.supported) throw new Error("This browser does not support WebRTC calling.");
        await voice.current!.connect(r.token!, r.connect_params!, {
          onAccept: () => {
            setPhase("live");
            if (liveSince.current === null) liveSince.current = Date.now();
          },
          onDisconnect: () => setPhase("ended"),
          onError: (m) => {
            setError(m);
            setPhase("ended");
          },
        });
      } else {
        setPhase("live");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The call could not be started.");
      if (created) {
        // The row exists but no leg ever reached Twilio: close it so it does
        // not count as the rep's one active call, then let them save an outcome.
        try {
          const r = await api.hangup(created.id);
          setCall(r.call);
        } catch {
          /* leave it; the outcome save also closes it */
        }
        setPhase("ended");
      } else {
        setPhase("idle");
      }
    }
  }

  async function hangUp() {
    if (!call) return;
    if (call.mode === "browser") voice.current?.hangup();
    try {
      const r = await api.hangup(call.id);
      setCall(r.call);
    } catch (e) {
      setError((e as Error).message);
    }
    setPhase("ended");
  }

  async function saveOutcome(outcome: string) {
    if (!call) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.saveOutcome(call.id, outcome, notes);
      setCall(r.call);
      setSavedOutcome(outcome);
      if (lead) await loadLead(lead.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function next() {
    if (campaignId && lead) {
      try {
        await api.completeInCampaign(campaignId, lead.id);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      await loadNext();
    } else if (lead) {
      nav(`/leads/${lead.id}`);
    }
  }

  const configured = Boolean(settings?.configured);
  const browserMode = Boolean(settings?.voice_sdk_enabled);
  const canCall = configured && lead && lead.status !== "do_not_call" && phase === "idle";

  return (
    <>
      <Toolbar title={campaign ? campaign.name : "Dialer"}>
        {campaign ? <span className="data text-xs text-muted">{campaign.completed} of {campaign.total} done</span> : null}
      </Toolbar>

      <div className="border-b border-warning/25 bg-warning-tint px-6 py-2.5 text-xs text-warning">
        <TriangleAlert size={12} className="mr-1 inline -mt-0.5" />
        {LEGAL}
      </div>

      {done ? (
        <div className="p-6">
          <Empty title="Campaign complete" hint="Every lead in this list has been worked." />
          <div className="text-center"><Link to="/leads" className="text-sm underline decoration-border underline-offset-2">Back to leads</Link></div>
        </div>
      ) : !lead ? (
        <div className="p-6">
          {error ? <p className="text-sm text-danger">{error}</p> : <Empty title="Pick a lead to call" hint="Open a lead and press Call, or start a campaign from the Leads page." />}
        </div>
      ) : (
        <div className="grid gap-6 p-6 lg:grid-cols-2">
          <Card>
            <Zone>
              <Eyebrow right={<Chip>{lead.country}</Chip>}>Current lead</Eyebrow>
              <p className="mt-2 text-xl font-bold tracking-tight">{leadName(lead)}</p>
              <p className="text-sm text-muted">{lead.company || "No company"}</p>
              <p className="data mt-2 text-sm">{lead.phone}</p>
              {lead.timezone ? <p className="text-xs text-faint">{lead.timezone}</p> : null}
            </Zone>
            <Zone>
              <Eyebrow>Notes</Eyebrow>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted">{lead.notes || "No notes."}</p>
            </Zone>
            <Zone>
              <Eyebrow right={`${history.length}`}>Previous attempts</Eyebrow>
              {history.length === 0 ? (
                <p className="mt-1.5 text-sm text-faint">First attempt.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border text-sm">
                  {history.slice(0, 5).map((h) => (
                    <li key={h.id} className="flex items-center justify-between py-1.5">
                      <span className="flex items-center gap-2"><CallStatusBadge status={h.status} /><OutcomeChip outcome={h.outcome} /></span>
                      <span className="data text-xs text-muted">{fmtDate(h.created_at)} · {fmtDuration(h.duration_seconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Zone>
          </Card>

          <Card>
            <Zone>
              <Eyebrow right={call ? <CallStatusBadge status={call.status} /> : undefined}>Call</Eyebrow>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <label className="text-xs font-semibold text-muted">Caller ID
                  <select
                    className="mt-1 h-9 w-full rounded-sm border border-border bg-surface px-2.5 text-[0.8125rem] focus:border-ring focus:outline-none"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    disabled={phase !== "idle"}
                  >
                    <option value="">Automatic · local presence ({settings?.default_from_number || "no default"})</option>
                    {numbers.map((n) => <option key={n.id} value={n.e164}>{n.e164} · {n.country}{n.area_code ? ` ${n.area_code}` : ""}</option>)}
                  </select>
                </label>
                {phase === "idle" || phase === "starting" ? (
                  <Button variant="primary" onClick={startCall} disabled={!canCall}>
                    <Phone size={13} /> {phase === "starting" ? "Connecting…" : "Call"}
                  </Button>
                ) : phase === "live" ? (
                  <Button variant="primary" onClick={hangUp}><PhoneOff size={13} /> Hang up</Button>
                ) : (
                  <Button onClick={() => { setCall(null); setPhase("idle"); setSavedOutcome(null); liveSince.current = null; }} disabled={!savedOutcome && Boolean(call)} title={!savedOutcome && call ? "Save an outcome first" : undefined}>
                    <Phone size={13} /> Call again
                  </Button>
                )}
              </div>
              {!browserMode && configured ? (
                <p className="mt-2 text-xs text-muted">Browser calling is not set up. <strong>Calling your phone first, then the lead.</strong> Set your number in Settings.</p>
              ) : null}
              {browserMode ? (
                <p className="mt-2 flex items-center gap-1 text-xs text-muted"><Mic size={11} /> Your browser will ask for microphone access on the first call.</p>
              ) : null}
              {!configured ? <p className="mt-2 text-xs text-danger">Twilio is not configured; see Settings.</p> : null}
              {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
            </Zone>

            <Zone>
              <Eyebrow>Timer</Eyebrow>
              <p className="data mt-1 text-2xl font-bold">{fmtDuration(elapsed)}</p>
              <p className="h-4 text-xs text-faint">
                {call ? `from ${call.from_number} · ${call.mode === "api" ? "via your phone" : "browser"}` : "Recording is on by default. Tell the other party the call is recorded where required."}
              </p>
              {call?.error ? <p className="mt-1 text-xs text-danger">{call.error}</p> : null}
            </Zone>

            {phase === "ended" && call ? (
              <Zone>
                <Eyebrow right={savedOutcome ? <OutcomeChip outcome={savedOutcome} /> : undefined}>Outcome</Eyebrow>
                <div className="mt-3 flex flex-wrap gap-2">
                  {OUTCOME_ORDER.map((o) => (
                    <Button key={o} onClick={() => saveOutcome(o)} disabled={saving} variant={savedOutcome === o ? "primary" : "secondary"}>{OUTCOME_LABELS[o]}</Button>
                  ))}
                </div>
                <textarea
                  className="mt-3 h-20 w-full rounded-sm border border-border bg-surface px-2.5 py-2 text-[0.8125rem] placeholder:text-faint focus:border-ring focus:outline-none"
                  placeholder="Notes for this attempt (saved with the outcome)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <div className="mt-3 flex items-center justify-between">
                  {call.recording_url ? <audio controls preload="none" src={call.recording_url} className="h-8 w-56" /> : <span className="text-xs text-faint">Recording appears here when Twilio delivers it.</span>}
                  <Button variant="ghost" onClick={next} disabled={!savedOutcome}>
                    {campaignId ? "Next lead" : "Done"} <ArrowRight size={13} />
                  </Button>
                </div>
              </Zone>
            ) : null}
          </Card>
        </div>
      )}
    </>
  );
}
