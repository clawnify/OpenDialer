import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, ChevronDown, ChevronRight, Phone, RotateCcw } from "lucide-react";
import { Toolbar } from "../app";
import { api, callParty, fmtDate, type Call, type Rep } from "../api";
import { Button, Empty } from "../components/ui";
import { CallStatusBadge } from "../components/status";
import { RecordingPlayer } from "../components/recording-player";
import { CallNotes } from "../phone";

type State = "open" | "handled" | "all";

/**
 * Missed calls and voicemails, shared by the team. An item stays open until
 * someone marks it handled; assigning it says who will call back.
 */
export function InboxPage({ onChange }: { onChange?: () => void }) {
  const nav = useNavigate();
  const [state, setState] = useState<State>("open");
  const [mine, setMine] = useState(false);
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.inbox({ state, assigned: mine ? "me" : undefined });
      setCalls(r.calls);
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [state, mine, onChange]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api.reps().then((r) => setReps(r.reps)).catch(() => {});
  }, []);

  async function patch(id: string, body: Parameters<typeof api.updateCall>[1]) {
    setError(null);
    try {
      await api.updateCall(id, body);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function callBack(c: Call) {
    setError(null);
    try {
      // An unknown caller becomes a lead first, so the dialer has someone to call.
      const leadId = c.lead_id || (await api.createLead({ phone: c.from_number })).lead.id;
      nav(`/dialer?lead=${leadId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Toolbar title="Inbox">
        <label className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me
        </label>
        <div className="flex rounded-sm bg-muted p-0.5 text-[0.8125rem]" role="tablist" aria-label="Show">
          {(["open", "handled", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={state === s}
              onClick={() => setState(s)}
              className={`rounded-xs px-2.5 py-0.5 capitalize ${state === s ? "bg-card shadow-raised" : "text-muted-foreground"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </Toolbar>
      <div className="p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        {!calls ? null : calls.length === 0 ? (
          <Empty
            title={state === "open" ? "Nothing waiting" : "No calls here"}
            hint={state === "open" ? "Missed calls and voicemails land here until someone handles them." : undefined}
          />
        ) : (
          <ul className="-mx-6 divide-y divide-border border-y border-border">
            {calls.map((c) => {
              const expanded = open === c.id;
              return (
                <li key={c.id}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 hover:bg-muted">
                    <button type="button" className="flex w-full min-w-0 items-center gap-3 text-left sm:w-auto sm:flex-1" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}>
                      {expanded ? <ChevronDown size={15} className="shrink-0 text-faint" /> : <ChevronRight size={15} className="shrink-0 text-faint" />}
                      <CallStatusBadge status={c.status} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{callParty(c)}</span>
                        <span className="data block truncate text-xs text-muted-foreground">
                          {c.contact_name ? `${c.from_number} · ` : ""}
                          {fmtDate(c.created_at)}
                          {c.voicemail_duration ? ` · ${c.voicemail_duration}s message` : ""}
                        </span>
                      </span>
                    </button>
                    <select
                      className="input h-7 w-36 text-[0.8125rem] sm:w-40"
                      value={c.assigned_to || ""}
                      onChange={(e) => void patch(c.id, { assigned_to: e.target.value || null })}
                      aria-label="Assigned to"
                    >
                      <option value="">Unassigned</option>
                      {reps.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                    <Button onClick={() => void callBack(c)}><Phone size={15} /> Call back</Button>
                    {c.handled_at ? (
                      <Button variant="ghost" onClick={() => void patch(c.id, { handled: false })}><RotateCcw size={15} /> Reopen</Button>
                    ) : (
                      <Button variant="ghost" onClick={() => void patch(c.id, { handled: true })}><Check size={15} /> Handled</Button>
                    )}
                  </div>
                  {expanded ? (
                    <div className="grid gap-4 bg-muted/40 px-6 pb-4 sm:grid-cols-2">
                      <div className="pt-3">
                        {c.voicemail_url ? (
                          <RecordingPlayer src={c.voicemail_url} duration={c.voicemail_duration} />
                        ) : (
                          <p className="text-xs text-faint">{c.status === "voicemail" ? "The message is still being processed." : "No message left."}</p>
                        )}
                        {c.recording_url ? (
                          <div className="mt-3">
                            <p className="mb-1 text-xs text-muted-foreground">Conversation before it went to voicemail</p>
                            <RecordingPlayer src={c.recording_url} duration={c.recording_duration} />
                          </div>
                        ) : null}
                        {c.lead_id ? (
                          <Link to={`/leads/${c.lead_id}`} className="mt-3 inline-block text-sm underline decoration-border underline-offset-2">Open lead and history</Link>
                        ) : null}
                      </div>
                      <div className="card -mx-0">
                        <CallNotes callId={c.id} initial={c} />
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
