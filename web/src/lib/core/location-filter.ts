import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";

/**
 * ACL for portals.yml `location_filter` — a faithful TS mirror of the core
 * scanner's semantics (scan.mjs buildLocationFilter), so web surfaces that
 * read scan HISTORY (whats-new, trash) can honor the CURRENT policy
 * retroactively: rows added before a rule tightened must not resurface.
 *
 * Semantics (same order as the core):
 *   empty location        → pass (don't penalize missing data)
 *   any always_allow hit  → pass (wins over block — the commute zone)
 *   any block hit         → reject
 *   allow empty           → pass
 *   allow non-empty       → must match at least one keyword
 * Keywords are word-boundary anchored ("vence" never matches "Provence").
 */
type LocationFilterCfg = { always_allow?: string[]; allow?: string[]; block?: string[] };

function compile(list: unknown): RegExp[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    .map((k) => {
      const kw = k.trim().toLowerCase();
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prefix = /[a-z0-9]/.test(kw[0]) ? "(?<![a-z0-9])" : "";
      const suffix = /[a-z0-9]/.test(kw[kw.length - 1]) ? "(?![a-z0-9])" : "";
      return new RegExp(`${prefix}${escaped}${suffix}`);
    });
}

let cache: { alwaysAllow: RegExp[]; allow: RegExp[]; block: RegExp[]; mtime: number } | null = null;

function load() {
  const p = path.join(careerOpsRoot(), "portals.yml");
  let mtime = 0;
  try {
    mtime = fs.statSync(p).mtimeMs;
  } catch {
    /* missing file → no filter */
  }
  if (cache && cache.mtime === mtime) return cache;
  let cfg: LocationFilterCfg = {};
  try {
    const doc = yaml.load(fs.readFileSync(p, "utf8")) as { location_filter?: LocationFilterCfg };
    cfg = doc?.location_filter ?? {};
  } catch {
    cfg = {};
  }
  cache = { alwaysAllow: compile(cfg.always_allow), allow: compile(cfg.allow), block: compile(cfg.block), mtime };
  return cache;
}

/** Does this location string pass the user's current location policy? */
export function locationAllowed(location: string | undefined | null): boolean {
  const lower = (location ?? "").trim().toLowerCase();
  if (lower === "") return true;
  const { alwaysAllow, allow, block } = load();
  if (alwaysAllow.length > 0 && alwaysAllow.some((re) => re.test(lower))) return true;
  if (block.length > 0 && block.some((re) => re.test(lower))) return false;
  if (allow.length === 0) return true;
  return allow.some((re) => re.test(lower));
}

// ── Title negatives (same retroactivity argument) ─────────────────────────
// Mirror of the core's title_filter.negative matching (scan.mjs compileKeyword:
// 2-3 letter keywords word-bounded, longer ones substring). Positives are NOT
// applied here — history rows already passed a positive filter when scanned;
// only a rule that has since been ADDED should retroactively hide a row.
let negCache: { matchers: ((s: string) => boolean)[]; mtime: number } | null = null;

function loadNegatives() {
  const p = path.join(careerOpsRoot(), "portals.yml");
  let mtime = 0;
  try {
    mtime = fs.statSync(p).mtimeMs;
  } catch {
    /* no portals.yml */
  }
  if (negCache && negCache.mtime === mtime) return negCache;
  let list: unknown = [];
  try {
    const doc = yaml.load(fs.readFileSync(p, "utf8")) as { title_filter?: { negative?: unknown } };
    list = doc?.title_filter?.negative ?? [];
  } catch {
    list = [];
  }
  const matchers = (Array.isArray(list) ? list : [])
    .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    .map((k) => {
      const kw = k.trim().toLowerCase();
      if (/^[a-z]{2,3}$/.test(kw)) {
        const re = new RegExp(`\\b${kw}\\b`);
        return (lower: string) => re.test(lower);
      }
      return (lower: string) => lower.includes(kw);
    });
  negCache = { matchers, mtime };
  return negCache;
}

/** Does this title clear the user's current negative-keyword list? */
export function titleAllowed(title: string | undefined | null): boolean {
  const lower = (title ?? "").trim().toLowerCase();
  if (lower === "") return true;
  return !loadNegatives().matchers.some((m) => m(lower));
}
