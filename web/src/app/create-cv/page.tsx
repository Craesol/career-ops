"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, FileDown, Loader2 } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";

// Landing page for the daily email's per-offer "Create CV" link
// (/create-cv?url=…&title=…&company=…). An email link must never START a paid
// job on its own — mail clients and link scanners open links unprompted — so
// this page only shows the posting and waits for an explicit click. The click
// runs the same "evaluate-cv" worker as the discovery card's Create CV button:
// A–G evaluation + report/tracker row + tailored CV PDF in output/.
type Offer = { url: string; title: string; company: string };

function readOffer(): Offer | null {
  const q = new URLSearchParams(window.location.search);
  const url = (q.get("url") || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, title: (q.get("title") || "").trim(), company: (q.get("company") || "").trim() };
}

export default function CreateCvPage() {
  const router = useRouter();
  const { jobs, startJob } = useJobs();
  const [offer, setOffer] = useState<Offer | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);

  useEffect(() => setOffer(readOffer()), []);

  // A worker already running on this posting (e.g. the link was clicked twice)
  // is reused instead of starting a second paid run.
  const running = useMemo(
    () => (offer ? jobs.find((j) => j.input === offer.url && j.status === "running") : undefined),
    [jobs, offer],
  );

  const create = () => {
    if (!offer || starting) return;
    if (running) return router.push(`/jobs/${running.id}`);
    setStarting(true);
    const id = startJob({
      title: `Evaluate + CV · ${offer.company || "posting"}`,
      subtitle: offer.title,
      kind: "evaluate-cv",
      input: offer.url,
      page: "/create-cv",
    });
    if (id) router.push(`/jobs/${id}`);
    else setStarting(false);
  };

  if (offer === undefined) return null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Home
      </Link>

      {!offer ? (
        <p className="mt-8 text-sm text-muted">
          This link has no valid posting URL, so there is nothing to build a CV for.
        </p>
      ) : (
        <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-faint">create a tailored CV</p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{offer.title || "Untitled role"}</h1>
          {offer.company && <p className="mt-1 text-sm text-muted">{offer.company}</p>}
          <a href={offer.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-brand hover:underline">
            posting <ExternalLink className="size-3.5" />
          </a>

          <p className="mt-5 text-sm text-muted">
            This evaluates the posting (report and tracker row), then builds the tailored CV as a PDF in{" "}
            <span className="font-mono">output/</span>. It spends Claude usage and takes a few minutes. Keep this tab open until it
            finishes: closing it stops the worker.
          </p>

          <button
            type="button"
            onClick={create}
            disabled={starting}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {starting ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
            {running ? "Already running — view progress" : "Create CV"}
          </button>
        </section>
      )}
    </div>
  );
}
