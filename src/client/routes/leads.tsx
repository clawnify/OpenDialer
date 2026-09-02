import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Phone, Plus, Search, Upload, X } from "lucide-react";
import { Toolbar } from "../app";
import { api, fmtDate, leadName, type Lead } from "../api";
import { Button, Card, Empty, Eyebrow, Zone } from "../components/ui";
import { LeadStatusChip, OutcomeChip } from "../components/status";

const inputCls = "h-9 w-full rounded-sm border border-border bg-surface px-2.5 text-[0.8125rem] placeholder:text-faint focus:border-ring focus:outline-none";

export function LeadsPage() {
  const nav = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const [panel, setPanel] = useState<"add" | "import" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const limit = 25;

  const load = useCallback(async () => {
    try {
      const r = await api.leads({ page, limit, search });
      setLeads(r.leads);
      setTotal(r.total);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api.countries().then((r) => setCountries(r.countries)).catch(() => {});
  }, []);

  async function startCampaign() {
    try {
      const { campaign } = await api.createCampaign({ name: search ? `Search "${search}"` : "All leads", filter: { search: search || undefined } });
      nav(`/dialer?campaign=${campaign.id}`);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }

  return (
    <>
      <Toolbar title="Leads">
        <Button onClick={() => setPanel(panel === "import" ? null : "import")}><Upload size={13} /> Import CSV</Button>
        <Button onClick={() => setPanel(panel === "add" ? null : "add")}><Plus size={13} /> Add lead</Button>
        <Button variant="primary" onClick={startCampaign} disabled={total === 0}><Phone size={13} /> Call this list</Button>
      </Toolbar>
      <div className="p-6">
        {notice ? (
          <p className={`mb-4 text-sm ${notice.tone === "danger" ? "text-danger" : "text-success"}`}>{notice.text}</p>
        ) : null}
        {panel === "add" ? (
          <AddLead countries={countries} onDone={(msg) => { setPanel(null); setNotice({ tone: "success", text: msg }); void load(); }} onError={(m) => setNotice({ tone: "danger", text: m })} />
        ) : null}
        {panel === "import" ? (
          <ImportCsv countries={countries} onDone={(msg) => { setPanel(null); setNotice({ tone: "success", text: msg }); setPage(1); void load(); }} onError={(m) => setNotice({ tone: "danger", text: m })} />
        ) : null}

        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="eyebrow">Leads · {total}</span>
          <div className="relative w-72 max-w-full">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <input className={`${inputCls} pl-8`} placeholder="Search name, company, phone" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
        </div>

        {leads.length === 0 ? (
          <Empty title={search ? "No leads match" : "No leads yet"} hint={search ? "Try a different search." : "Add a lead or import a CSV with first_name,last_name,company,phone,country,notes."} />
        ) : (
          <div className="-mx-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border bg-sunken text-left text-xs font-semibold tracking-wide text-muted">
                  <th className="px-3 py-2.5 first:pl-6">Name</th>
                  <th className="px-3 py-2.5">Company</th>
                  <th className="px-3 py-2.5">Phone</th>
                  <th className="px-3 py-2.5">Country</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Last outcome</th>
                  <th className="px-3 py-2.5 text-right last:pr-6">Last called</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} className="border-b border-border hover:bg-sunken">
                    <td className="px-3 py-2 first:pl-6"><Link to={`/leads/${l.id}`} className="font-medium hover:underline">{leadName(l)}</Link></td>
                    <td className="px-3 py-2 text-muted">{l.company || "–"}</td>
                    <td className="data px-3 py-2">{l.phone}</td>
                    <td className="px-3 py-2">{l.country}</td>
                    <td className="px-3 py-2"><LeadStatusChip status={l.status} /></td>
                    <td className="px-3 py-2"><OutcomeChip outcome={l.last_outcome} /></td>
                    <td className="data px-3 py-2 text-right text-muted last:pr-6">{fmtDate(l.last_called_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > limit ? (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted">
            <span className="data">Page {page} of {Math.ceil(total / limit)}</span>
            <Button variant="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>Previous</Button>
            <Button variant="ghost" onClick={() => setPage((p) => p + 1)} disabled={page * limit >= total}>Next</Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function LeadForm({
  countries,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  countries: string[];
  initial?: Partial<Lead>;
  submitLabel: string;
  onSubmit: (body: Partial<Lead>) => Promise<void>;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<Partial<Lead>>({ first_name: "", last_name: "", company: "", phone: "", country: "", notes: "", ...initial });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Lead) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(f);
        } finally {
          setBusy(false);
        }
      }}
      className="grid gap-3 sm:grid-cols-2"
    >
      <label className="text-xs font-semibold text-muted">First name<input className={`${inputCls} mt-1`} value={f.first_name || ""} onChange={set("first_name")} /></label>
      <label className="text-xs font-semibold text-muted">Last name<input className={`${inputCls} mt-1`} value={f.last_name || ""} onChange={set("last_name")} /></label>
      <label className="text-xs font-semibold text-muted">Company<input className={`${inputCls} mt-1`} value={f.company || ""} onChange={set("company")} /></label>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <label className="text-xs font-semibold text-muted">Phone<input className={`${inputCls} mt-1`} required placeholder="+15551234567" value={f.phone || ""} onChange={set("phone")} /></label>
        <label className="text-xs font-semibold text-muted">Country
          <select className={`${inputCls} mt-1`} value={f.country || ""} onChange={set("country")}>
            <option value="">Auto</option>
            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <label className="text-xs font-semibold text-muted sm:col-span-2">Notes<textarea className={`${inputCls} mt-1 h-20 py-2`} value={f.notes || ""} onChange={set("notes")} /></label>
      <p className="text-xs text-faint sm:col-span-2">Numbers are stored as E.164. A national number needs its country; a number starting with + does not.</p>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={busy}>{submitLabel}</Button>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}

function AddLead({ countries, onDone, onError }: { countries: string[]; onDone: (msg: string) => void; onError: (m: string) => void }) {
  return (
    <Card className="mb-6">
      <Zone><Eyebrow>New lead</Eyebrow></Zone>
      <Zone>
        <LeadForm
          countries={countries}
          submitLabel="Add lead"
          onSubmit={async (body) => {
            try {
              const { lead } = await api.createLead(body);
              onDone(`Added ${leadName(lead)} (${lead.phone})`);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        />
      </Zone>
    </Card>
  );
}

function ImportCsv({ countries, onDone, onError }: { countries: string[]; onDone: (msg: string) => void; onError: (m: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; rejected: number; duplicates: number; errors: { line: number; error: string }[] } | null>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return onError("Choose a CSV file first");
    setBusy(true);
    try {
      const r = await api.importLeads(await file.text(), country || undefined);
      setResult(r);
      if (r.rejected === 0) onDone(`Imported ${r.imported} leads${r.duplicates ? `, skipped ${r.duplicates} duplicates` : ""}`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <Zone><Eyebrow>Import CSV</Eyebrow><p className="mt-1 text-xs text-muted">Columns: <code>first_name,last_name,company,phone,country,notes</code>. Phones may be national format when the country column is filled.</p></Zone>
      <Zone className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-muted">File<input ref={fileRef} type="file" accept=".csv,text/csv" className="mt-1 block text-sm" /></label>
        <label className="text-xs font-semibold text-muted">Default country
          <select className={`${inputCls} mt-1 w-28`} value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">None</option>
            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <Button variant="primary" onClick={upload} disabled={busy}><Upload size={13} /> Import</Button>
      </Zone>
      {result && result.rejected > 0 ? (
        <Zone>
          <Eyebrow right={`${result.imported} imported · ${result.rejected} rejected · ${result.duplicates} duplicates`}>Result</Eyebrow>
          <ul className="mt-2 max-h-40 overflow-auto text-xs text-danger">
            {result.errors.map((e) => <li key={e.line} className="data">Line {e.line}: {e.error}</li>)}
          </ul>
          <div className="mt-2"><Button variant="ghost" onClick={() => onDone(`Imported ${result.imported} leads, rejected ${result.rejected}`)}><X size={12} /> Close</Button></div>
        </Zone>
      ) : null}
    </Card>
  );
}
