"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Globe, Sparkles } from "lucide-react";
import { CostBadge } from "@/components/cost/cost-badge";

const EXAMPLES = [
  "AI infra roles at climate startups, remote EU",
  "Forward-deployed engineer at Series A devtools, US-remote",
  "Head of Applied AI at healthtech, posted this week",
];

// The "magic" natural-language box: a soft contained halo at rest that intensifies
// on focus (erupts into the full-viewport hunt on submit). Effect CSS co-located
// per the Tailwind v4 stale-CSS HMR gotcha.
const STYLE = `
.co-aibox{position:relative;border-radius:1.1rem;border:1px solid var(--co-border,hsl(0 0% 50% /.22));background:color-mix(in srgb, var(--bg) 55%, transparent);transition:border-color .3s,box-shadow .3s}
.co-aibox::before{content:"";position:absolute;inset:-1px;border-radius:1.1rem;padding:1px;background:radial-gradient(70% 140% at 28% -10%, hsl(268 82% 55% /.45), transparent 62%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.45;transition:opacity .3s;pointer-events:none}
.co-aibox:focus-within::before{opacity:1}
.co-aibox:focus-within{border-color:hsl(268 73% 51% /.5);box-shadow:0 0 0 4px hsl(268 73% 51% /.09)}
.co-aibox textarea{width:100%;resize:none;background:transparent;border:none;outline:none;font-size:16px;line-height:1.5;color:inherit}
.co-aibox textarea::placeholder{color:var(--co-faint,hsl(0 0% 58%))}
@media(prefers-reduced-motion:reduce){.co-aibox,.co-aibox::before{transition:none}}
`;

export function AiSearchBox({
  intent,
  onIntent,
  onSubmit,
  cliConfigured,
  cliName,
  onRunScan,
}: {
  intent: string;
  onIntent: (s: string) => void;
  onSubmit: () => void;
  cliConfigured: boolean;
  cliName?: string;
  onRunScan: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // The user's configured hunting grounds (portals.yml search_queries) — shown
  // as one-tap source chips so every portal the AI hunt can reach is VISIBLE,
  // not just the 4 free-API ATS engines the deterministic Scan lists.
  const [sources, setSources] = useState<{ portal: string; example: string; kind?: "board" | "query" }[]>([]);
  useEffect(() => {
    fetch("/api/portals")
      .then((r) => r.json())
      .then((d) => setSources(Array.isArray(d.sources) ? d.sources : []))
      .catch(() => {});
  }, []);
  const grow = () => {
    const t = ref.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
    }
  };

  return (
    <div>
      <style>{STYLE}</style>
      <div className="co-aibox p-4">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-brand">
          <Sparkles className="size-3.5" /> Describe the role — an AI hunts the open web for it
        </div>
        <textarea
          ref={ref}
          rows={2}
          value={intent}
          onChange={(e) => {
            onIntent(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (intent.trim()) onSubmit();
            }
          }}
          placeholder="“AI infra at climate startups, remote EU, not staff-level” — plain language, your words"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            {cliConfigured ? (
              <>
                Reads the public web with <span className="text-foreground">{cliName || "your CLI"}</span> — it costs your tokens.
              </>
            ) : (
              "Connect an AI CLI in Config to use AI search."
            )}
          </span>
          <button
            type="button"
            disabled={!intent.trim()}
            onClick={onSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-50"
          >
            Search the open web
            <CostBadge kind="spend" size="xs" />
            <ArrowRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onIntent(ex)}
            className="rounded-full border border-border bg-surface/40 px-3 py-1.5 text-[12px] text-muted transition hover:border-brand/40 hover:text-brand"
          >
            {ex}
          </button>
        ))}
        <button type="button" onClick={onRunScan} className="ml-auto inline-flex items-center gap-1 text-[12px] text-faint transition hover:text-foreground">
          or run the free Scan instead →
        </button>
      </div>

      {sources.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            <Globe className="size-3" /> Your sources · tap to hunt one
            <span className="ml-1 font-normal normal-case tracking-normal text-faint">
              — <span className="text-emerald-600 dark:text-emerald-400">green</span> boards are scanned free every day
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => (
              <button
                key={s.portal}
                type="button"
                title={s.kind === "board" ? `${s.example} — scanned free by the daily run` : s.example}
                onClick={() => onIntent(`Search ${s.portal} for roles matching my target profile, remote`)}
                className={
                  s.kind === "board"
                    ? "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 transition hover:border-emerald-500/60 dark:text-emerald-400"
                    : "rounded-full border border-brand/25 bg-brand-soft/30 px-2.5 py-1 text-[11px] font-medium text-brand-text transition hover:border-brand/50 hover:bg-brand-soft"
                }
              >
                {s.portal}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
