// Inline recording player. The native <audio> control ignores the design
// tokens and shows "0:00" until the file loads; this one draws a play button,
// a seekable hairline track and tabular times from the same palette as the
// rest of the app, and only touches the network when pressed.

import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { fmtDuration } from "../api";

export function RecordingPlayer({ src, duration, className = "" }: { src: string; duration: number | null; className?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState<number | null>(duration);
  const [error, setError] = useState(false);

  useEffect(() => () => audio.current?.pause(), []);

  function ensure(): HTMLAudioElement {
    if (audio.current) return audio.current;
    const a = new Audio(src);
    a.preload = "metadata";
    a.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(a.duration)) setTotal(Math.round(a.duration));
    });
    a.addEventListener("timeupdate", () => setTime(a.currentTime));
    a.addEventListener("playing", () => {
      setLoading(false);
      setPlaying(true);
    });
    a.addEventListener("waiting", () => setLoading(true));
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("ended", () => {
      setPlaying(false);
      setTime(0);
    });
    a.addEventListener("error", () => {
      setError(true);
      setLoading(false);
      setPlaying(false);
    });
    audio.current = a;
    return a;
  }

  async function toggle() {
    const a = ensure();
    if (playing) {
      a.pause();
      return;
    }
    setLoading(true);
    try {
      await a.play();
    } catch {
      setLoading(false);
    }
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = ensure();
    const len = total ?? (Number.isFinite(a.duration) ? a.duration : 0);
    if (!len) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * len;
    setTime(a.currentTime);
  }

  const pct = total ? Math.min(100, (time / total) * 100) : 0;

  if (error) return <span className="text-xs text-danger">Recording unavailable</span>;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause recording" : "Play recording"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-foreground hover:bg-sunken"
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : playing ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
      </button>
      <div
        role="slider"
        aria-label="Recording position"
        aria-valuemin={0}
        aria-valuemax={total ?? 0}
        aria-valuenow={Math.round(time)}
        onClick={seek}
        className="relative h-4 w-28 cursor-pointer"
      >
        <div className="absolute top-1/2 h-0.5 w-full -translate-y-1/2 rounded-full bg-border" />
        <div className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-foreground" style={{ width: `${pct}%` }} />
        <div className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full border border-border bg-surface" style={{ left: `${pct}%` }} />
      </div>
      <span className="data whitespace-nowrap text-xs text-muted">
        {fmtDuration(Math.round(time))} / {fmtDuration(total)}
      </span>
    </div>
  );
}
