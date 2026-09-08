// linkedin-stale.mjs — deterministic staleness gate for LinkedIn job URLs.
//
// LinkedIn job IDs are globally sequential, so the ID itself dates a posting —
// the same property prune-stale-web3career.mjs exploits for web3.career.
// Search indexes keep dead LinkedIn job pages for YEARS, and LinkedIn's guest
// wall makes browser liveness checks come back "uncertain", so an ID floor is
// the one check that cannot be fooled: a 2021 posting (id ~2.8e9) reached the
// user's fresh-matches feed on 2026-09-08 exactly this way.
//
// Calibration (2026-09-09): postings seen on their publish day —
//   2026-09-05 → 4,446,656,337 · 2026-09-08 → 4,464,416,959
// ≈ 4.4M new IDs/day, so the cutoff below sits ~5-6 weeks back. Anything under
// it is months-to-years old. Nudge the cutoff up over time as LinkedIn grows;
// it only ever needs to be loose, never exact.

export const LINKEDIN_STALE_ID_CUTOFF = 4_300_000_000;

const JOB_VIEW_RE = /linkedin\.com\/jobs\/view\/(?:[^/?#]*?-)?(\d{8,})/i;

export function linkedInJobId(url) {
  const m = JOB_VIEW_RE.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

// True only for a LinkedIn /jobs/view/ URL whose ID sits below the cutoff.
// Non-LinkedIn URLs (and unparsable ones) are never "stale" here — they get
// judged by the liveness gate instead.
export function isStaleLinkedInJobUrl(url, cutoff = LINKEDIN_STALE_ID_CUTOFF) {
  const id = linkedInJobId(url);
  return id !== null && id < cutoff;
}
