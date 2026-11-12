import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Toolbar } from "../app";
import { api, type Day, type Hours, type MenuOption, type NumberRouting, type OwnedNumber, type Team } from "../api";
import { Badge, Button, CardTitle, Chip, Empty } from "../components/ui";

const DAYS: { id: Day; label: string }[] = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function NumbersPage() {
  const [numbers, setNumbers] = useState<OwnedNumber[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [n, t] = await Promise.all([api.numbers(), api.teams()]);
      setNumbers(n.numbers);
      setTeams(t.teams);
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

  const replace = (n: OwnedNumber) => setNumbers((all) => all.map((x) => (x.id === n.id ? n : x)));
  const th = "h-10 px-3 text-left text-[0.8125rem] font-medium text-muted-foreground";

  return (
    <>
      <Toolbar title="Numbers">
        <Button variant="primary" onClick={sync} disabled={busy}><RefreshCw size={16} className={busy ? "animate-spin" : ""} /> Sync from Twilio</Button>
      </Toolbar>
      <div className="p-6">
        {notice ? <p className={`mb-4 text-sm ${notice.tone === "danger" ? "text-destructive" : "text-success"}`}>{notice.text}</p> : null}
        <CardTitle right={numbers.filter((n) => n.active).length}>Numbers</CardTitle>
        <p className="mt-1 mb-3 text-xs text-muted-foreground">
          Every number is a caller ID for outbound calls. To take calls on one, open it, choose who answers, and connect it. Buy numbers in the Twilio console, then sync.
        </p>
        {numbers.length === 0 ? (
          <Empty title="No numbers synced" hint="Click Sync from Twilio to pull the account's voice-capable numbers." />
        ) : (
          <div className="-mx-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={`${th} first:pl-6`}>Number</th>
                  <th className={th}>Country</th>
                  <th className={th}>Inbound calls</th>
                  <th className={`${th} text-right last:pr-6`}>Status</th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((n) => (
                  <Fragment key={n.id}>
                    <tr className="h-11 cursor-pointer border-b border-border hover:bg-muted" onClick={() => n.active && setOpen(open === n.id ? null : n.id)}>
                      <td className="px-3 py-2 first:pl-6">
                        <span className="flex items-center gap-2">
                          {n.active ? open === n.id ? <ChevronDown size={14} className="text-faint" /> : <ChevronRight size={14} className="text-faint" /> : <span className="w-3.5" />}
                          <span className="data">{n.e164}</span>
                          {n.label ? <span className="text-muted-foreground">{n.label}</span> : null}
                        </span>
                      </td>
                      <td className="px-3 py-2"><Chip>{n.country || "?"}</Chip></td>
                      <td className="px-3 py-2 text-muted-foreground">{describeRoute(n, teams)}</td>
                      <td className="px-3 py-2 text-right last:pr-6">
                        {!n.active ? <Badge tone="neutral">Released</Badge> : n.connected && n.route !== "off" ? <Badge tone="success">Taking calls</Badge> : <Badge tone="neutral">Outbound only</Badge>}
                      </td>
                    </tr>
                    {open === n.id ? (
                      <tr className="border-b border-border bg-muted/40">
                        <td colSpan={4} className="px-6 py-4">
                          <RoutingEditor number={n} teams={teams} onSaved={replace} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function describeRoute(n: OwnedNumber, teams: Team[]): string {
  const name = (id: string | null) => teams.find((t) => t.id === id)?.name || "a deleted team";
  if (!n.connected || n.route === "off") return "–";
  if (n.route === "team") return `Rings ${name(n.team_id)}`;
  return `Menu: ${n.menu.map((o) => `${o.digit} ${o.label}`).join(", ")}`;
}

function RoutingEditor({ number, teams, onSaved }: { number: OwnedNumber; teams: Team[]; onSaved: (n: OwnedNumber) => void }) {
  const [draft, setDraft] = useState<NumberRouting>({
    label: number.label,
    route: number.route === "off" ? "team" : number.route,
    team_id: number.team_id || teams[0]?.id || null,
    menu: number.menu.length ? number.menu : [{ digit: "1", label: "", team_id: teams[0]?.id || "" }],
    greeting: number.greeting,
    hours: number.hours,
    closed_message: number.closed_message,
    voicemail_greeting: number.voicemail_greeting,
    record_inbound: number.record_inbound,
  });
  const [state, setState] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: NumberRouting) => {
    setDraft((d) => ({ ...d, ...patch }));
    setState(null);
  };

  async function act(fn: () => Promise<{ number: OwnedNumber }>, ok: string) {
    setBusy(true);
    setState(null);
    try {
      onSaved((await fn()).number);
      setState({ tone: "ok", text: ok });
    } catch (e) {
      setState({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const save = () => act(() => api.saveNumber(number.id, draft), "Saved");
  const saveAndConnect = () =>
    act(async () => {
      await api.saveNumber(number.id, draft);
      return api.connectNumber(number.id);
    }, "Connected: calls to this number now ring here.");
  const disconnect = () => {
    if (!confirm(`Stop taking calls on ${number.e164} here? Its previous Twilio voice URL is put back.`)) return;
    void act(() => api.disconnectNumber(number.id), "Disconnected");
  };

  if (!teams.length) return <p className="text-sm text-muted-foreground">Create a team on the Teams page first: inbound calls ring a team.</p>;

  const menu = draft.menu || [];
  const label = "text-[0.8125rem] font-medium text-muted-foreground";
  return (
    // Pinned to the viewport on phones: the table around it scrolls sideways.
    <div className="sticky left-6 grid w-[calc(100vw-3rem)] max-w-3xl gap-4 md:static md:w-auto">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          Name shown to reps when it rings
          <input className="input mt-1 text-sm" placeholder="Support line" value={draft.label || ""} onChange={(e) => set({ label: e.target.value })} />
        </label>
        <label className={label}>
          Greeting (optional, spoken first)
          <input className="input mt-1 text-sm" placeholder="Thanks for calling Acme." value={draft.greeting || ""} onChange={(e) => set({ greeting: e.target.value })} />
        </label>
      </div>

      <fieldset>
        <legend className={label}>Who answers</legend>
        <div className="mt-1 flex gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="radio" checked={draft.route === "team"} onChange={() => set({ route: "team" })} /> One team</label>
          <label className="flex items-center gap-1.5"><input type="radio" checked={draft.route === "menu"} onChange={() => set({ route: "menu" })} /> Menu (press 1, 2…)</label>
        </div>
        {draft.route === "team" ? (
          <select className="input mt-2 w-60 text-sm" value={draft.team_id || ""} onChange={(e) => set({ team_id: e.target.value })} aria-label="Team">
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : (
          <div className="mt-2 space-y-2">
            {menu.map((o, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Press</span>
                <select className="input h-7 w-14 text-sm" value={o.digit} onChange={(e) => set({ menu: menu.map((x, j) => (j === i ? { ...x, digit: e.target.value } : x)) })} aria-label="Digit">
                  {"1234567890".split("").map((d) => <option key={d}>{d}</option>)}
                </select>
                <span className="text-muted-foreground">for</span>
                <input className="input h-7 w-36 text-sm" placeholder="sales" value={o.label} onChange={(e) => set({ menu: menu.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} aria-label="Option name" />
                <span className="text-muted-foreground">rings</span>
                <select className="input h-7 w-40 text-sm" value={o.team_id} onChange={(e) => set({ menu: menu.map((x, j) => (j === i ? { ...x, team_id: e.target.value } : x)) })} aria-label="Team">
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <Button variant="ghost" size="icon" aria-label="Remove option" onClick={() => set({ menu: menu.filter((_, j) => j !== i) })}><Trash2 size={14} /></Button>
              </div>
            ))}
            {menu.length < 10 ? (
              <Button variant="ghost" onClick={() => set({ menu: [...menu, nextOption(menu, teams)] })}><Plus size={14} /> Add option</Button>
            ) : null}
            <p className="text-xs text-faint">Callers hear: “{[draft.greeting, ...menu.map((o) => `For ${o.label || "…"}, press ${o.digit}.`)].filter(Boolean).join(" ")}” No key pressed goes to voicemail.</p>
          </div>
        )}
      </fieldset>

      <HoursEditor hours={draft.hours ?? null} onChange={(hours) => set({ hours })} />
      {draft.hours ? (
        <label className={label}>
          Message when closed (then voicemail)
          <input className="input mt-1 text-sm" placeholder="We are closed right now. Please leave a message after the tone." value={draft.closed_message || ""} onChange={(e) => set({ closed_message: e.target.value })} />
        </label>
      ) : null}

      <label className={label}>
        Voicemail greeting when nobody answers
        <input className="input mt-1 text-sm" placeholder="Sorry, nobody can take your call right now. Please leave a message after the tone." value={draft.voicemail_greeting || ""} onChange={(e) => set({ voicemail_greeting: e.target.value })} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={Boolean(draft.record_inbound)} onChange={(e) => set({ record_inbound: e.target.checked })} />
        Record answered calls <span className="text-xs text-faint">(tell callers in your greeting where the law requires it)</span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        {number.connected ? (
          <>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>Save</Button>
            <Button variant="ghost" onClick={disconnect} disabled={busy}>Disconnect</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={() => void saveAndConnect()} disabled={busy}>Save and take calls here</Button>
            <span className="text-xs text-faint">Replaces this number's voice URL in Twilio; Disconnect puts the old one back.</span>
          </>
        )}
        {state ? <span className={`text-sm ${state.tone === "err" ? "text-destructive" : "text-success"}`}>{state.text}</span> : null}
      </div>
    </div>
  );
}

function nextOption(menu: MenuOption[], teams: Team[]): MenuOption {
  const used = new Set(menu.map((o) => o.digit));
  const digit = "1234567890".split("").find((d) => !used.has(d)) || "0";
  return { digit, label: "", team_id: teams[0]?.id || "" };
}

/** One opening range per day. Unticked days are closed; no hours at all = always open. */
function HoursEditor({ hours, onChange }: { hours: Hours | null; onChange: (h: Hours | null) => void }) {
  const label = "text-[0.8125rem] font-medium text-muted-foreground";
  if (!hours) {
    return (
      <div>
        <p className={label}>Business hours</p>
        <p className="mt-1 text-sm">
          Open around the clock.{" "}
          <button
            type="button"
            className="underline decoration-border underline-offset-2"
            onClick={() => onChange({ tz: localTz(), days: Object.fromEntries(DAYS.slice(0, 5).map((d) => [d.id, [["09:00", "17:00"]]])) })}
          >
            Set opening hours
          </button>
        </p>
      </div>
    );
  }
  const setDay = (d: Day, range: [string, string] | null) => {
    const days = { ...hours.days };
    if (range) days[d] = [range];
    else delete days[d];
    onChange({ ...hours, days });
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className={label}>Business hours</p>
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onChange(null)}>Open around the clock</button>
      </div>
      <label className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
        Time zone
        <input className="input h-7 w-52 text-sm" value={hours.tz} onChange={(e) => onChange({ ...hours, tz: e.target.value })} aria-label="Time zone" />
      </label>
      <div className="mt-2 grid gap-1.5">
        {DAYS.map((d) => {
          const range = hours.days[d.id]?.[0];
          return (
            <div key={d.id} className="flex items-center gap-2 text-sm">
              <label className="flex w-16 items-center gap-1.5">
                <input type="checkbox" checked={Boolean(range)} onChange={(e) => setDay(d.id, e.target.checked ? ["09:00", "17:00"] : null)} /> {d.label}
              </label>
              {range ? (
                <>
                  <input type="time" className="input h-7 w-32 text-sm" value={range[0]} onChange={(e) => setDay(d.id, [e.target.value, range[1]])} aria-label={`${d.label} opens`} />
                  <span className="text-faint">to</span>
                  <input type="time" className="input h-7 w-32 text-sm" value={range[1]} onChange={(e) => setDay(d.id, [range[0], e.target.value])} aria-label={`${d.label} closes`} />
                </>
              ) : (
                <span className="text-xs text-faint">Closed</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
