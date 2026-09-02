import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Phone, Upload } from "lucide-react";
import { Toolbar } from "../app";
import { api, fmtDate, fmtDuration, leadName, type Call, type Lead, type Settings } from "../api";
import { Button, Card, Empty, Eyebrow, Zone } from "../components/ui";
import { CallStatusBadge, OutcomeChip } from "../components/status";

export function Dashboard({ settings }: { settings: Settings | null }) {
  const nav = useNavigate();
  const [todo, setTodo] = useState<{ leads: Lead[]; total: number } | null>(null);
  const [callbacks, setCallbacks] = useState<Lead[]>([]);
  const [recent, setRecent] = useState<(Call & { lead?: Lead })[]>([]);
  const [leadsById, setLeadsById] = useState<Record<string, Lead>>({});
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [t, c] = await Promise.all([api.leads({ status: "new", limit: 10 }), api.calls({ limit: 20 })]);
        setTodo({ leads: t.leads, total: t.total });
        setRecent(c.calls);
        const ids = [...new Set(c.calls.map((x) => x.lead_id))];
        const found: Record<string, Lead> = {};
        await Promise.all(ids.map(async (id) => {
          try {
            found[id] = (await api.lead(id)).lead;
          } catch {
            /* deleted lead */
          }
        }));
        setLeadsById(found);
        const cb = await api.leads({ status: "called", limit: 100 });
        setCallbacks(cb.leads.filter((l) => l.last_outcome === "callback"));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  async function startCalling() {
    setStarting(true);
    setError(null);
    try {
      // Reuse an unfinished campaign before making a new one.
      const { campaigns } = await api.campaigns();
      const open = campaigns.find((c) => c.completed < c.total);
      if (open) return nav(`/dialer?campaign=${open.id}`);
      const { campaign } = await api.createCampaign({ name: `New leads · ${new Date().toLocaleDateString()}`, filter: { status: "new" } });
      nav(`/dialer?campaign=${campaign.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <Toolbar title="Dashboard">
        <Button variant="primary" onClick={startCalling} disabled={starting || !settings?.configured}>
          <Phone size={13} /> Start calling
        </Button>
      </Toolbar>
      <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {error ? <p className="lg:col-span-2 text-sm text-danger">{error}</p> : null}
        <div className="space-y-6">
          <Card>
            <Zone>
              <Eyebrow right={todo ? `${todo.total} new` : undefined}>Leads to call</Eyebrow>
              {!todo ? null : todo.leads.length === 0 ? (
                <Empty title="No new leads" hint="Import a CSV or add a lead to get started." />
              ) : (
                <ul className="mt-2 divide-y divide-border">
                  {todo.leads.map((l) => (
                    <li key={l.id} className="flex items-center justify-between py-2 text-sm">
                      <Link to={`/leads/${l.id}`} className="truncate hover:underline">{leadName(l)}</Link>
                      <span className="data ml-3 shrink-0 text-xs text-muted">{l.company || l.phone}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Zone>
            {callbacks.length ? (
              <Zone>
                <Eyebrow right={`${callbacks.length}`}>Callbacks due</Eyebrow>
                <ul className="mt-2 divide-y divide-border">
                  {callbacks.map((l) => (
                    <li key={l.id} className="flex items-center justify-between py-2 text-sm">
                      <Link to={`/dialer?lead=${l.id}`} className="truncate hover:underline">{leadName(l)}</Link>
                      <span className="text-xs text-muted">{fmtDate(l.last_called_at)}</span>
                    </li>
                  ))}
                </ul>
              </Zone>
            ) : null}
            <Zone className="flex items-center justify-between">
              <span className="text-xs text-muted">Bring your list</span>
              <Link to="/leads" className="inline-flex items-center gap-1.5 text-sm underline decoration-border underline-offset-2 hover:decoration-foreground">
                <Upload size={13} /> Import CSV
              </Link>
            </Zone>
          </Card>
        </div>

        <div>
          <span className="eyebrow">Last 20 calls</span>
          {recent.length === 0 ? (
            <Empty title="No calls yet" hint="Your call log will appear here." />
          ) : (
            <div className="-mx-6 mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-border bg-sunken text-left text-xs font-semibold tracking-wide text-muted">
                    <th className="px-3 py-2.5 first:pl-6">Lead</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Outcome</th>
                    <th className="data px-3 py-2.5 text-right">Duration</th>
                    <th className="px-3 py-2.5 text-right last:pr-6">When</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((c) => {
                    const l = leadsById[c.lead_id];
                    return (
                      <tr key={c.id} className="border-b border-border hover:bg-sunken">
                        <td className="px-3 py-2 first:pl-6">
                          {l ? <Link to={`/leads/${l.id}`} className="hover:underline">{leadName(l)}</Link> : <span className="text-faint">{c.to_number}</span>}
                        </td>
                        <td className="px-3 py-2"><CallStatusBadge status={c.status} /></td>
                        <td className="px-3 py-2"><OutcomeChip outcome={c.outcome} /></td>
                        <td className="data px-3 py-2 text-right">{fmtDuration(c.duration_seconds)}</td>
                        <td className="data px-3 py-2 text-right text-muted last:pr-6">{fmtDate(c.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
