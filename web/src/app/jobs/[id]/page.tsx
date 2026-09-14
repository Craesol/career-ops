"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X, ExternalLink, Archive } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";

// Saved-run record shape (GET /api/runs/save?id=…) — the fallback when the
// live worker is gone from this browser's store (page reload, another
// browser/device, or the 40-entry history cap).
type SavedRun = {
  title?: string;
  subtitle?: string;
  page?: string;
  input?: string;
  result?: { score: number | null; summary: string } | null;
  steps?: { kind: string; label: string }[];
  output?: string;
};

function ArchivedRunView({ id, rec }: { id: string; rec: SavedRun }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Pipeline
      </Link>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            <Archive className="size-3 text-brand" /> saved record · worker finished
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{rec.title || id}</h1>
          {rec.subtitle && <p className="mt-1 text-sm text-muted">{rec.subtitle}</p>}
          {rec.input?.startsWith("http") && (
            <a href={rec.input} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-brand hover:underline">
              posting <ExternalLink className="size-3.5" />
            </a>
          )}
          {rec.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={rec.result.score >= 4 ? "good" : rec.result.score >= 3 ? "warn" : "bad"}>{rec.result.score}/5</Badge>
              {rec.result.summary && <span className="text-sm text-muted">{rec.result.summary}</span>}
            </div>
          )}
        </div>
      </section>

      {(rec.steps?.length ?? 0) > 0 && (
        <ol className="mt-6 space-y-2">
          {rec.steps!.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              {s.kind === "tool" ? <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" /> : <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />}
              <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>{s.kind === "tool" ? `Using ${s.label}` : s.label}</span>
            </li>
          ))}
        </ol>
      )}

      {rec.output && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Output</h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{rec.output}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs } = useJobs();
  const job = jobs.find((j) => j.id === id);

  // Fallback: this browser's store doesn't have the worker → try the saved
  // record on the server before declaring it lost.
  const [saved, setSaved] = useState<"idle" | "loading" | "missing">("idle");
  const [savedRec, setSavedRec] = useState<SavedRun | null>(null);
  useEffect(() => {
    if (job) return;
    setSaved("loading");
    fetch(`/api/runs/save?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : { found: false }))
      .then((d) => {
        if (d?.found && d.record) {
          setSavedRec(d.record as SavedRun);
        } else {
          setSaved("missing");
        }
      })
      .catch(() => setSaved("missing"));
  }, [job, id]);

  if (!job && savedRec) return <ArchivedRunView id={id} rec={savedRec} />;

  if (!job) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
          <ArrowLeft className="size-4" /> Pipeline
        </Link>
        {saved === "missing" ? (
          <p className="mt-8 text-sm text-muted">
            No live worker and no saved record for this run — it may have finished in another browser before its log was saved, or been
            interrupted. The real artifacts (report, tracker row, CV) live in the pipeline either way.
          </p>
        ) : (
          <p className="mt-8 inline-flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin text-brand" /> Looking up the saved record…
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Pipeline
      </Link>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand" /> working</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> done</>
            ) : (
              <><X className="size-3 text-red-400" /> error</>
            )}
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
          {job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>}
          {job.input?.startsWith("http") ? (
            <a
              href={job.input}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-sm text-brand hover:underline"
            >
              posting <ExternalLink className="size-3.5" />
            </a>
          ) : job.page?.startsWith("/pipeline/") ? (
            <Link href={job.page} className="mt-2 inline-flex items-center gap-1 text-sm text-brand hover:underline">
              report #{job.input}
            </Link>
          ) : null}
          {job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
            </div>
          )}
        </div>
      </section>

      <ol className="mt-6 space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            {s.kind === "tool" ? (
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" />
            ) : (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
            )}
            <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>
              {s.kind === "tool" ? `Using ${s.label}` : s.label}
            </span>
          </li>
        ))}
        {job.status === "running" && (
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-3.5 animate-spin text-brand" /> thinking…
          </li>
        )}
      </ol>

      {job.text && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Output</h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
