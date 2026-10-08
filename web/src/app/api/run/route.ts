import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

// The web ORCHESTRATES the real career-ops engine — it does NOT reimplement it.
// kind "evaluate" runs the REAL modes/oferta.md and persists the canonical
// artifacts (A–F report + tracker row) via the SAME scripts the CLI uses
// (reserve-report-num.mjs → reports/ → batch/tracker-additions/ → merge-tracker.mjs),
// so a web evaluation is byte-identical to a CLI one (single source of truth, no
// drift). kind "research" stays read-only. Streams progress as NDJSON events.
function buildPrompt(kind: string, input: string, memory: string, today: string): string {
  const mem = memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "";
  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
  }
  if (kind === "pdf") {
    return `You are generating the user's ATS-optimized, TAILORED CV PDF for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode — follow modes/pdf.md EXACTLY (do not improvise a format).
1. Read modes/pdf.md, cv.md, config/profile.yml, and the evaluation report at reports/${input}-*.md (for the JD keywords + analysis).
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Resolve the template (never hardcode cv-template.html): \`node cv-templates.mjs resolve cv\`.
4. Build the PAYLOAD, gate it, then render — this is modes/pdf.md steps 17–21 and none of it is optional. Let BASE = .career-ops-web/cv-html/cv-{candidate}-{company} (candidate = the profile name in kebab-case):
   a. Write the compact JSON of modes/pdf.md's "JSON Input Schema" to {BASE}.json. Never emit full HTML markup and never escape &/</>/quotes yourself.
   b. \`node cv-title-check.mjs {BASE}.json --summary\` — the only guard against a job TITLE drifting to a more senior-sounding one for the same job; the fact gate cannot see it. "Entries compared: 0" means the gate is checking nothing: STOP and say so instead of reporting its green tick.
   c. \`node verify-cv-structure.mjs {BASE}.json\` — entry order and dropped descriptors. UNVERIFIED is not a pass.
   d. \`node build-cv-html.mjs {BASE}.json {BASE}.html {resolved-template}\`
   e. \`node ats-score.mjs {BASE}.html\` — if the verdict is not "pass", reframe from its gap list (reformulation only, never a new claim) and rebuild from (a); at most two iterations, then proceed and report the score.
   f. \`node generate-pdf.mjs {BASE}.html output/cv-{candidate}-{company}-${today}.pdf --format={letter for US/Canada companies, else a4} --report=${input}\`
   g. KEEP the HTML. modes/_custom.md's PDF-only rule says the intermediate must not live in output/ — .career-ops-web/cv-html/ is gitignored and machine-local, satisfies that, and is what data/pdf-index.tsv points at so the dashboard's D hotkey can regenerate and the CV stays auditable afterwards.
5. Update the tracker: in data/applications.md, change the PDF column for row #${input} from ❌ to ✅.
Do not submit anything anywhere.

End with EXACTLY one final line: VERDICT: {5 if the PDF was written, else 1}/5 — {the output/ path, ≤12 words}`;
  }
  if (kind === "fix-portal") {
    return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine):
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
  }
  if (kind === "evaluate-cv") {
    return `You are running the OFFICIAL career-ops auto-pipeline (evaluation + tailored CV), HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops flow — do NOT improvise your own scoring or CV format.

1. Read modes/oferta.md and follow it EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).

3. Generate the tailored CV (modes/pdf.md, follow it EXACTLY):
   THE USER CLICKED "Create CV" — that IS the explicit user override. Generate the CV REGARDLESS of the evaluation score; report the score and its caveats informationally, never as a reason to skip generation. (Source-of-truth still applies: only claims backed by cv.md — flag gaps, never invent.)
   a. Read modes/pdf.md and modes/_custom.md (if it exists). Tailor the CV: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
   b. Resolve the template — do NOT hardcode cv-template.html: \`node cv-templates.mjs resolve cv\` (add the name as a second argument only if the user named one). A non-zero exit means the configured template is missing: surface that instead of falling back silently.
   c. Build the render PAYLOAD, not markup. Write the compact JSON of modes/pdf.md's "JSON Input Schema" to .career-ops-web/cv-html/cv-{candidate}-{company-slug}.json. You never emit full HTML and never escape &/</>/quotes yourself — build-cv-html.mjs owns every tag, class and escape.
   d. Run the two zero-LLM gates on that payload, in this order, and report what they say:
      - \`node cv-title-check.mjs .career-ops-web/cv-html/cv-{candidate}-{company-slug}.json --summary\` — pairs each payload entry against cv.md's own {company, dates} and flags any job TITLE that drifted to a more senior-sounding one for the same job. The fact gate cannot see this (a title is not a metric), so this is the only guard against it. If "Entries compared" is 0, STOP: the pairing broke and the gate is not actually checking anything — say so rather than proceeding on a green tick.
      - \`node verify-cv-structure.mjs .career-ops-web/cv-html/cv-{candidate}-{company-slug}.json\` — out-of-order experience entries and dropped company descriptors. UNVERIFIED means cv.md's headers are not in the supported shape; report it, do not treat it as a pass.
   e. Build the HTML: \`node build-cv-html.mjs .career-ops-web/cv-html/cv-{candidate}-{company-slug}.json .career-ops-web/cv-html/cv-{candidate}-{company-slug}.html {resolved-template}\`.
   f. Score it before rendering: \`node ats-score.mjs .career-ops-web/cv-html/cv-{candidate}-{company-slug}.html\`. If the verdict is not "pass", reframe using its gap list (reformulation only — never a new claim) and rebuild from step c. At most two iterations, then proceed and report the final score.
   g. Render: \`node generate-pdf.mjs .career-ops-web/cv-html/cv-{candidate}-{company-slug}.html output/cv-{candidate}-{company-slug}-${today}.pdf --format={letter for US/Canada companies, else a4} --report={num}\`.
   h. PDF-only house rule, implemented the way modes/_custom.md actually states it: the HTML is a build intermediate that must not live in output/ — it lives in .career-ops-web/cv-html/ (gitignored, machine-local) and is KEPT. Do not delete it. data/pdf-index.tsv records the PDF↔HTML pair so the dashboard's D hotkey can regenerate, and keeping it is also the only way a finished CV can be re-audited afterwards. Only the .pdf lands in output/ and gets delivered.

4. Register in the tracker (AFTER the PDF exists, so the PDF column is truthful):
   a. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t✅\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   b. Merge: run \`node merge-tracker.mjs\` (NEVER edit applications.md by hand).

5. NEVER submit an application, fill no forms, contact no one. This is evaluation + CV generation ONLY.${mem}

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${input}`;
  }
  // evaluate (default) — run the REAL oferta mode + persist canonically
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/oferta.md and follow it EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.${mem}

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${input}`;
}

export async function POST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId } = body;
  if (!input || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "evaluate-cv": "generate-pdf.mjs", "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs" };
  const required = needsScript[kind];
  if (required && !fs.existsSync(path.join(careerOpsRoot(), required))) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "evaluate-cv" || kind === "pdf") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt(kind, input, readMemory(), today);

  const isClaude = cliId === "claude";
  // Tool scope by kind (comma-separated lists; disallowedTools is the hard
  // guardrail). 'evaluate' runs the REAL mode + persists canonical artifacts →
  // it needs Write + Bash (reserve-report-num / merge-tracker / write the
  // report). 'research' stays read-only. Task (sub-agents) is always blocked
  // (runaway cost). NEVER auto-submits — that is a prompt-level guarantee.
  const tools =
    kind === "evaluate" || kind === "evaluate-cv" || kind === "fix-portal" || kind === "pdf"
      ? { allowed: "Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep", disallowed: "Task,NotebookEdit" }
      : { allowed: "Read,WebFetch,WebSearch,Glob,Grep", disallowed: "Bash,Write,Edit,NotebookEdit,Task" };
  const args = isClaude
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
       "--permission-mode", "acceptEdits",
       "--allowedTools", tools.allowed,
       "--disallowedTools", tools.disallowed]
    : spec.args(prompt);

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const countReports = () => {
    try {
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  const persists = kind === "evaluate" || kind === "evaluate-cv";
  const reportsBefore = persists ? countReports() : 0;
  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = kind === "evaluate" || kind === "evaluate-cv" || kind === "pdf" ? acquireTrackerWrite() : null;

  const child = spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  const enc = new TextEncoder();

  // `closed` + kill timer in the OUTER scope so cancel() (client disconnect) can
  // flip `closed` before the child's late handlers run, and send() is try/catch'd —
  // otherwise a late enqueue onto a closed controller throws uncaught (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emittedText = false; // any assistant text delta → the CLI actually ran
      let sawError = false;
      let lastTokens = 0; // per-run token cost from the Claude result event (#6) — local only
      let lastCostUsd: number | null = null;
      // pdf-mode tailors a full CV + renders it — give it more headroom.
      const killMs = kind === "pdf" || kind === "evaluate-cv" ? 720_000 : 285_000;
      killer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, killMs);
      const send = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch { closed = true; }
      };
      const close = () => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          if (writeToken !== null) releaseTrackerWrite(writeToken);
          try { controller.close(); } catch { /* */ }
        }
      };

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;
        if (!isClaude) {
          emittedText = true;
          send({ type: "text", text: d.toString() });
          return;
        }
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stream_event") {
              const e = ev.event;
              if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
                send({ type: "tool", name: e.content_block.name });
              } else if (e?.type === "content_block_delta" && e.delta?.text) {
                emittedText = true;
                send({ type: "text", text: e.delta.text });
              }
            } else if (ev.type === "system" && ev.subtype === "init") {
              send({ type: "status", label: "Agent ready" });
            } else if (ev.type === "result") {
              // Capture the per-run cost; the authoritative "done" is sent on close
              // (so the honesty gate decides done-vs-error first). Tokens = the same
              // formula /api/usage uses: input + output + cache-creation.
              const u = ev.usage || {};
              lastTokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
              if (typeof ev.total_cost_usd === "number") lastCostUsd = ev.total_cost_usd;
            }
          } catch {
            /* partial line */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        // Widened: auth/login/quota failures are the most common real error and
        // the old narrow regex missed them (silent false "success").
        if (/error|denied|fatal|not found|unauthorized|forbidden|auth|login|credential|api[ -]?key|quota|rate limit|not authenticated/i.test(s)) {
          sawError = true;
          send({ type: "error", msg: s.trim().slice(0, 200) });
        }
      });
      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });
      child.on("close", (code) => {
        const wroteReport = countReports() > reportsBefore;
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score.
        if (!emittedText && !sawError && !cleanExit) {
          send({ type: "error", msg: "The CLI exited with an error — is it installed and authenticated?" });
        } else if (!emittedText && !sawError) {
          send({ type: "error", msg: "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)" });
        } else if (persists && !wroteReport) {
          // The worker ran but never wrote the report/tracker row (e.g. a CLI
          // without file-write authorization) — surface it instead of a fake score.
          send({ type: "error", msg: "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code." });
        } else if (!cleanExit || sawError) {
          // Produced output (maybe even a report) but did NOT finish cleanly — flag it
          // instead of recording a confident score off a half-finished run.
          send({ type: "error", msg: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }
        close();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      if (writeToken !== null) releaseTrackerWrite(writeToken);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
