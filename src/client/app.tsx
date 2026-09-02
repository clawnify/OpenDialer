import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Hash, LayoutDashboard, Phone, Settings as SettingsIcon, Users, TriangleAlert } from "lucide-react";
import { api, type Settings } from "./api";
import { Dashboard } from "./routes/dashboard";
import { LeadsPage } from "./routes/leads";
import { LeadDetail } from "./routes/lead-detail";
import { Dialer } from "./routes/dialer";
import { NumbersPage } from "./routes/numbers";
import { SettingsPage } from "./routes/settings";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/leads", label: "Leads", icon: Users },
  { to: "/dialer", label: "Dialer", icon: Phone },
  { to: "/numbers", label: "Numbers", icon: Hash },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
      setSettingsError(null);
    } catch (e) {
      setSettingsError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[16.25rem] shrink-0 border-r border-border bg-surface md:block">
        <div className="flex h-14 items-center gap-2 border-b border-border px-5">
          <Phone size={16} className="text-primary" />
          <span className="text-sm font-semibold">OpenDialer</span>
        </div>
        <nav className="p-3">
          <p className="mb-1 px-2.5 text-xs font-medium text-muted">Work</p>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2 rounded-md px-2.5 py-[0.4375rem] text-sm ${
                  isActive ? "bg-primary/12 font-semibold text-primary" : "text-foreground hover:bg-sunken"
                }`
              }
            >
              <n.icon size={15} /> {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex h-14 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-3 md:hidden">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap ${
                  isActive ? "bg-primary/12 font-semibold text-primary" : "text-foreground"
                }`
              }
            >
              <n.icon size={14} /> {n.label}
            </NavLink>
          ))}
        </nav>

        {settingsError ? (
          <ConfigBanner title="Could not load settings" detail={settingsError} />
        ) : settings && !settings.configured ? (
          <ConfigBanner
            title="Twilio is not configured"
            detail={`Missing: ${settings.missing.join(", ")}. Set them in Environment Variables and redeploy, then open Settings.`}
          />
        ) : null}

        <main className="flex-1">
          <Routes>
            <Route path="/" element={<Dashboard settings={settings} />} />
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
            <Route path="/dialer" element={<Dialer settings={settings} />} />
            <Route path="/numbers" element={<NumbersPage />} />
            <Route path="/settings" element={<SettingsPage settings={settings} onSaved={loadSettings} />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ConfigBanner({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 border-b border-warning/25 bg-warning-tint px-6 py-3 text-sm text-warning">
      <TriangleAlert size={15} className="mt-0.5 shrink-0" />
      <div>
        <span className="font-semibold">{title}.</span> {detail}
      </div>
    </div>
  );
}

/** Shared page chrome: sticky toolbar with the title left and actions right. */
export function Toolbar({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-6">
      <h1 className="text-xl font-bold tracking-tight">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
