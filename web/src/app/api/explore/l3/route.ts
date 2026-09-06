import { spawn } from "node:child_process";
import fs from "node:fs";
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
  let body: { cliId?: string; maxQueries?: number };
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
    "Run each web search below (WebSearch). For every plausible job posting you find, emit ONE line, never inside a code fence:",
    '<<offer:{"url":"…","title":"…","company":"…","location":"…","portal":"…"}>>',
    'Rules: valid JSON per line; "portal" is the source label from the query name; include the DIRECT posting URL, not a search page; skip aggregator/search-result URLs; no commentary between envelopes is required.',
    "Be broad: community, program, ecosystem, social-media and creator-program roles. Do not judge fit or score anything.",
    "PRIORITIZE REMOTE: the candidate is based on the French Riviera and works remote-first. Emit remote / worldwide / EMEA / Europe-eligible postings first, and skip roles that are onsite-only outside Europe. A remote role anchored to a non-European HQ is fine — say so in \"location\".",
    "",
    "SEARCHES:",
    ...queries.map((q, i) => `${i + 1}. [${q.name}] ${q.query}`),
  ].join("\n");

  const isClaude = cliId === "claude";
  const args = isClaude
    ? ["-p", prompt, "--allowedTools", "WebSearch,WebFetch", "--disallowedTools", "Task,Bash,Write,Edit,NotebookEdit"]
    : spec.args(prompt);

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
      const child = spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
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
        const code2 = `
import { readFileSync } from 'node:fs';
import { appendToPipeline, appendToScanHistory, buildTitleFilter, buildLocationFilter } from ${JSON.stringify(scanUrl)};
import { w3cStaleFilter } from ${JSON.stringify(pruneUrl)};
import * as yaml from 'js-yaml';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
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
    const rejected = { dup: 0, title: 0, location: 0, stale: 0 };
    for (const o of offers) {
      const k = hist.get(o.url);
      if (k) { rejected.dup++; knownOut.push({ ...o, knownSince: k.date, knownStatus: k.status }); continue; }
      if (stale.isStale(o.url)) { rejected.stale++; filteredOut.push({ ...o, filteredBy: 'stale' }); continue; }
      if (!tf(o.title)) { rejected.title++; filteredOut.push({ ...o, filteredBy: 'title' }); continue; }
      if (!lf(o.location, o.url, o.title)) { rejected.location++; filteredOut.push({ ...o, filteredBy: 'location' }); continue; }
      fresh.push(o);
    }
    if (fresh.length) {
      appendToPipeline(fresh);
      appendToScanHistory(fresh, ${JSON.stringify(today)}, 'added');
    }
    process.stdout.write(JSON.stringify({ added: fresh.length, rejected, offers: fresh, known: knownOut.slice(0, 40), filtered: filteredOut.slice(0, 40) }));
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
