import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Merge-safe writer for portals.yml's title_filter (a USER-LAYER file). Replaces
// ONLY title_filter.positive (the role keywords the free scanner matches), seeding
// from templates/portals.example.yml on first create, and PRESERVING tracked_companies
// + every other block. Atomic write, confirm-gated (setProfile/setPortals). This is
// what loads the very first home scan once the user confirms their target roles.

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// GET → the user's configured hunting grounds, so Explore can show EVERY source,
// not just the 4 free-API ATS engines the in-web scan reaches. Two kinds:
//   - "board": portals.yml job_boards — scanned FREE by the CLI's provider layer
//     (scan.mjs) on the daily run; no tokens.
//   - "query": enabled search_queries — reachable via the AI hunt / L3 sweep.
// Deduped by portal label (a name's "Portal — topic" prefix); boards win, since
// a free source beats a token-spending one when both exist for the same portal.
export async function GET() {
  try {
    const doc = (yaml.load(fs.readFileSync(path.join(careerOpsRoot(), "portals.yml"), "utf8")) as Record<string, unknown>) || {};
    const seen = new Set<string>();
    const sources: { portal: string; example: string; kind: "board" | "query" }[] = [];

    const push = (rawName: string, kind: "board" | "query", example: string) => {
      const portal = (rawName.split(/\s+—|\s+--|\s+-\s/)[0] || rawName).trim();
      if (!portal || seen.has(portal.toLowerCase())) return;
      seen.add(portal.toLowerCase());
      sources.push({ portal, example, kind });
    };

    const boards = Array.isArray(doc.job_boards) ? (doc.job_boards as Array<Record<string, unknown>>) : [];
    for (const b of boards) {
      if (b.enabled === false) continue;
      const name = String(b.name || "").trim();
      if (name) push(name, "board", String(b.notes || name));
    }

    const queries = Array.isArray(doc.search_queries) ? (doc.search_queries as Array<Record<string, unknown>>) : [];
    for (const q of queries) {
      if (q.enabled === false) continue;
      const name = String(q.name || "").trim();
      if (name) push(name, "query", name);
    }

    return Response.json({ sources });
  } catch {
    return Response.json({ sources: [] });
  }
}

export async function POST(req: Request) {
  let body: { roles?: string[]; location?: string[] };
  try {
    body = (await req.json()) as { roles?: string[]; location?: string[] };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const roles = (Array.isArray(body.roles) ? body.roles : []).map((r) => String(r).trim()).filter(Boolean).slice(0, 24);
  if (roles.length === 0) return Response.json({ error: "no roles" }, { status: 400 });

  const root = careerOpsRoot();
  const file = path.join(root, "portals.yml");
  let doc: Record<string, unknown> = {};
  try {
    doc = (yaml.load(fs.readFileSync(file, "utf8")) as Record<string, unknown>) || {};
  } catch {
    try {
      doc = (yaml.load(fs.readFileSync(path.join(root, "templates", "portals.example.yml"), "utf8")) as Record<string, unknown>) || {};
    } catch {
      doc = {};
    }
  }

  const tf = isObj(doc.title_filter) ? { ...doc.title_filter } : {};
  tf.positive = roles; // replace ONLY the positive keywords; keep negative/etc.
  doc.title_filter = tf;
  if (Array.isArray(body.location) && body.location.length) {
    const lf = isObj(doc.location_filter) ? { ...doc.location_filter } : {};
    lf.allow = body.location.map((l) => String(l).trim()).filter(Boolean);
    doc.location_filter = lf;
  }

  try {
    atomicWriteWithBackup(file, yaml.dump(doc, { lineWidth: 100, noRefs: true }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
  return Response.json({ ok: true, roles: roles.length });
}
