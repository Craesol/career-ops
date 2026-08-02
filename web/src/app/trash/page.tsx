import fs from "node:fs";
import path from "node:path";
import { Trash2 } from "lucide-react";
import { careerOpsRoot } from "@/lib/career-ops";

export const dynamic = "force-dynamic";

// The trash: everything the user removed (Remove button, sweeps) plus postings
// the liveness prune closed as dead. Read-only view over scan-history's
// append-only dismissal rows — nothing here is deleted, which is exactly why a
// trash can exist at all. Auto-noise (skipped_title/skipped_dup) stays out:
// those were never shown to the user, so they were never "thrown away".
type TrashRow = { url: string; date: string; title: string; company: string; location: string; kind: string; note: string };

const KIND_LABEL: Record<string, string> = {
  skipped: "Removed",
  skipped_expired: "Expired posting",
  expired: "Expired posting",
};

function readTrash(): TrashRow[] {
  let rows: string[];
  try {
    rows = fs.readFileSync(path.join(careerOpsRoot(), "data", "scan-history.tsv"), "utf8").split("\n");
  } catch {
    return [];
  }
  const byUrl = new Map<string, TrashRow>();
  const meta = new Map<string, { title: string; company: string; location: string }>();
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i].split("\t");
    const url = (c[0] || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    // Remember the richest metadata any row carried — dismissal rows are often
    // written bare (url + status only), the original `added` row has the names.
    const prev = meta.get(url) ?? { title: "", company: "", location: "" };
    meta.set(url, {
      title: prev.title || (c[3] || "").trim(),
      company: prev.company || (c[4] || "").trim(),
      location: prev.location || (c[6] || "").trim(),
    });
    const status = (c[5] || "").trim();
    if (!KIND_LABEL[status]) continue;
    byUrl.set(url, {
      url,
      date: (c[1] || "").trim(),
      title: "",
      company: "",
      location: "",
      kind: KIND_LABEL[status],
      note: (c[7] || c[11] || "").trim(),
    });
  }
  const out = [...byUrl.values()].map((r) => ({ ...r, ...meta.get(r.url)!, url: r.url, date: r.date, kind: r.kind, note: r.note }));
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.slice(0, 200);
}

export default function Trash() {
  const rows = readTrash();
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-center gap-2.5">
        <Trash2 className="size-5 text-muted" />
        <h1 className="font-display text-2xl tracking-tight text-landing">Trash</h1>
      </div>
      <p className="mt-1 text-sm text-muted">
        Roles you removed, plus postings that expired. Nothing is deleted — every dismissal is an append-only record, and none of these will resurface in scans, the home page, or the daily email.
      </p>

      {rows.length === 0 ? (
        <p className="mt-10 text-sm text-faint">Empty — remove a role anywhere in the app and it lands here.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Company</th>
                <th className="px-4 py-2.5 font-medium max-md:hidden">Location</th>
                <th className="px-4 py-2.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.url} className="border-b border-border/60 last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-faint">{r.date}</td>
                  <td className="max-w-[26ch] truncate px-4 py-2.5">
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-foreground hover:text-brand hover:underline">
                      {r.title || r.url.replace(/^https?:\/\//, "").slice(0, 40)}
                    </a>
                  </td>
                  <td className="max-w-[18ch] truncate px-4 py-2.5 text-muted">{r.company || "—"}</td>
                  <td className="max-w-[18ch] truncate px-4 py-2.5 text-faint max-md:hidden">{r.location || "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">{r.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-faint">{rows.length} item{rows.length === 1 ? "" : "s"} · newest first · capped at 200</p>
    </div>
  );
}
