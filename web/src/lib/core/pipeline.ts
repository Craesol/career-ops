import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import type { DiscoveredOffer } from "./scan";

/**
 * "Add to pipeline" — appends user-selected discovered offers to data/pipeline.md
 * AND records them in data/scan-history.tsv (so future scans dedup them). We reuse
 * the CANONICAL writers exported by the core's scan.mjs (`appendToPipeline`,
 * `appendToScanHistory`) instead of re-implementing the line format / section
 * markers — single source of truth, per the web↔core contract. We invoke them in
 * a short-lived node process (cwd = the user's career-ops root) so the core's own
 * code does the writing; the web never owns a parallel copy of that logic.
 *
 * Discovered-but-not-added offers stay "new" (a dry-run scan writes nothing);
 * only an explicit add records them as seen. No tokens are spent here.
 */
export type AddResult = { added: number; error?: string };

/**
 * Extract the LAST JSON value from a child's stdout.
 *
 * The writers import scan.mjs, which loads dotenv — and dotenv v17 prints a
 * banner ("◇ injected env (8) from .env …") to STDOUT. A plain
 * JSON.parse(stdout) therefore threw, and every add silently reported
 * "writer returned no result" while the write had actually succeeded. Parsing
 * the trailing JSON value survives any banner a dependency decides to print.
 */
function parseTrailingJson<T>(out: string): T | null {
  // Scan lines from the end: the writers emit their result as ONE line, while
  // the banner is separate. (A regex for "trailing {...}" is not enough — the
  // dotenv banner itself contains braces: "… { quiet: true }".)
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith("{") && !l.startsWith("[")) continue;
    try {
      return JSON.parse(l) as T;
    } catch {
      /* not the result line — keep scanning back */
    }
  }
  return null;
}

/**
 * "Remove" on a discovered offer — records it in data/scan-history.tsv with
 * status "skipped" via the core's own writer. /api/whats-new (and future scans)
 * treat skipped rows as dismissed, so the card never resurfaces. Nothing is
 * deleted — the history stays append-only, per the core's data contract.
 */
export function dismissOffers(offers: DiscoveredOffer[]): Promise<AddResult> {
  const clean = offers
    .filter((o) => o && typeof o.url === "string" && /^https?:\/\//i.test(o.url))
    .map((o) => ({ url: o.url, company: o.company || "", title: o.title || "", location: o.location || "", source: o.source || o.ats || "explorer", note: "" }));
  if (clean.length === 0) return Promise.resolve({ added: 0 });
  if (!fs.existsSync(rootScript("scan"))) {
    return Promise.resolve({ added: 0, error: "This checkout is data-only — the history writer (scan.mjs) isn't available." });
  }

  const scanUrl = pathToFileURL(rootScript("scan")).href;
  const code = `
import { appendToScanHistory } from ${JSON.stringify(scanUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  try {
    const offers = JSON.parse(input);
    const date = new Date().toISOString().slice(0, 10);
    appendToScanHistory(offers, date, "skipped");
    process.stdout.write(JSON.stringify({ added: offers.length }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
});
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: careerOpsRoot(), env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ added: 0, error: e instanceof Error ? e.message : "spawn failed" }));
    child.on("close", () => {
      const parsed = parseTrailingJson<AddResult>(out);
      if (parsed) resolve({ added: parsed.added ?? 0, error: parsed.error });
      else resolve({ added: 0, error: err.trim().slice(0, 200) || "writer returned no result" });
    });
    child.stdin.write(JSON.stringify(clean));
    child.stdin.end();
  });
}

export function addOffersToPipeline(offers: DiscoveredOffer[]): Promise<AddResult> {
  const clean = offers
    .filter((o) => o && typeof o.url === "string" && /^https?:\/\//i.test(o.url))
    .map((o) => ({
      url: o.url,
      company: o.company || "",
      title: o.title || "",
      location: o.location || "",
      source: o.source || o.ats || "explorer",
      // Preserve the optional per-offer signal so it survives to pipeline.md.
      // The core writer treats an empty note as absent (byte-identical output).
      note: o.note || "",
    }));
  if (clean.length === 0) return Promise.resolve({ added: 0 });

  // Data-only / pre-scan-ats checkout has no scan.mjs writers → fail with an
  // actionable message instead of a silent added:0.
  if (!fs.existsSync(rootScript("scan"))) {
    return Promise.resolve({ added: 0, error: "This checkout is data-only — the pipeline writer (scan.mjs) isn't available." });
  }

  const scanUrl = pathToFileURL(rootScript("scan")).href;
  const code = `
import { appendToPipeline, appendToScanHistory } from ${JSON.stringify(scanUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  try {
    const offers = JSON.parse(input);
    const date = new Date().toISOString().slice(0, 10);
    appendToPipeline(offers);
    appendToScanHistory(offers, date, "added");
    process.stdout.write(JSON.stringify({ added: offers.length }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
});
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ added: 0, error: e instanceof Error ? e.message : "spawn failed" }));
    child.on("close", () => {
      const parsed = parseTrailingJson<AddResult>(out);
      if (parsed) resolve({ added: parsed.added ?? 0, error: parsed.error });
      else resolve({ added: 0, error: err.trim().slice(0, 200) || "writer returned no result" });
    });
    child.stdin.write(JSON.stringify(clean));
    child.stdin.end();
  });
}
