import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PERSISTENT inbox skip. The triage list's own skip was localStorage-only, so a
// skipped posting reappeared on reload / on another machine. This marks the
// pipeline.md entry done (the CLI's own "processed" convention) and records the
// URL as `skipped` in scan-history so future scans dedup it. Nothing is deleted.
export async function POST(req: Request) {
  let body: { url?: string; undo?: boolean };
  try {
    body = (await req.json()) as { url?: string; undo?: boolean };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const url = (body.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return Response.json({ error: "http(s) url required" }, { status: 400 });
  const undo = body.undo === true;

  const root = careerOpsRoot();
  const pipeline = path.join(root, "data", "pipeline.md");
  let md: string;
  try {
    md = fs.readFileSync(pipeline, "utf8");
  } catch {
    return Response.json({ error: "pipeline.md not found" }, { status: 404 });
  }

  const MARK = " — skipped from inbox";
  let changed = false;
  const lines = md.split("\n").map((raw) => {
    const line = raw.replace(/\r$/, "");
    const cr = raw.endsWith("\r") ? "\r" : "";
    if (changed) return raw;
    if (undo) {
      // Restore ONLY entries this route skipped (the marker is the receipt), so
      // an undo can never resurrect something the CLI or a sweep closed.
      if (!line.startsWith("- [x] ~~") || !line.endsWith(MARK)) return raw;
      const inner = line.slice(8, line.length - MARK.length - 2);
      if (!inner.startsWith(url)) return raw;
      changed = true;
      return `- [ ] ${inner}${cr}`;
    }
    if (!line.startsWith("- [ ] ")) return raw;
    const rest = line.slice(6);
    if (!rest.startsWith(url)) return raw;
    changed = true;
    return `- [x] ~~${rest}~~${MARK}${cr}`;
  });
  if (!changed) {
    return Response.json({ ok: false, error: undo ? "no inbox-skip entry to restore" : "url not pending in pipeline.md" }, { status: 404 });
  }

  try {
    atomicWrite(pipeline, lines.join("\n"));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }

  // Best-effort dedup record — a failure here must not undo the skip above.
  // scan-history is append-only, so an undo appends a `restored` row rather
  // than rewriting history.
  try {
    const history = path.join(root, "data", "scan-history.tsv");
    const today = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(history, [url, today, "inbox-skip", "", "", undo ? "restored" : "skipped", ""].join("\t") + "\n", "utf8");
  } catch {
    /* history is advisory */
  }
  return Response.json({ ok: true });
}
