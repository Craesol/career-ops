import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";

// Deep scan — the WEB twin of the desktop nightly's L3 step (daily-consolidated
// step 3): the SAME portals.yml search playbook, the same proposer/writer split,
// the same canonical filters, and the same persistence. The CLI only SEARCHES
// and emits <<offer:{...}>> envelopes; THIS route parses them and persists
// through a node subprocess that imports the core's own scan.mjs writers and
// filters — the web never re-implements that logic.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(req: Request) {
  let body: { cliId?: string; maxQueries?: number; model?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const cliId = body.cliId;
  if (!cliId) return Response.json({ error: "cliId required" }, { status: 400 });
  const resolved = resolveCli(cliId);
  if (!resolved) return Response.json({ error: `CLI '${cliId}' not found on this machine` }, { status: 404 });
  const { spec, binPath } = resolved;

  // The user's playbook — parsed with js-yaml (NEVER regex; see the 2026-08-26
  // inliner bug where a YAML re-dump silently starved L3 down to 2 queries).
  let queries: { name: string; query: string }[] = [];
  try {
    const doc = (yaml.load(fs.readFileSync(path.join(careerOpsRoot(), "portals.yml"), "utf8")) as Record<string, unknown>) || {};
    for (const q of (Array.isArray(doc.search_queries) ? doc.search_queries : []) as Array<Record<string, unknown>>) {
      if (q && typeof q.name === "string" && typeof q.query === "string" && q.enabled !== false) {
        queries.push({ name: q.name.trim(), query: String(q.query).replace(/\s+/g, " ").trim() });
      }
    }
  } catch {
    return Response.json({ error: "portals.yml unreadable — the deep scan needs the search playbook" }, { status: 400 });
  }
  if (!queries.length) return Response.json({ error: "no enabled search_queries in portals.yml" }, { status: 400 });
  const cap = Math.max(1, Math.min(queries.length, Number(body.maxQueries) || queries.length));
  queries = queries.slice(0, cap);

  const today = new Date().toISOString().slice(0, 10);
  // Same prompt shape as daily-consolidated's L3 (proposer contract).
  const prompt = [
    "You are a job-posting FINDER running headless. Today is " + today + ".",
    "Context: you are the sanctioned L3 proposer of this machine's own job-search pipeline, launched locally by its web UI on the owner's designated scanning machine. Your ENTIRE task is emitting <<offer>> envelopes on stdout — you write no files, touch no tracker, send nothing.",
    "Run each web search below (WebSearch). For every plausible job posting you find, emit ONE line, never inside a code fence:",
    '<<offer:{"url":"…","title":"…","company":"…","location":"…","portal":"…"}>>',
    'Rules: valid JSON per line; "portal" is the source label from the query name; include the DIRECT posting URL, not a search page; skip aggregator/search-result URLs; no commentary between envelopes is required.',
    "Be broad: community, program, ecosystem, social-media and creator-program roles. Do not judge fit or score anything.",
    "PRIORITIZE REMOTE: the candidate is based on the French Riviera and works remote-first. Emit remote / worldwide / EMEA / Europe-eligible postings first, and skip roles that are onsite-only outside Europe. A remote role anchored to a non-European HQ is fine — say so in \"location\".",
    "FRESHNESS IS MANDATORY: search indexes keep dead job pages for years. Skip any result whose snippet or page shows a posting date older than ~45 days. NEVER emit a linkedin.com/jobs/view/ URL whose numeric job id is below 4300000000 — those are years-old dead pages that search engines still index.",
    "",
    "SEARCHES:",
    ...queries.map((q, i) => `${i + 1}. [${q.name}] ${q.query}`),
  ].join("\n");

  const isClaude = cliId === "claude";
  const args = isClaude
    ? ["-p", prompt, "--allowedTools", "WebSearch,WebFetch", "--disallowedTools", "Task,Bash,Write,Edit,NotebookEdit"]
    : spec.args(prompt);
  // Optional model override (claude only) — the hourly deep scan runs on a
  // cheaper model than an interactive deep scan; strict charset, never shell-built.
  if (isClaude && typeof body.model === "string" && /^[\w.-]{1,64}$/.test(body.model)) {
    args.push("--model", body.model);
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };

      send({ kind: "start", queries: queries.length });
      // cwd OUTSIDE the repo on purpose: the proposer needs zero project file
      // access (queries are inlined above), and a CLI started inside the repo
      // loads AGENTS.md — where smaller models have misread the "Remote
      // sessions: do not scan" rule as applying to this sanctioned local job
      // and refused to search (2026-09-08, sonnet). The writer subprocess
      // below still runs with cwd = repo root, unchanged.
      const child = spawn(binPath, args, { cwd: os.homedir(), env: process.env });
      const killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 840_000);

      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        send({ kind: "progress", chars: out.length });
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        if (/error|denied|fatal|authenticate/i.test(s)) send({ kind: "log", line: s.trim().slice(0, 200) });
      });
      child.on("error", (e) => {
        send({ kind: "error", message: `launching ${spec.name}: ${e.message}` });
        clearTimeout(killer);
        finish();
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        // Parse the proposer's envelopes.
        const proposed: Record<string, string>[] = [];
        for (const m of out.matchAll(/<<offer:(\{[\s\S]*?\})>>/g)) {
          try {
            const o = JSON.parse(m[1]);
            if (typeof o.url === "string" && /^https?:\/\//i.test(o.url) && o.title) {
              proposed.push({
                url: o.url.trim(),
                company: String(o.company || "").trim() || "?",
                title: String(o.title || "").trim(),
                location: String(o.location || "").trim(),
                source: "websearch:" + (String(o.portal || "l3").toLowerCase().replace(/[^a-z0-9]+/g, "") || "l3"),
                note: "",
              });
            }
          } catch {
            /* malformed envelope */
          }
        }
        send({ kind: "proposed", count: proposed.length, cliExit: code ?? -1 });
        if (!proposed.length) {
          send({ kind: "done", cliExit: code ?? -1, added: 0, proposed: 0, rejected: { dup: 0, title: 0, location: 0, stale: 0 }, known: [], filtered: [] });
          finish();
          return;
        }

        // Persist through the CORE's own filters + writers (subprocess, same
        // pattern as core/pipeline.ts — the web never owns a parallel copy).
        const scanUrl = pathToFileURL(path.join(careerOpsRoot(), "scan.mjs")).href;
        const pruneUrl = pathToFileURL(path.join(careerOpsRoot(), "prune-stale-web3career.mjs")).href;
        const liStaleUrl = pathToFileURL(path.join(careerOpsRoot(), "lib", "linkedin-stale.mjs")).href;
        const livenessApiUrl = pathToFileURL(path.join(careerOpsRoot(), "liveness-api.mjs")).href;
        const freshnessUrl = pathToFileURL(path.join(careerOpsRoot(), "lib", "posting-freshness.mjs")).href;
        const code2 = `
import { readFileSync } from 'node:fs';
import { appendToPipeline, appendToScanHistory, buildTitleFilter, buildLocationFilter } from ${JSON.stringify(scanUrl)};
import { w3cStaleFilter } from ${JSON.stringify(pruneUrl)};
import { isStaleLinkedInJobUrl } from ${JSON.stringify(liStaleUrl)};
import * as yaml from 'js-yaml';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const offers = JSON.parse(input);
    const cfg = yaml.load(readFileSync('portals.yml', 'utf8'));
    const tf = buildTitleFilter(cfg.title_filter);
    const lf = buildLocationFilter(cfg.location_filter);
    const stale = w3cStaleFilter();
    // url → {date, status} from scan-history (cols: url, date, query, title, portal, status).
    // Known finds are RETURNED, not swallowed — the UI shows them with their real
    // status instead of an empty pane ("it found 25 things you already have" ≠ "it found nothing").
    const hist = new Map();
    for (const l of readFileSync('data/scan-history.tsv', 'utf8').split('\\n')) {
      const c = l.split('\\t');
      if (c[0]) hist.set(c[0], { date: c[1] || '', status: (c[5] || '').trim() });
    }
    const fresh = [];
    const knownOut = [];
    const filteredOut = [];
    const idStale = [];
    const rejected = { dup: 0, title: 0, location: 0, stale: 0, expired: 0 };
    for (const o of offers) {
      const k = hist.get(o.url);
      if (k) { rejected.dup++; knownOut.push({ ...o, knownSince: k.date, knownStatus: k.status }); continue; }
      if (stale.isStale(o.url)) { rejected.stale++; filteredOut.push({ ...o, filteredBy: 'stale' }); continue; }
      // Sequential-ID floor: a LinkedIn job id below the cutoff is months-to-years
      // old (a 2021 posting reached fresh-matches on 2026-09-08 this way). Persisted
      // as 'skipped' so dedup blocks every future re-proposal of the same URL.
      if (isStaleLinkedInJobUrl(o.url)) { rejected.stale++; idStale.push(o); filteredOut.push({ ...o, filteredBy: 'stale' }); continue; }
      if (!tf(o.title)) { rejected.title++; filteredOut.push({ ...o, filteredBy: 'title' }); continue; }
      if (!lf(o.location, o.url, o.title)) { rejected.location++; filteredOut.push({ ...o, filteredBy: 'location' }); continue; }
      fresh.push(o);
    }
    // Proof-of-freshness policy (2026-09-09, after two zombie incidents in two
    // days): an L3 find ENTERS only when something DATES it — the ATS API says
    // active, or the page itself proves recency (LinkedIn sequential id,
    // JSON-LD datePosted within 45d and no past validThrough/deadline).
    // 'unknown' is dropped as unproven — recall traded for precision on
    // purpose: real fresh postings also arrive via the API scanners, feeds
    // and ats-full, which all carry dates. Heuristic browser liveness is gone
    // from this path: it read a page with a 2023 deadline as alive. Unproven
    // finds are NOT persisted, so they stay visible in the UI's filtered list
    // (reason 'unverified') where a human can rescue one that matters.
    let liveFresh = fresh;
    const deadFinds = [];
    let gateError = null;
    if (fresh.length) {
      liveFresh = [];
      try {
        const { checkLivenessViaApi } = await import(${JSON.stringify(livenessApiUrl)});
        const { assessPostingFreshness } = await import(${JSON.stringify(freshnessUrl)});
        for (const o of fresh) {
          let outcome = 'unproven';
          let why = '';
          try {
            const api = await checkLivenessViaApi(o.url);
            if (api && api.result === 'expired') { outcome = 'dead'; why = 'ats api: expired'; }
            else if (api && api.result === 'active') { outcome = 'pass'; why = 'ats api: active'; }
            else {
              const f = await assessPostingFreshness(o.url);
              if (f.verdict === 'fresh') { outcome = 'pass'; why = f.reason; }
              else if (f.verdict === 'expired' || f.verdict === 'stale') { outcome = 'dead'; why = f.reason; }
              else { outcome = 'unproven'; why = f.reason; }
            }
          } catch (e) {
            outcome = 'unproven';
            why = 'freshness check failed: ' + String((e && e.message) || e);
          }
          if (outcome === 'pass') {
            o.note = (o.note ? o.note + ' · ' : '') + why;
            liveFresh.push(o);
          } else if (outcome === 'dead') {
            rejected.expired++;
            deadFinds.push(o);
            filteredOut.push({ ...o, filteredBy: 'expired', note: why });
          } else {
            rejected.unverified = (rejected.unverified || 0) + 1;
            filteredOut.push({ ...o, filteredBy: 'unverified', note: why });
          }
        }
      } catch (e) {
        gateError = String((e && e.message) || e);
        liveFresh = [];
      }
    }
    if (idStale.length) appendToScanHistory(idStale, ${JSON.stringify(today)}, 'skipped');
    if (deadFinds.length) appendToScanHistory(deadFinds, ${JSON.stringify(today)}, 'skipped_expired');
    if (liveFresh.length) {
      appendToPipeline(liveFresh);
      appendToScanHistory(liveFresh, ${JSON.stringify(today)}, 'added');
    }
    process.stdout.write(JSON.stringify({ added: liveFresh.length, rejected, offers: liveFresh, known: knownOut.slice(0, 40), filtered: filteredOut.slice(0, 40), ...(gateError ? { livenessGateUnavailable: gateError } : {}) }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
});
`;
        const writer = spawn(process.execPath, ["--input-type=module", "-e", code2], { cwd: careerOpsRoot(), env: process.env });
        let wout = "";
        writer.stdout.on("data", (d: Buffer) => (wout += d.toString()));
        writer.on("close", () => {
          let result: { added: number; rejected?: Record<string, number>; offers?: unknown[]; known?: unknown[]; filtered?: unknown[]; error?: string } = { added: 0 };
          // dotenv banners can precede the JSON — take the last parseable line.
          for (const line of wout.split(/\r?\n/).reverse()) {
            const t = line.trim();
            if (!t.startsWith("{")) continue;
            try {
              result = JSON.parse(t);
              break;
            } catch {
              /* keep scanning */
            }
          }
          send({ kind: "done", cliExit: code ?? -1, proposed: proposed.length, added: result.added ?? 0, rejected: result.rejected ?? {}, offers: result.offers ?? [], known: result.known ?? [], filtered: result.filtered ?? [], error: result.error });
          finish();
        });
        writer.on("error", (e) => {
          send({ kind: "error", message: "writer: " + e.message });
          finish();
        });
        writer.stdin.write(JSON.stringify(proposed));
        writer.stdin.end();
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
