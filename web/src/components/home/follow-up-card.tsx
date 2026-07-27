"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Clock, FileText, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { CompanyLogo } from "@/components/company-logo";

export type FollowUp = { num?: number; company: string; role?: string; status?: string; appliedDate?: string; notes?: string };

// One-tap overdue follow-up row (demand loop). "Mark followed up" appends to
// data/follow-ups.md (append-only) and optimistically clears the row; "Snooze" is
// a client dismiss. The cadence is the core's — we just surface + record.
export function FollowUpCard({ followup, onLogged }: { followup: FollowUp; onLogged?: () => void }) {
  const [state, setState] = useState<"idle" | "logging" | "removing" | "done" | "snoozed" | "removed">("idle");
  if (state === "snoozed" || state === "done" || state === "removed") return null;

  // "Remove" = stop chasing this application: sets the canonical status to
  // Discarded via the existing UPDATE-only /api/status route (never deletes the
  // tracker row), which drops it from the follow-up queue permanently.
  const remove = async () => {
    if (followup.num == null) return;
    setState("removing");
    try {
      await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: followup.num, status: "Discarded" }),
      });
    } catch {
      /* best-effort */
    }
    onLogged?.();
    setState("removed");
  };

  const log = async () => {
    setState("logging");
    try {
      await fetch("/api/followups/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ num: followup.num, company: followup.company, note: "Followed up" }),
      });
    } catch {
      /* best-effort */
    }
    onLogged?.();
    setState("done");
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface/40 px-3.5 py-3 transition hover:border-brand/30">
      {/* The row's identity opens the offer's page (report, status, tailored CV).
          It is a plain <a>, not a wrapper around the whole card, so the
          Mark-followed-up / Snooze / Remove buttons keep their own click
          targets instead of being swallowed by a parent link. */}
      <Link
        href={followup.num != null ? `/pipeline/${followup.num}` : "/pipeline"}
        className="group/row flex min-w-0 flex-[1_1_55%] items-center gap-3"
        title="Open this offer"
      >
        <CompanyLogo name={followup.company} size={22} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <span className="font-medium text-foreground transition-colors group-hover/row:text-brand">{followup.company}</span>
            {followup.role && <span className="text-muted"> · {followup.role}</span>}
          </p>
          <p className="flex items-center gap-1 text-[11px] text-faint">
            <Clock className="size-3" /> {followup.appliedDate ? `applied ${followup.appliedDate}` : "follow-up due"}
          </p>
        </div>
      </Link>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={state === "logging"}
          onClick={log}
          className={cn("inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-brand-soft hover:text-brand max-sm:min-h-[44px]")}
        >
          {state === "logging" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} <span className="hidden sm:inline">Mark followed up</span><span className="sm:hidden">Followed up</span>
        </button>
        {followup.num != null && (
          <a href={`/pipeline/${followup.num}`} title="Open report" className="inline-flex shrink-0 items-center justify-center rounded p-1 text-faint transition hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]">
            <FileText className="size-4" />
          </a>
        )}
        <button type="button" onClick={() => setState("snoozed")} className="inline-flex shrink-0 items-center justify-center text-[11px] text-faint transition hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]">
          Snooze
        </button>
        {followup.num != null && (
          <button
            type="button"
            disabled={state === "removing"}
            onClick={remove}
            title="Stop following up — marks this application Discarded in the tracker"
            className="inline-flex shrink-0 items-center justify-center gap-1 text-[11px] text-faint transition hover:text-red-500 max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            {state === "removing" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />} Remove
          </button>
        )}
      </div>
    </div>
  );
}
