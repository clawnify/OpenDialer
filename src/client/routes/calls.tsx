import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { Toolbar } from "../app";
import { api, callParty, fmtDate, fmtDuration, type Call } from "../api";
import { Button, Chip, Empty } from "../components/ui";
import { CallStatusBadge, OutcomeChip } from "../components/status";
import { RecordingPlayer } from "../components/recording-player";
import { CallNotes } from "../phone";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "inbound", label: "Inbound" },
  { id: "outbound", label: "Outbound" },
  { id: "missed", label: "Missed" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];

const PAGE = 50;

/** Everyone's calls, both directions: the team's call log. */
export function CallsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ calls: Call[]; total: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.calls({
        page,
        limit: PAGE,
        direction: filter === "inbound" || filter === "outbound" ? filter : filter === "missed" ? "inbound" : undefined,
        status: filter === "missed" ? "missed" : undefined,
        tag: tag.trim() || undefined,
      });
      setData({ calls: r.calls, total: r.total });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter, tag, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const th = "h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground";
  return (
    <>
      <Toolbar title="Calls">
        <input className="input h-7 w-32 text-[0.8125rem]" placeholder="Filter by tag" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }} />
        <div className="flex rounded-sm bg-muted p-0.5 text-[0.8125rem]" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => { setFilter(f.id); setPage(1); }}
              className={`rounded-xs px-2.5 py-0.5 ${filter === f.id ? "bg-card shadow-raised" : "text-muted-foreground"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </Toolbar>
      <div className="p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        {!data ? null : data.calls.length === 0 ? (
          <Empty title="No calls" hint="Calls your team makes and takes appear here." />
        ) : (
          <>
            <div className="-mx-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className={`${th} first:pl-6`}>Contact</th>
                    <th className={th}>Rep</th>
                    <th className={th}>Status</th>
                    <th className={th}>Outcome · tags</th>
                    <th className={`${th} text-right`}>Duration</th>
                    <th className={`${th} text-right last:pr-6`}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.calls.map((c) => (
                    <Fragment key={c.id}>
                      <tr className="h-11 cursor-pointer border-b border-border hover:bg-muted" onClick={() => setOpen(open === c.id ? null : c.id)}>
                        <td className="px-3 py-2 first:pl-6">
                          <span className="flex items-center gap-2">
                            {c.direction === "inbound" ? (
                              <PhoneIncoming size={14} className="shrink-0 text-faint" aria-label="Inbound" />
                            ) : (
                              <PhoneOutgoing size={14} className="shrink-0 text-faint" aria-label="Outbound" />
                            )}
                            {c.lead_id ? (
                              <Link to={`/leads/${c.lead_id}`} className="truncate hover:underline" onClick={(e) => e.stopPropagation()}>{callParty(c)}</Link>
                            ) : (
                              <span className="data truncate">{callParty(c)}</span>
                            )}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{c.user_name || (c.user_id ? "Teammate" : "–")}</td>
                        <td className="px-3 py-2"><CallStatusBadge status={c.status} /></td>
                        <td className="px-3 py-2">
                          <span className="flex flex-wrap items-center gap-1">
                            {c.outcome ? <OutcomeChip outcome={c.outcome} /> : null}
                            {c.tags.map((t) => <Chip key={t}>{t}</Chip>)}
                            {!c.outcome && !c.tags.length ? <span className="text-faint">–</span> : null}
                          </span>
                        </td>
                        <td className="data px-3 py-2 text-right">{fmtDuration(c.duration_seconds)}</td>
                        <td className="data px-3 py-2 text-right text-muted-foreground last:pr-6">{fmtDate(c.created_at)}</td>
                      </tr>
                      {open === c.id ? (
                        <tr className="border-b border-border bg-muted/40">
                          <td colSpan={6} className="px-6 py-3">
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div className="text-xs text-muted-foreground">
                                <p className="data">{c.from_number} → {c.to_number}</p>
                                {c.recording_url ? (
                                  <div className="mt-2"><RecordingPlayer src={c.recording_url} duration={c.recording_duration} /></div>
                                ) : !c.voicemail_url ? (
                                  <p className="mt-2 text-faint">No recording.</p>
                                ) : null}
                                {c.voicemail_url ? (
                                  <div className="mt-2">
                                    <p className="mb-1">Voicemail</p>
                                    <RecordingPlayer src={c.voicemail_url} duration={c.voicemail_duration} />
                                  </div>
                                ) : null}
                              </div>
                              <div className="card"><CallNotes callId={c.id} initial={c} /></div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {data.total > PAGE ? (
              <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <span className="data">{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, data.total)} of {data.total}</span>
                <Button onClick={() => setPage(page - 1)} disabled={page === 1}>Previous</Button>
                <Button onClick={() => setPage(page + 1)} disabled={page * PAGE >= data.total}>Next</Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
