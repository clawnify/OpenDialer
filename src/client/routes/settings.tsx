import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Toolbar } from "../app";
import { api, type OwnedNumber, type Settings } from "../api";
import { Badge, Button, Card, Chip, Eyebrow, Zone } from "../components/ui";

const inputCls = "h-9 w-full rounded-sm border border-border bg-surface px-2.5 text-[0.8125rem] placeholder:text-faint focus:border-ring focus:outline-none";

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return ok ? <Badge tone="success"><Check size={11} strokeWidth={2.5} /> {label}</Badge> : <Badge tone="danger"><X size={11} /> {label}</Badge>;
}

export function SettingsPage({ settings, onSaved }: { settings: Settings | null; onSaved: () => void }) {
  const [callback, setCallback] = useState("");
  const [preferred, setPreferred] = useState("");
  const [numbers, setNumbers] = useState<OwnedNumber[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    if (!settings) return;
    setCallback(settings.callback_number);
    setPreferred(settings.preferred_from_number);
  }, [settings]);
  useEffect(() => {
    api.numbers().then((r) => setNumbers(r.numbers.filter((n) => n.active))).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      await api.saveSettings({ callback_number: callback, preferred_from_number: preferred });
      setNotice({ tone: "success", text: "Saved" });
      onSaved();
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;
  return (
    <>
      <Toolbar title="Settings" />
      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <Card>
          <Zone>
            <Eyebrow right={<Chip>{settings.provider}</Chip>}>Provider</Eyebrow>
            <div className="mt-3 flex flex-wrap gap-2">
              <Flag ok={settings.configured} label="REST credentials" />
              <Flag ok={settings.voice_sdk_enabled} label="Browser calling (Voice SDK)" />
            </div>
            {settings.missing.length ? (
              <p className="mt-3 text-sm text-danger">Missing: {settings.missing.join(", ")}</p>
            ) : null}
            {!settings.voice_sdk_enabled && settings.configured ? (
              <p className="mt-3 text-xs text-muted">Without TWILIO_TWIML_APP_SID, TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, calls fall back to ringing your phone first, then the lead.</p>
            ) : null}
          </Zone>
          <Zone>
            <Eyebrow>Default caller ID</Eyebrow>
            <p className="data mt-1.5 text-sm">{settings.default_from_number || <span className="text-faint">TWILIO_FROM_NUMBER not set</span>}</p>
            <p className="mt-1 text-xs text-muted">Used when no owned number matches the lead's country.</p>
          </Zone>
          <Zone>
            <Eyebrow>Webhook URLs for the Twilio console</Eyebrow>
            <dl className="mt-2 space-y-1.5 text-xs">
              <dt className="text-muted">TwiML App · Voice request URL (POST)</dt><dd className="data select-all break-all">{settings.webhooks.voice}</dd>
              <dt className="mt-2 text-muted">Status callback (set by the app per call)</dt><dd className="data break-all">{settings.webhooks.status}</dd>
              <dt className="mt-2 text-muted">Recording callback (set by the app per call)</dt><dd className="data break-all">{settings.webhooks.recording}</dd>
            </dl>
            <p className="mt-2 text-xs text-faint">Secrets are never shown here. They live in your environment variables.</p>
          </Zone>
        </Card>

        <Card>
          <Zone>
            <Eyebrow right={settings.user ? settings.user.name : "local"}>Your preferences</Eyebrow>
            <div className="mt-3 grid gap-3">
              <label className="text-xs font-semibold text-muted">Preferred caller ID
                <select className={`${inputCls} mt-1`} value={preferred} onChange={(e) => setPreferred(e.target.value)}>
                  <option value="">Automatic (local presence)</option>
                  {numbers.map((n) => <option key={n.id} value={n.e164}>{n.e164} · {n.country}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-muted">Your phone (fallback mode)
                <input className={`${inputCls} mt-1`} placeholder="+15551234567" value={callback} onChange={(e) => setCallback(e.target.value)} />
                <span className="mt-1 block font-normal text-faint">Only used when browser calling is unavailable: Twilio calls this number first, then bridges to the lead.</span>
              </label>
            </div>
          </Zone>
          <Zone className="flex items-center gap-3">
            <Button variant="primary" onClick={save} disabled={busy}>Save</Button>
            {notice ? <span className={`text-sm ${notice.tone === "danger" ? "text-danger" : "text-success"}`}>{notice.text}</span> : null}
          </Zone>
        </Card>
      </div>
    </>
  );
}
