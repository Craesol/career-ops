import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "./safe-write";

/**
 * Close pending data/pipeline.md entries for the given URLs.
 *
 * Shared by every "get this off my list" action (inbox Skip, Fresh-matches
 * Remove) so they behave identically: a posting the user dismissed anywhere
 * must disappear everywhere, not just from the surface it was dismissed on.
 * Entries are marked done in place — nothing is deleted, and the reason is
 * written into the line so the history stays auditable.
 *
 * Returns how many pending lines were closed.
 */
export function closePendingByUrl(urls: string[], reason: string): number {
  const wanted = new Set(urls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)));
  if (wanted.size === 0) return 0;

  const file = path.join(careerOpsRoot(), "data", "pipeline.md");
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }

  let closed = 0;
  const lines = md.split("\n").map((raw) => {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("- [ ] ")) return raw;
    const rest = line.slice(6);
    const url = rest.split(/\s*\|\s*/)[0]?.trim();
    if (!url || !wanted.has(url)) return raw;
    closed++;
    const cr = raw.endsWith("\r") ? "\r" : "";
    return `- [x] ~~${rest}~~ — ${reason}${cr}`;
  });
  if (closed === 0) return 0;

  try {
    atomicWrite(file, lines.join("\n"));
  } catch {
    return 0;
  }
  return closed;
}
