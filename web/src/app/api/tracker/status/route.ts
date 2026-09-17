import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readApplications } from "@/lib/career-ops";
import { matchOfferToApplication } from "@/lib/explore";

// Mark a tracker row Applied / Discarded from an offer card. The web resolves
// WHICH row (explicit `row` from the explore join, else the same fuzzy
// company+title match explorer-view uses to badge a card as evaluated), but
// the WRITE goes through the core's canonical path — set-status.mjs --row N —
// which validates the state against states.yml, takes the shared tracker lock,
// writes atomically, and on Applied also seeds data/follow-ups.md. The web
// never edits the tracker table itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STATES = new Set(["Applied", "Discarded"]);

// Same normalization merge-tracker uses for its URL dedup key: tracking params,
// fragment and trailing slash dropped, host lowercased.
function normUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|ref|refid|trackingid|gh_src|source|src)$/i.test(k) || /^utm_/i.test(k)) x.searchParams.delete(k);
    }
    return (x.origin.toLowerCase() + x.pathname.replace(/\/+$/, "") + (x.searchParams.toString() ? "?" + x.searchParams.toString() : "")).toLowerCase();
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/, "");
  }
}

// Deterministic resolution (2026-09-18): every report carries the posting in
// its `**URL:**` header, and the tracker row links the report by number. So
// the offer URL → report file → row #, with no name matching at all — this is
// what closed the "horizon3ai" (scanner slug) vs "Horizon3" (tracker name)
// miss. Only the first 3KB of each report is read (the header is at the top).
function rowByPostingUrl(url: string): string | null {
  const want = normUrl(url);
  if (!want) return null;
  const dir = path.join(careerOpsRoot(), "reports");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{1,5}-.*\.md$/.test(f));
  } catch {
    return null;
  }
  const hits: number[] = [];
  for (const f of files) {
    let head = "";
    try {
      const fd = fs.openSync(path.join(dir, f), "r");
      const buf = Buffer.alloc(3072);
      const n = fs.readSync(fd, buf, 0, 3072, 0);
      fs.closeSync(fd);
      head = buf.toString("utf8", 0, n);
    } catch {
      continue;
    }
    const m = /\*\*URL:\*\*\s*(\S+)/.exec(head);
    if (m && normUrl(m[1]) === want) hits.push(parseInt(f, 10));
  }
  if (!hits.length) return null;
  // Newest report wins (a re-evaluation supersedes an older one).
  const num = Math.max(...hits);
  const apps = readApplications();
  const row = apps.find((a) => new RegExp(`[\\[(/]0*${num}(?:[\\])]|-)`).test(a.report)) ?? apps.find((a) => a.n === String(num));
  return row && /^\d{1,5}$/.test(row.n) ? row.n : null;
}

function resolveRow(body: { row?: unknown; company?: unknown; title?: unknown; url?: unknown }): string | null {
  if (typeof body.row === "string" && /^\d{1,5}$/.test(body.row)) return body.row;
  if (typeof body.url === "string" && /^https?:\/\//i.test(body.url)) {
    const byUrl = rowByPostingUrl(body.url);
    if (byUrl) return byUrl;
  }
  const hit = matchOfferToApplication(readApplications(), String(body.company ?? ""), String(body.title ?? ""));
  return hit && /^\d{1,5}$/.test(hit.n) ? hit.n : null;
}

export async function POST(req: Request) {
  let body: { row?: unknown; company?: unknown; title?: unknown; url?: unknown; state?: unknown; note?: unknown; dryRun?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const state = String(body.state ?? "");
  if (!ALLOWED_STATES.has(state)) {
    return Response.json({ ok: false, error: `state must be one of: ${[...ALLOWED_STATES].join(", ")}` }, { status: 400 });
  }
  const row = resolveRow(body);
  if (!row) {
    return Response.json(
      { ok: false, error: "No tracker row found for this offer yet — the evaluation may still be persisting. Refresh and try again." },
      { status: 404 },
    );
  }
  const note = typeof body.note === "string" ? body.note.replace(/[\r\n\t|]+/g, " ").trim().slice(0, 200) : "";

  const args = [path.join(careerOpsRoot(), "set-status.mjs"), "--row", row, state, "--json"];
  if (note) args.push("--note", note);
  // dryRun: full resolution + validation through set-status, zero writes —
  // exists so the wiring can be exercised without touching the tracker.
  if (body.dryRun === true) args.push("--dry-run");

  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: careerOpsRoot(), env: process.env });
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 30_000);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(killer);
      resolvePromise({ code: -1, out, err: String(e.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolvePromise({ code, out, err });
    });
  });

  // set-status --json pretty-prints one multi-line JSON object; banners can
  // precede it, so parse from the first "{" to the last "}".
  let parsed: Record<string, unknown> | null = null;
  const start = result.out.indexOf("{");
  const end = result.out.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(result.out.slice(start, end + 1));
    } catch {
      /* non-JSON output — exit code still decides success below */
    }
  }
  if (result.code !== 0) {
    const detail = (result.err || result.out).trim().slice(-300) || `exit ${result.code}`;
    // 4 = tracker lock busy — retryable; everything else is a real failure.
    const status = result.code === 4 ? 503 : 500;
    return Response.json({ ok: false, row, state, error: detail }, { status });
  }
  return Response.json({ ok: true, row, state, ...(body.dryRun === true ? { dryRun: true } : {}), result: parsed });
}
