import { spawn } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pins the FIRST follow-up date for a row that just turned Applied, by running
// the core's own followup-seed.mjs (canonical cadence + format — the web never
// re-implements the schedule). Best-effort: a missing script or a non-zero exit
// must not fail the status change the user actually asked for.
export async function POST(req: Request) {
  let body: { n?: string | number };
  try {
    body = (await req.json()) as { n?: string | number };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const n = String(body.n ?? "").trim();
  if (!/^\d+$/.test(n)) return Response.json({ error: "numeric row n required" }, { status: 400 });

  const script = rootScript("followup-seed");
  if (!fs.existsSync(script)) return Response.json({ ok: false, skipped: "followup-seed.mjs not in this checkout" });

  const result = await new Promise<{ ok: boolean; out: string }>((resolve) => {
    const child = spawn(process.execPath, [script, n], { cwd: careerOpsRoot(), env: process.env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve({ ok: false, out: "spawn failed" }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim().slice(0, 300) }));
    setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, 20_000);
  });

  return Response.json(result);
}
