import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Phone, Trash2 } from "lucide-react";
import { Toolbar } from "../app";
import { api, fmtDate, fmtDuration, leadName, type Call, type Lead } from "../api";
import { Button, Card, Empty, CardTitle, Zone } from "../components/ui";
import { CallStatusBadge, LeadStatusChip, OutcomeChip } from "../components/status";
import { LeadForm } from "./leads";
import { RecordingPlayer } from "../components/recording-player";

export function LeadDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [lead, setLead] = useState<Lead | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.lead(id);
      setLead(r.lead);
      setCalls(r.calls);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    api.countries().then((r) => setCountries(r.countries)).catch(() => {});
  }, [load]);

  async function remove() {
    if (!lead) return;
    try {
      await api.deleteLead(lead.id);
      nav("/leads");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;
  if (!lead) return null;

  return (
    <>
      <Toolbar title={leadName(lead)}>
        <Button onClick={() => setEditing((v) => !v)}><Pencil size={16} /> Edit</Button>
        <Button onClick={remove} title="Delete lead"><Trash2 size={16} /> Delete</Button>
        <Button variant="primary" onClick={() => nav(`/dialer?lead=${lead.id}`)} disabled={lead.status === "do_not_call"}><Phone size={16} /> Call</Button>
      </Toolbar>
      <div className="p-6">
        <Link to="/leads" className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={12} /> All leads</Link>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Card>
            <Zone>
              <CardTitle right={<LeadStatusChip status={lead.status} />}>Lead</CardTitle>
              {editing ? (
                <div className="mt-3">
                  <LeadForm
                    countries={countries}
                    initial={lead}
                    submitLabel="Save"
                    onCancel={() => setEditing(false)}
                    onSubmit={async (body) => {
                      try {
                        await api.updateLead(lead.id, { first_name: body.first_name, last_name: body.last_name, company: body.company, phone: body.phone, country: body.country || undefined, notes: body.notes });
                        setEditing(false);
                        setError(null);
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                </div>
              ) : (
                <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Company</dt><dd>{lead.company || "–"}</dd>
                  <dt className="text-muted-foreground">Phone</dt><dd className="data">{lead.phone}</dd>
                  <dt className="text-muted-foreground">Country</dt><dd>{lead.country}</dd>
                  <dt className="text-muted-foreground">Added</dt><dd className="data">{fmtDate(lead.created_at)}</dd>
                </dl>
              )}
            </Zone>
            <Zone>
              <CardTitle>Notes</CardTitle>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">{lead.notes || "No notes."}</p>
            </Zone>
            {lead.status !== "do_not_call" ? (
              <Zone>
                <Button variant="ghost" onClick={async () => { await api.updateLead(lead.id, { status: "do_not_call" }); await load(); }}>Mark do not call</Button>
              </Zone>
            ) : null}
          </Card>

          <div>
            <CardTitle right={calls.length}>Call history</CardTitle>
            {calls.length === 0 ? (
              <Empty title="Not called yet" />
            ) : (
              <div className="-mx-6 mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground first:pl-6">When</th>
                      <th className="h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground">From</th>
                      <th className="h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground">Status</th>
                      <th className="h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground">Outcome</th>
                      <th className="data h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground text-right">Duration</th>
                      <th className="h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground text-right last:pr-6">Recording</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((c) => (
                      <tr key={c.id} className="h-11 border-b border-border align-top hover:bg-muted">
                        <td className="data px-3 py-2 first:pl-6">{fmtDate(c.created_at)}</td>
                        <td className="data px-3 py-2 text-muted-foreground">{c.from_number}</td>
                        <td className="px-3 py-2"><CallStatusBadge status={c.status} />{c.error ? <p className="mt-1 text-xs text-destructive">{c.error}</p> : null}</td>
                        <td className="px-3 py-2"><OutcomeChip outcome={c.outcome} />{c.notes ? <p className="mt-1 text-xs text-muted-foreground">{c.notes}</p> : null}</td>
                        <td className="data px-3 py-2 text-right">{fmtDuration(c.duration_seconds)}</td>
                        <td className="px-3 py-2 text-right last:pr-6">
                          {c.recording_url ? (
                            <RecordingPlayer src={c.recording_url} duration={c.recording_duration} className="justify-end" />
                          ) : (
                            <span className="text-faint">{c.record ? "–" : "off"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
