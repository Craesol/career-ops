import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { addOffersToPipeline } from "@/lib/core/pipeline";
import { careerOpsRoot } from "@/lib/career-ops";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HALLUCINATION GATE (2026-07-26). AI-proposed offers are model output, and a
// model can invent a plausible-looking posting URL — observed live: Antigravity
// returned boards.greenhouse.io/akuity/jobs/40123456, whose ATS API answers 404.
// Such a URL renders as a generic 200 page, so an HTTP check is NOT enough.
// Before anything reaches the pipeline we ask the core's own ATS API checker;
// a DEFINITIVE "expired" is the only verdict that blocks (uncertain passes —
// a missed real job costs more than a scanned-and-skipped one). Zero tokens.
async function dropHallucinated(offers: DiscoveredOffer[]): Promise<{ kept: DiscoveredOffer[]; rejected: string[] }> {
  const aiOffers = offers.filter((o) => o.source === "ai-search");
  if (aiOffers.length === 0) return { kept: offers, rejected: [] };

  const mod = path.join(careerOpsRoot(), "liveness-api.mjs");
  if (!fs.existsSync(mod)) return { kept: offers, rejected: [] };

  // The checker runs in a CHILD node process, like the pipeline writers do:
  // Next's bundler rejects a computed `import()` ("module expression is too
  // dynamic"), and a child also keeps the checker's network work off the
  // request thread. It answers { result: 'expired' | ... }.
  const code = `
import { checkLivenessViaApi, isAtsPosting } from ${JSON.stringify(pathToFileURL(mod).href)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => { input += d; });
process.stdin.on("end", async () => {
  const urls = JSON.parse(input);
  const dead = [];
  await Promise.all(urls.map(async (u) => {
    if (!isAtsPosting(u)) return;
    try { const r = await checkLivenessViaApi(u); if (r && r.result === "expired") dead.push(u); }
    catch { /* checker failure must never block a real posting */ }
  }));
  process.stdout.write(JSON.stringify(dead));
});
`;
  const urls = aiOffers.map((o) => o.url);
  const dead: string[] = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: careerOpsRoot(), env: process.env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      // Same banner hazard as the writers: take the trailing JSON value only.
      const m = out.trim().match(/(\[[\s\S]*\])\s*$/);
      try {
        const parsed = m ? JSON.parse(m[1]) : [];
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
    setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, 45_000);
    child.stdin.write(JSON.stringify(urls));
    child.stdin.end();
  });

  const deadSet = new Set(dead);
  return { kept: offers.filter((o) => !deadSet.has(o.url)), rejected: dead };
}

// Free + reversible: append chosen discovered offers to data/pipeline.md AND
// record them in data/scan-history.tsv, via the core's CANONICAL exported writers
// (no parallel writer). No tokens spent.
export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[] };
    offers = Array.isArray(body.offers) ? body.offers : [];
  } catch {
    return Response.json({ added: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ added: 0 });

  const { kept, rejected } = await dropHallucinated(offers);
  if (kept.length === 0) {
    return Response.json({ added: 0, rejected: rejected.length, error: "every proposed posting failed the ATS liveness check (likely invented URLs)" });
  }
  const result = await addOffersToPipeline(kept);
  return Response.json({ ...result, rejected: rejected.length });
}
