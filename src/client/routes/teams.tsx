import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Toolbar } from "../app";
import { api, type Rep, type Team } from "../api";
import { Badge, Button, Card, CardTitle, Empty, Zone } from "../components/ui";

/**
 * Teams are ring groups: an inbound call for a team rings every available
 * member's browser at once. Reps appear here once they have opened the app.
 */
export function TeamsPage() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([api.teams(), api.reps()]);
      setTeams(t.teams);
      setReps(r.reps);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void api.reps().then((r) => setReps(r.reps)).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Toolbar title="Teams">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void run(async () => {
              await api.createTeam({ name: name.trim() });
              setName("");
            });
          }}
        >
          <input className="input h-7 w-44 text-[0.8125rem]" placeholder="New team, e.g. Support" value={name} onChange={(e) => setName(e.target.value)} aria-label="Team name" />
          <Button variant="primary" type="submit" disabled={!name.trim()}><Plus size={15} /> Add team</Button>
        </form>
      </Toolbar>
      <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!teams ? null : teams.length === 0 ? (
            <Empty title="No teams yet" hint="Create a team, add its members, then point a number at it on the Numbers page." />
          ) : (
            teams.map((t) => <TeamCard key={t.id} team={t} reps={reps} run={run} />)
          )}
        </div>
        <div>
          <CardTitle right={reps.filter((r) => r.available && r.online).length + " taking calls"}>People</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">Everyone who has opened this app. A call rings someone only while they are Available and have the app open.</p>
          {reps.length === 0 ? (
            <Empty title="Nobody yet" hint="Teammates appear here the first time they open the app." />
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {reps.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{r.name}</span>
                    {r.email && r.email !== r.name ? <span className="block truncate text-xs text-faint">{r.email}</span> : null}
                  </span>
                  {r.on_call ? <Badge tone="warning">On a call</Badge> : r.available && r.online ? <Badge tone="success">Available</Badge> : <Badge>{r.available ? "Offline" : "Away"}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function TeamCard({ team, reps, run }: { team: Team; reps: Rep[]; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState(team.name);
  const [ring, setRing] = useState(String(team.ring_seconds));
  const members = new Set(team.member_ids);
  const toggle = (id: string) => {
    const next = new Set(members);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void run(() => api.updateTeam(team.id, { member_ids: [...next] }));
  };
  return (
    <Card>
      <Zone>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-40 flex-1 text-[0.8125rem] font-medium text-muted-foreground">
            Name
            <input className="input mt-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== team.name && void run(() => api.updateTeam(team.id, { name: name.trim() }))} />
          </label>
          <label className="w-36 text-[0.8125rem] font-medium text-muted-foreground">
            Ring for (seconds)
            <input
              className="input mt-1 text-sm"
              type="number"
              min={10}
              max={120}
              value={ring}
              onChange={(e) => setRing(e.target.value)}
              onBlur={() => {
                const n = parseInt(ring, 10);
                if (n >= 10 && n <= 120 && n !== team.ring_seconds) void run(() => api.updateTeam(team.id, { ring_seconds: n }));
                else setRing(String(team.ring_seconds));
              }}
            />
          </label>
          <Button variant="ghost" size="icon" aria-label={`Delete ${team.name}`} title="Delete team" onClick={() => confirm(`Delete the ${team.name} team?`) && void run(() => api.deleteTeam(team.id))}>
            <Trash2 size={15} />
          </Button>
        </div>
      </Zone>
      <Zone>
        <CardTitle right={`${team.member_ids.length} members`}>Members</CardTitle>
        {reps.length === 0 ? (
          <p className="mt-2 text-xs text-faint">No people to add yet.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {reps.map((r) => (
              <label key={r.id} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-[0.8125rem] ${members.has(r.id) ? "bg-muted font-medium" : "text-muted-foreground"}`}>
                <input type="checkbox" checked={members.has(r.id)} onChange={() => toggle(r.id)} />
                {r.name}
              </label>
            ))}
          </div>
        )}
      </Zone>
    </Card>
  );
}
