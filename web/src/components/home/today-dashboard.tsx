"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CircleHelp, Sparkles, ArrowRight } from "lucide-react";
import { instrumentSerif } from "@/lib/fonts";
import { HeroGlow } from "@/components/hero-glow";
import type { Application, InboxJob, TrendPoint } from "@/lib/career-ops";
import { canonStatus } from "@/lib/format";
import type { DiscoveredOffer } from "@/lib/explore";
import { DiscoveryCard } from "@/components/explore/discovery-card";
import { FollowUpCard, type FollowUp } from "@/components/home/follow-up-card";
import { DecisionCard } from "@/components/home/decision-card";
import { QuickEvaluate } from "@/components/quick-evaluate";

// The retention "Today": a dual-loop action queue (the maintainer's
// "N new matches this week · M follow-ups due"). SUPPLY loop = fresh free-scan
// matches (zero tokens, /api/whats-new); DEMAND loop = follow-ups due
// (/api/followups). Each item one-tap actionable. Home stays a VIEW over the
// canonical files — every action dispatches a real registry action / route.
export function TodayDashboard({
  applications,
  inbox,
  inBetween,
  trend = [],
}: {
  applications: Application[];
  inbox: InboxJob[];
  inBetween: boolean;
  trend?: TrendPoint[];
}) {
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [fresh, setFresh] = useState<DiscoveredOffer[]>([]);
  const router = useRouter();
  const dateLabel = useMemo(() => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), []);

  const refetch = useCallback(() => {
    fetch("/api/followups")
      .then((r) => r.json())
      .then((d) => {
        setFollowups(Array.isArray(d.entries) ? d.entries : []);
        setOverdue(d.metadata?.overdue ?? d.entries?.length ?? 0);
      })
      .catch(() => {});
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then((d) => setFresh(Array.isArray(d.offers) ? d.offers : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refetch();
    // A worker (evaluate/pdf) just wrote a real tracker row — refresh the server
    // snapshot (applications/inbox props) + the client loops so the freshly-scored
    // role appears in "Awaiting your decision" without a manual reload.
    const onDone = () => {
      router.refresh();
      refetch();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [refetch, router]);

  // Awaiting decision: scored (Evaluated) but no terminal status yet.
  const awaiting = useMemo(
    () => applications.filter((a) => /^evaluat/i.test(a.status)).slice(0, 6),
    [applications],
  );

  const newThisWeek = fresh.length;
  const allClear = newThisWeek === 0 && overdue === 0 && awaiting.length === 0;

  // Analytics over the full tracker (canonical statuses via canonStatus).
  const { activeCount, awaitingCount, funnelCounts } = useMemo(() => {
    const by = new Map<string, number>();
    for (const a of applications) {
      const s = canonStatus(a.status);
      by.set(s, (by.get(s) ?? 0) + 1);
    }
    const n = (k: string) => by.get(k) ?? 0;
    return {
      awaitingCount: n("EVALUATED"),
      activeCount: n("APPLIED") + n("RESPONDED") + n("INTERVIEW") + n("OFFER"),
      funnelCounts: FUNNEL_STAGES.map(({ key, label }, i) => ({ key, label, color: FUNNEL_RAMP[i], count: n(key) })),
    };
  }, [applications]);
  const inboxUrls = useMemo(() => new Set(inbox.map((j) => j.url)), [inbox]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 max-sm:pb-24">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
        <HeroGlow />
        {/* Readability scrim between the animated glow (z-0) and the copy (z-10). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> today · <span className="tabular-nums">{dateLabel}</span>
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 text-2xl leading-tight text-landing md:text-3xl`}>
            {allClear ? "You're all caught up." : "Where your search stands"}
          </h1>

          {/* Analytics band — real numbers over the canonical files. */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="New this week" value={newThisWeek} accent hint="fresh scan matches" />
            <StatTile label="Follow-ups due" value={overdue} accent={overdue > 0} hint="demand loop" />
            <StatTile label="Active applications" value={activeCount} hint="applied → offer" />
            <StatTile label="Awaiting decision" value={awaitingCount} hint="scored, undecided" />
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <FunnelBar counts={funnelCounts} />
            <Sparkline points={trend} />
          </div>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link href="/explore" className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 max-sm:min-h-[44px]">
              Find new roles <ArrowRight className="size-4" />
            </Link>
            <Link href="/pipeline" className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]">
              Open pipeline
            </Link>
          </div>
          {inBetween && <QuickEvaluate />}
        </div>
      </section>

      {/* A. Fresh matches this week (supply loop) — new roles first, always on top */}
      {fresh.length > 0 && (
        <Section icon={Sparkles} title="Fresh matches this week" hint="Found by your free scans · 0 tokens">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {fresh.slice(0, 6).map((o) => (
              <DiscoveryCard key={o.url} offer={o} inPipeline={inboxUrls.has(o.url)} />
            ))}
          </div>
          {fresh.length > 6 && (
            <Link href="/explore" className="mt-3 inline-flex items-center text-sm text-muted transition hover:text-brand max-sm:min-h-[44px]">
              See all {fresh.length} →
            </Link>
          )}
        </Section>
      )}

      {/* B. Follow-ups due (demand loop) */}
      {followups.length > 0 && (
        <Section icon={Bell} title="Follow-ups due" hint="Keep your applications alive — a nudge beats silence">
          <div className="grid gap-2.5">
            {followups.map((f) => (
              <FollowUpCard key={`${f.num}-${f.company}`} followup={f} onLogged={() => setOverdue((n) => Math.max(0, n - 1))} />
            ))}
          </div>
        </Section>
      )}

      {/* C. Awaiting your decision */}
      {awaiting.length > 0 && (
        <Section icon={CircleHelp} title="Awaiting your decision" hint="Scored — apply or skip">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {awaiting.map((a) => (
              <DecisionCard key={a.n} app={a} />
            ))}
          </div>
        </Section>
      )}

      {allClear && (
        <div className="mt-8 rounded-2xl border border-border bg-surface/30 px-6 py-10 text-center">
          <Sparkles className="mx-auto size-6 text-brand" />
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Nothing needs you right now. Run a <Link href="/explore" className="text-brand hover:underline">free scan</Link> to surface this week&apos;s roles, or check your <Link href="/pipeline" className="text-brand hover:underline">pipeline</Link>.
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, hint, children }: { icon: React.ComponentType<{ className?: string }>; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-brand" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
        <span className="text-xs text-faint">· {hint}</span>
      </div>
      {children}
    </section>
  );
}

// ── Analytics band pieces ──────────────────────────────────────────────────
// Sequential purple ramp (lightness-monotonic on both surfaces); stages carry
// direct labels + counts, so identity never rides on color alone.
const FUNNEL_RAMP = ["#e3d4f9", "#c3a2f1", "#a06bff", "#8a2cdd", "#6f24b4", "#521a86"];
const FUNNEL_STAGES = [
  { key: "EVALUATED", label: "Evaluated" },
  { key: "APPLIED", label: "Applied" },
  { key: "RESPONDED", label: "Responded" },
  { key: "INTERVIEW", label: "Interview" },
  { key: "OFFER", label: "Offer" },
  { key: "HIRED", label: "Hired" },
];

function StatTile({ label, value, hint, accent = false }: { label: string; value: number; hint: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface/60 px-4 py-3">
      <p className={`text-2xl font-semibold tabular-nums leading-none ${accent && value > 0 ? "text-brand-text" : "text-foreground"}`}>{value}</p>
      <p className="mt-1.5 text-xs font-medium text-muted">{label}</p>
      <p className="text-[11px] text-faint">{hint}</p>
    </div>
  );
}

function FunnelBar({ counts }: { counts: { key: string; label: string; color: string; count: number }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = counts.reduce((s, c) => s + c.count, 0);
  const live = counts.filter((c) => c.count > 0);
  return (
    <div className="rounded-xl border border-border bg-surface/60 px-4 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium text-muted">Pipeline funnel</p>
        <p className="text-[11px] tabular-nums text-faint">{total} in play</p>
      </div>
      {/* Segmented bar — 2px surface gaps between fills, 24px min hit target. */}
      <div className="mt-2.5 flex h-6 w-full gap-[2px] overflow-hidden rounded-md" role="img" aria-label={counts.map((c) => `${c.label} ${c.count}`).join(", ")}>
        {live.map((c) => (
          <div
            key={c.key}
            className="min-w-[24px] cursor-default transition-opacity"
            style={{ flexGrow: c.count, backgroundColor: c.color, opacity: hover && hover !== c.key ? 0.45 : 1 }}
            onMouseEnter={() => setHover(c.key)}
            onMouseLeave={() => setHover(null)}
            title={`${c.label} — ${c.count}`}
          />
        ))}
      </div>
      {/* Direct labels: swatch + name + count for every stage, zero included. */}
      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1">
        {counts.map((c) => (
          <span key={c.key} className={`inline-flex items-center gap-1.5 text-[11px] transition-opacity ${hover && hover !== c.key ? "opacity-50" : ""}`}>
            <span className="inline-block size-2 rounded-[3px]" style={{ backgroundColor: c.color }} />
            <span className="text-muted">{c.label}</span>
            <span className="tabular-nums text-foreground">{c.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Sparkline({ points }: { points: { date: string; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;
  const W = 300;
  const H = 56;
  const PAD = 4;
  const max = Math.max(1, ...points.map((p) => p.count));
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (points.length - 1);
  const y = (v: number) => H - PAD - (v * (H - PAD * 2)) / max;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  const total = points.reduce((s, p) => s + p.count, 0);
  const h = hover != null ? points[hover] : null;
  const fmt = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div className="rounded-xl border border-border bg-surface/60 px-4 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium text-muted">Roles discovered · last {points.length} days</p>
        <p className="text-[11px] tabular-nums text-faint">
          {h ? `${fmt(h.date)} · ${h.count}` : `${total} total`}
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 block h-14 w-full" onMouseLeave={() => setHover(null)}>
        <path d={area} fill="var(--color-brand-soft)" />
        <path d={line} fill="none" stroke="var(--color-brand-secondary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD} y2={H - PAD} stroke="var(--color-border)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(points[hover].count)} r="4" fill="var(--color-brand-secondary)" stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
        {/* Invisible hover strips — hit targets far bigger than the 2px line. */}
        {points.map((_, i) => (
          <rect key={i} x={x(i) - (W - PAD * 2) / (points.length - 1) / 2} y="0" width={(W - PAD * 2) / (points.length - 1)} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
    </div>
  );
}
