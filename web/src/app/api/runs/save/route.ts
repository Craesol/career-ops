import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  id?: string;
  title?: string;
  subtitle?: string;
  page?: string;
  input?: string;
  result?: { score: number | null; summary: string };
  steps?: { kind: string; label: string }[];
  output?: string;
};

// Persist a finished worker's log as markdown under a web-managed dir so the CLI
// assistant can read past runs ("what did we find on that Anthropic role?").
export async function POST(req: Request) {
  let b: Body;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const dir = path.join(careerOpsRoot(), ".career-ops-web", "runs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return NextResponse.json({ error: "mkdir failed" }, { status: 500 });
  }
  const safeId = String(b.id).replace(/[^a-z0-9_-]/gi, "");
  const steps = (b.steps ?? []).map((s) => `- ${s.kind === "tool" ? `🔧 ${s.label}` : s.label}`).join("\n");
  const verdict = b.result?.score != null ? `${b.result.score}/5 — ${b.result.summary || ""}` : "—";
  const md = `# Web run · ${b.title || b.id}

- id: ${b.id}
- page: ${b.page || "-"}
- input: ${b.input || "-"}
- verdict: ${verdict}

## Steps
${steps}

## Output
${b.output || ""}
`;
  try {
    fs.writeFileSync(path.join(dir, `${safeId}.md`), md);
    // Structured twin (2026-09-14): the jobs page falls back to this record
    // when the live worker is gone from the browser store (page reload,
    // different browser/device, 40-entry cap). The .md stays the
    // human/CLI-readable form; the .json is the lossless one.
    fs.writeFileSync(path.join(dir, `${safeId}.json`), JSON.stringify(b));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

// GET /api/runs/save?id=job-… — read a persisted run back. Prefers the
// structured .json; parses the legacy .md for runs saved before the twin
// existed. 404 when neither exists (the run finished in another browser
// before saving, or never finished).
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  const safeId = id.replace(/[^a-z0-9_-]/gi, "");
  if (!safeId) return NextResponse.json({ found: false }, { status: 400 });
  const dir = path.join(careerOpsRoot(), ".career-ops-web", "runs");

  const jsonPath = path.join(dir, `${safeId}.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      const b = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Body;
      return NextResponse.json({ found: true, record: b });
    } catch {
      /* fall through to the .md */
    }
  }

  const mdPath = path.join(dir, `${safeId}.md`);
  if (!fs.existsSync(mdPath)) return NextResponse.json({ found: false }, { status: 404 });
  try {
    const text = fs.readFileSync(mdPath, "utf8");
    const grab = (label: string) => new RegExp(`^- ${label}: (.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
    const title = /^# Web run · (.*)$/m.exec(text)?.[1]?.trim() ?? safeId;
    const stepsBlock = /## Steps\r?\n([\s\S]*?)\r?\n## Output/.exec(text)?.[1] ?? "";
    const steps = stepsBlock
      .split(/\r?\n/)
      .filter((l) => l.startsWith("- "))
      .map((l) => {
        const raw = l.slice(2);
        return raw.startsWith("🔧 ") ? { kind: "tool", label: raw.slice(3) } : { kind: "status", label: raw };
      });
    const output = /## Output\r?\n([\s\S]*)$/.exec(text)?.[1]?.trim() ?? "";
    const verdictRaw = grab("verdict");
    const vm = /^([0-9.]+)\/5(?: — (.*))?$/.exec(verdictRaw);
    const result = vm ? { score: Number(vm[1]), summary: vm[2] || "" } : undefined;
    const record: Body = { id: safeId, title, page: grab("page"), input: grab("input"), result, steps, output };
    return NextResponse.json({ found: true, record });
  } catch {
    return NextResponse.json({ found: false }, { status: 500 });
  }
}
