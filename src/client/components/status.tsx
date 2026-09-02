import { Check, Loader2, PhoneOff } from "lucide-react";
import { Badge, Chip } from "./ui";
import { OUTCOME_LABELS, type Call, type Lead } from "../api";

export function CallStatusBadge({ status }: { status: Call["status"] }) {
  switch (status) {
    case "initiated":
    case "ringing":
      return (
        <Badge tone="neutral">
          <Loader2 size={11} className="animate-spin" /> {status === "ringing" ? "Ringing" : "Connecting"}
        </Badge>
      );
    case "in-progress":
      return (
        <Badge tone="success">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> In progress
        </Badge>
      );
    case "completed":
      return (
        <Badge tone="success">
          <Check size={11} strokeWidth={2.5} /> Completed
        </Badge>
      );
    case "no-answer":
      return <Badge tone="warning">No answer</Badge>;
    case "busy":
      return <Badge tone="warning">Busy</Badge>;
    case "canceled":
      return <Badge tone="neutral">Canceled</Badge>;
    default:
      return (
        <Badge tone="danger">
          <PhoneOff size={11} /> Failed
        </Badge>
      );
  }
}

export function OutcomeChip({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-faint">–</span>;
  if (outcome === "do_not_call") return <Badge tone="danger">Do not call</Badge>;
  if (outcome === "connected" || outcome === "callback") return <Badge tone="success">{OUTCOME_LABELS[outcome]}</Badge>;
  return <Chip>{OUTCOME_LABELS[outcome] || outcome}</Chip>;
}

export function LeadStatusChip({ status }: { status: Lead["status"] }) {
  if (status === "do_not_call") return <Badge tone="danger">Do not call</Badge>;
  if (status === "calling") return <Badge tone="neutral"><Loader2 size={11} className="animate-spin" /> Calling</Badge>;
  return <Chip>{status === "new" ? "New" : "Called"}</Chip>;
}
