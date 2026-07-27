// Pure JS implementation of cleanChips — no TypeScript types so it can be
// imported directly by both explore.ts (which re-exports it) and by
// test-clean-chips.mjs (which can't import .ts without a runner).
// This is the single source of truth for the chip-cleaning logic.

const CHIP_CAP = 16;

/**
 * Trim, drop empties, de-dupe case-insensitively, cap length.
 *
 * The 16 cap protects the UI from a user pasting a huge comma-separated blob
 * into a chip input. It must NOT apply when seeding from the user's own
 * portals.yml: that file legitimately holds 50+ keywords, and silently keeping
 * the first 16 meant every negative after "COBOL" (Engineer, Developer,
 * Architect, …) was never applied by the web's scan — the filters looked
 * configured but weren't. Callers that read config pass a larger `cap`.
 */
export function cleanChips(v, cap = CHIP_CAP) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const k = item.trim();
    if (!k) continue;
    if (!/[\p{L}\p{N}]/u.test(k)) continue; // drop punctuation-only junk (e.g. a stray "*")
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= cap) break;
  }
  return out;
}