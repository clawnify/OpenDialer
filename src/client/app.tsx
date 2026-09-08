import { useCallback, useEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { AppNav, reportLocation, type AppNavItem } from "@clawnify/app/client";
import { api, type Settings } from "./api";
import { Dashboard } from "./routes/dashboard";
import { LeadsPage } from "./routes/leads";
import { LeadDetail } from "./routes/lead-detail";
import { Dialer } from "./routes/dialer";
import { NumbersPage } from "./routes/numbers";
import { SettingsPage } from "./routes/settings";

// One definition of the navigation. <AppNav> paints it as this app's own
// sidebar when opened directly, and hands it to the Clawnify dashboard's
// sidebar when embedded there.
const NAV: AppNavItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/", icon: "layout-dashboard", home: true },
  { id: "leads", label: "Leads", href: "/leads", icon: "users" },
  { id: "dialer", label: "Dialer", href: "/dialer", icon: "phone" },
  { id: "numbers", label: "Numbers", href: "/numbers", icon: "hash" },
  { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
];

function activeNavId(pathname: string): string | undefined {
  return NAV.find((n) => (n.href === "/" ? pathname === "/" : pathname.startsWith(n.href!)))?.id;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // Leads still to call — shown as the badge on "Leads".
  const [newLeads, setNewLeads] = useState<number | undefined>();

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

  // Refresh the badge on every screen change: imports and calls both land
  // you on a new screen, so this is when the number can have moved.
  useEffect(() => {
    api
      .leads({ status: "new", limit: 1 })
      .then((r) => setNewLeads(r.total))
      .catch(() => setNewLeads(undefined));
  }, [location.pathname]);

  // Lets the dashboard restore this exact screen on reload.
  useEffect(() => {
    reportLocation(location.pathname + location.search);
  }, [location.pathname, location.search]);

  // Unlabelled on purpose: standalone the brand row names the app, and the
  // dashboard uses the app name as the eyebrow.
  const groups = [
    {
      items: NAV.map((n) => (n.id === "leads" && newLeads ? { ...n, count: newLeads } : n)),
    },
  ];

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <AppNav
        title="OpenDialer"
        icon="phone"
        groups={groups}
        active={activeNavId(location.pathname)}
        onNavigate={(item) => navigate(item.href!)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
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
