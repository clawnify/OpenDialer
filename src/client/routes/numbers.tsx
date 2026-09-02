import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Toolbar } from "../app";
import { api, type OwnedNumber } from "../api";
import { Badge, Button, Chip, Empty } from "../components/ui";

export function NumbersPage() {
  const [numbers, setNumbers] = useState<OwnedNumber[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setNumbers((await api.numbers()).numbers);
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.syncNumbers();
      setNumbers(r.numbers);
      setNotice({ tone: "success", text: `Synced ${r.synced} voice-capable numbers from Twilio` });
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Toolbar title="Numbers">
        <Button variant="primary" onClick={sync} disabled={busy}><RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Sync from Twilio</Button>
      </Toolbar>
      <div className="p-6">
        {notice ? <p className={`mb-4 text-sm ${notice.tone === "danger" ? "text-danger" : "text-success"}`}>{notice.text}</p> : null}
        <span className="eyebrow">Caller IDs · {numbers.filter((n) => n.active).length}</span>
        <p className="mt-1 mb-3 text-xs text-muted">Only numbers owned by the connected Twilio account can be shown to a lead. Buy numbers in the Twilio console, then sync.</p>
        {numbers.length === 0 ? (
          <Empty title="No numbers synced" hint="Click Sync from Twilio to pull the account's voice-capable numbers." />
        ) : (
          <div className="-mx-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border bg-sunken text-left text-xs font-semibold tracking-wide text-muted">
                  <th className="px-3 py-2.5 first:pl-6">Number</th>
                  <th className="px-3 py-2.5">Country</th>
                  <th className="px-3 py-2.5">Area code</th>
                  <th className="px-3 py-2.5 text-right last:pr-6">Status</th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((n) => (
                  <tr key={n.id} className="border-b border-border hover:bg-sunken">
                    <td className="data px-3 py-2 first:pl-6">{n.e164}</td>
                    <td className="px-3 py-2"><Chip>{n.country || "?"}</Chip></td>
                    <td className="data px-3 py-2 text-muted">{n.area_code || "–"}</td>
                    <td className="px-3 py-2 text-right last:pr-6">{n.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Released</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
