import { spawn } from "node:child_process";
import path from "node:path";
import { careerOpsRoot, readApplications } from "@/lib/career-ops";

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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function resolveRow(body: { row?: unknown; company?: unknown; title?: unknown }): string | null {
  if (typeof body.row === "string" && /^\d{1,5}$/.test(body.row)) return body.row;
  const c = norm(String(body.company ?? ""));
  const t = norm(String(body.title ?? ""));
  if (!c) return null;
  const hit = readApplications().find((a) => {
    if (norm(a.company) !== c) return false;
    const ar = norm(a.role);
    return ar.length > 3 && (t.includes(ar) || ar.includes(t.split(" ").slice(0, 3).join(" ")));
  });
  return hit && /^\d{1,5}$/.test(hit.n) ? hit.n : null;
}

export async function POST(req: Request) {
  let body: { row?: unknown; company?: unknown; title?: unknown; state?: unknown; note?: unknown };
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

  // set-status --json prints one JSON object; dotenv banners can precede it.
  let parsed: Record<string, unknown> | null = null;
  for (const line of result.out.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      parsed = JSON.parse(t);
      break;
    } catch {
      /* keep scanning */
    }
  }
  if (result.code !== 0) {
    const detail = (result.err || result.out).trim().slice(-300) || `exit ${result.code}`;
    // 4 = tracker lock busy — retryable; everything else is a real failure.
    const status = result.code === 4 ? 503 : 500;
    return Response.json({ ok: false, row, state, error: detail }, { status });
  }
  return Response.json({ ok: true, row, state, result: parsed });
}
