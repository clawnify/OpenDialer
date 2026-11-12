// The softphone: one Voice device for the whole page, the rep's availability
// for inbound calls, and the dock that rings, answers and runs a live inbound
// call (mute, transfer, notes, tags) on whatever screen the rep is on.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Call as SdkCall } from "@twilio/voice-sdk";
import { ArrowRightLeft, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, UserPlus, X } from "lucide-react";
import { api, callParty, fmtDuration, type Call, type Rep, type RingingCall, type Settings, type Team } from "./api";
import { Button } from "./components/ui";
import { VoiceClient } from "./voice";

const HEARTBEAT_MS = 30_000;

interface PhoneState {
  voice: VoiceClient;
  available: boolean;
  setAvailable: (v: boolean) => Promise<void>;
  /** Inbound ringing is set up on this deployment (API key present). */
  inboundReady: boolean;
}

const PhoneContext = createContext<PhoneState | null>(null);

export function usePhone(): PhoneState {
  const ctx = useContext(PhoneContext);
  if (!ctx) throw new Error("usePhone outside PhoneProvider");
  return ctx;
}

type Inbound =
  | { phase: "idle" }
  | { phase: "ringing"; sdk: SdkCall; info: RingingCall | null }
  /** Accepted; waiting for the call's details (or for the server to say a teammate took it). */
  | { phase: "connecting"; sdk: SdkCall }
  | { phase: "live"; sdk: SdkCall; call: Call; since: number }
  | { phase: "wrapup"; call: Call };

export function PhoneProvider({ settings, children }: { settings: Settings | null; children: ReactNode }) {
  const voice = useRef<VoiceClient>(new VoiceClient()).current;
  const [available, setAvailableState] = useState(false);
  const [inbound, setInbound] = useState<Inbound>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  // Bumped to retry registration after a token fetch failed (a network blip, a deploy).
  const [regAttempt, setRegAttempt] = useState(0);
  const inboundReady = Boolean(settings?.incoming_enabled);

  // Heartbeat: keeps this rep "online" so calls ring them, and refreshes their name.
  useEffect(() => {
    let stop = false;
    const beat = () =>
      api
        .presence()
        .then((r) => !stop && setAvailableState(r.available))
        .catch(() => {});
    void beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => () => voice.destroy(), [voice]);

  const onIncoming = useCallback((sdk: SdkCall) => {
    setError(null);
    setInbound({ phase: "ringing", sdk, info: null });
    const back = () => setInbound((s) => (s.phase === "ringing" && s.sdk === sdk ? { phase: "idle" } : s));
    // Another rep answered, or the caller hung up.
    sdk.on("cancel", back);
    sdk.on("reject", back);
    // The leg SID is stored a moment after Twilio places it; retry briefly.
    const legSid = sdk.parameters?.CallSid;
    void (async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const info = await api.ringing(legSid);
          if (info.call) {
            setInbound((s) => (s.phase === "ringing" && s.sdk === sdk ? { ...s, info } : s));
            return;
          }
        } catch {
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
  }, []);

  // Register for inbound calls while available; unregister when away.
  useEffect(() => {
    if (!inboundReady) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      if (!available) {
        await voice.unregister().catch(() => {});
        return;
      }
      let token: string;
      try {
        token = (await api.token()).token;
      } catch (e) {
        // Could be passing (offline, a deploy): stay available and try again shortly.
        if (cancelled) return;
        setError(`Could not reach the server to take calls: ${(e as Error).message}. Retrying.`);
        retry = setTimeout(() => setRegAttempt((n) => n + 1), 15_000);
        return;
      }
      if (cancelled) return;
      try {
        await voice.register(token, settings?.edge ?? null, onIncoming, async () => (await api.token()).token);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Twilio refused this browser (bad key, blocked mic policy): retrying will not help.
        // Available but unreachable would make the team ring a browser that never answers.
        setError(`Inbound calls cannot ring this browser: ${e instanceof Error ? e.message : "registration failed"} You are set to Away.`);
        api.presence(false).then((r) => setAvailableState(r.available)).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [available, inboundReady, settings?.edge, voice, onIncoming, regAttempt]);

  const setAvailable = useCallback(async (v: boolean) => {
    if (v) setError(null);
    const r = await api.presence(v);
    setAvailableState(r.available);
  }, []);

  return (
    <PhoneContext.Provider value={{ voice, available, setAvailable, inboundReady }}>
      {children}
      <PhoneDock inbound={inbound} setInbound={setInbound} error={error} setError={setError} />
    </PhoneContext.Provider>
  );
}

function PhoneDock({
  inbound,
  setInbound,
  error,
  setError,
}: {
  inbound: Inbound;
  setInbound: (s: Inbound | ((prev: Inbound) => Inbound)) => void;
  error: string | null;
  setError: (e: string | null) => void;
}) {
  const { voice, available, setAvailable, inboundReady } = usePhone();

  if (!inboundReady) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col items-end gap-2">
      {inbound.phase === "ringing" ? (
        <RingingCard
          inbound={inbound}
          onAccept={async () => {
            setError(null);
            const sdk = inbound.sdk;
            const legSid = sdk.parameters?.CallSid;
            setInbound({ phase: "connecting", sdk });
            voice.accept(sdk, {
              // Every update is checked against this SDK call, so a late lookup or
              // a stale handler never revives a call that has already ended.
              onDisconnect: () =>
                setInbound((s) =>
                  s.phase === "live" && s.sdk === sdk ? { phase: "wrapup", call: s.call } : (s.phase === "connecting" || s.phase === "ringing") && s.sdk === sdk ? { phase: "idle" } : s,
                ),
              onError: (m) => setError(m),
            });
            // Look the call up by this leg only. If a teammate won the race the
            // server hangs this leg up and onDisconnect returns the dock to idle.
            let info = inbound.info?.call ? inbound.info : null;
            for (let i = 0; !info && i < 4; i++) {
              info = await api.ringing(legSid).then((r) => (r.call ? r : null)).catch(() => null);
              if (!info) await new Promise((r) => setTimeout(r, 500));
            }
            const call = info?.call;
            if (call) setInbound((s) => (s.phase === "connecting" && s.sdk === sdk && sdk.status() !== "closed" ? { phase: "live", sdk, call, since: Date.now() } : s));
          }}
          onDecline={() => {
            inbound.sdk.reject();
            setInbound({ phase: "idle" });
          }}
        />
      ) : inbound.phase === "connecting" ? (
        <div className="pointer-events-auto card flex w-full items-center justify-between p-4">
          <p className="text-sm text-muted-foreground">Connecting…</p>
          <Button variant="primary" onClick={() => voice.hangup()}><PhoneOff size={15} /> Hang up</Button>
        </div>
      ) : inbound.phase === "live" ? (
        <LiveCard key={inbound.call.id} call={inbound.call} since={inbound.since} onHangup={() => voice.hangup()} />
      ) : inbound.phase === "wrapup" ? (
        <WrapUpCard key={inbound.call.id} callId={inbound.call.id} onDone={() => setInbound({ phase: "idle" })} />
      ) : null}

      {error ? (
        <div className="pointer-events-auto card w-full px-3 py-2 text-xs text-destructive">
          {error}
          <button type="button" className="float-right text-muted-foreground" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => void setAvailable(!available).catch((e) => setError((e as Error).message))}
        className="pointer-events-auto inline-flex h-8 items-center gap-2 rounded-full bg-card px-3 text-[0.8125rem] font-medium shadow-raised hover:bg-muted"
        title={available ? "Inbound calls ring this browser. Click to go away." : "You are not taking inbound calls. Click to become available."}
      >
        <span className={`inline-block size-2 rounded-full ${available ? "bg-success-solid" : "bg-faint"}`} />
        {available ? "Available" : "Away"}
      </button>
    </div>
  );
}

function RingingCard({ inbound, onAccept, onDecline }: { inbound: Extract<Inbound, { phase: "ringing" }>; onAccept: () => void; onDecline: () => void }) {
  const info = inbound.info;
  const who = info?.call ? callParty(info.call) : inbound.sdk.parameters?.From || "Incoming call";
  const via = [info?.number_label, info?.team_name].filter(Boolean).join(" · ");
  return (
    <div className="pointer-events-auto card w-full p-4" role="alertdialog" aria-label={`Incoming call from ${who}`}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <PhoneIncoming size={13} className="animate-pulse" /> {info?.kind === "transfer" ? "Transferred call" : "Incoming call"}
      </p>
      <p className="mt-1 truncate text-[1.0625rem] font-semibold">{who}</p>
      {info?.call?.contact_name ? <p className="data text-sm text-muted-foreground">{info.call.from_number}</p> : null}
      {via ? <p className="mt-0.5 text-xs text-faint">via {via}</p> : null}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={onAccept} className="flex-1">
          <Phone size={15} /> Accept
        </Button>
        <Button onClick={onDecline} className="flex-1">
          <PhoneOff size={15} /> Decline
        </Button>
      </div>
    </div>
  );
}

function LiveCard({ call, since, onHangup }: { call: Call; since: number; onHangup: () => void }) {
  const { voice } = usePhone();
  const [, tick] = useState(0);
  const [muted, setMuted] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="pointer-events-auto card w-full">
      <div className="border-b border-border p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium text-success">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-success" /> On a call · <span className="data">{fmtDuration(Math.floor((Date.now() - since) / 1000))}</span>
        </p>
        <p className="mt-1 truncate text-[1.0625rem] font-semibold">
          {call.lead_id ? <Link to={`/leads/${call.lead_id}`} className="hover:underline">{callParty(call)}</Link> : callParty(call)}
        </p>
        {call.record ? <p className="text-xs text-faint">Recording</p> : null}
        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => {
              voice.mute(!muted);
              setMuted(!muted);
            }}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? <MicOff size={15} /> : <Mic size={15} />} {muted ? "Unmute" : "Mute"}
          </Button>
          <Button onClick={() => setTransferOpen((v) => !v)}>
            <ArrowRightLeft size={15} /> Transfer
          </Button>
          <Button variant="primary" onClick={onHangup} className="ml-auto">
            <PhoneOff size={15} /> Hang up
          </Button>
        </div>
      </div>
      {transferOpen ? <TransferPanel callId={call.id} onDone={() => setTransferOpen(false)} /> : null}
      <CallNotes callId={call.id} initial={call} />
    </div>
  );
}

function TransferPanel({ callId, onDone }: { callId: string; onDone: () => void }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [mode, setMode] = useState<"warm" | "blind">("warm");
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    void Promise.all([api.teams(), api.reps()]).then(([t, r]) => {
      setTeams(t.teams);
      setReps(r.reps);
    });
  }, []);
  async function go(target: { user_id?: string; team_id?: string }, name: string) {
    setStatus(null);
    try {
      await api.transfer(callId, { ...target, mode });
      setStatus({
        tone: "ok",
        text: mode === "warm" ? `Ringing ${name}. Talk to them once they join, then hang up to hand over.` : `Ringing ${name}. You leave the call when they answer.`,
      });
    } catch (e) {
      setStatus({ tone: "err", text: (e as Error).message });
    }
  }
  const free = reps.filter((r) => r.available && r.online && !r.on_call);
  return (
    <div className="border-b border-border p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.8125rem] font-medium">Transfer to</p>
        <div className="flex rounded-sm bg-muted p-0.5 text-xs" role="radiogroup" aria-label="Transfer type">
          {(["warm", "blind"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-xs px-2 py-0.5 ${mode === m ? "bg-card shadow-raised" : "text-muted-foreground"}`}
              title={m === "warm" ? "You stay on the line and introduce the caller" : "You leave as soon as they answer"}
            >
              {m === "warm" ? "Warm" : "Blind"}
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-2 max-h-48 divide-y divide-border overflow-auto text-sm">
        {teams.map((t) => (
          <li key={t.id} className="flex items-center justify-between py-1.5">
            <span>{t.name} <span className="text-xs text-faint">team</span></span>
            <Button variant="ghost" onClick={() => void go({ team_id: t.id }, t.name)}>Ring</Button>
          </li>
        ))}
        {free.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-1.5">
            <span>{r.name}</span>
            <Button variant="ghost" onClick={() => void go({ user_id: r.id }, r.name)}>Ring</Button>
          </li>
        ))}
        {!teams.length && !free.length ? <li className="py-2 text-xs text-faint">Nobody else is available right now.</li> : null}
      </ul>
      {status ? <p className={`mt-2 text-xs ${status.tone === "err" ? "text-destructive" : "text-muted-foreground"}`}>{status.text}</p> : null}
      <button type="button" className="mt-1 text-xs text-muted-foreground underline" onClick={onDone}>Close</button>
    </div>
  );
}

/** Notes and tags, saved to the call on blur. Shared by the live card and the wrap-up. */
export function CallNotes({ callId, initial }: { callId: string; initial?: Pick<Call, "notes" | "tags"> }) {
  const [notes, setNotes] = useState(initial?.notes || "");
  const [tags, setTags] = useState<string[]>(initial?.tags || []);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  async function save(patch: { notes?: string; tags?: string[] }) {
    try {
      const r = await api.updateCall(callId, patch);
      setTags(r.call.tags);
      setSaved("Saved");
    } catch (e) {
      setSaved((e as Error).message);
    }
  }
  function addTag() {
    const t = draft.trim().toLowerCase();
    setDraft("");
    if (!t || tags.includes(t)) return;
    void save({ tags: [...tags, t] });
  }
  return (
    <div className="p-4">
      <textarea
        className="input h-16 py-2 text-sm"
        placeholder="Notes for this call"
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          setSaved(null);
        }}
        onBlur={() => void save({ notes })}
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-xs bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void save({ tags: tags.filter((x) => x !== t) })}>
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          className="input h-6 w-24 flex-1 px-1.5 text-xs"
          placeholder="Add tag"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
        />
        {saved ? <span className="ml-auto text-[0.6875rem] text-faint">{saved}</span> : null}
      </div>
    </div>
  );
}

function WrapUpCard({ callId, onDone }: { callId: string; onDone: () => void }) {
  const [call, setCall] = useState<Call | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.call(callId).then((r) => setCall(r.call)).catch(() => {});
  }, [callId]);
  async function saveLead() {
    if (!call) return;
    setSaving(true);
    setError(null);
    try {
      await api.createLead({ phone: call.from_number });
      setCall((await api.call(callId)).call);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  if (!call) return null;
  return (
    <div className="pointer-events-auto card w-full">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">Call ended</p>
          <p className="truncate font-semibold">{callParty(call)}</p>
        </div>
        {call.lead_id ? (
          <Link to={`/leads/${call.lead_id}`} className="text-sm underline decoration-border underline-offset-2">Open lead</Link>
        ) : (
          <Button onClick={saveLead} disabled={saving}><UserPlus size={15} /> Save as lead</Button>
        )}
      </div>
      {error ? <p className="px-4 pt-3 text-xs text-destructive">{error}</p> : null}
      <CallNotes callId={call.id} initial={call} />
      <div className="flex justify-end border-t border-border p-3">
        <Button variant="primary" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
