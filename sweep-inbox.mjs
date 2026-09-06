#!/usr/bin/env node
/**
 * sweep-inbox.mjs — retro-clean the pending inbox with CONSERVATIVE rules.
 *
 * WHY: filters only gate NEW scan results, so data/pipeline.md "Pendientes"
 * still holds entries added before a filter existed (or before it was
 * tightened), plus junk that early web-search sweeps scraped.
 *
 * THREE RULES, deliberately narrow — a missed real job costs more than a
 * scanned-and-skipped one, so anything ambiguous is KEPT:
 *
 *  1. junk      — the URL is a listing/search/talent page, not a job posting
 *                 (cryptojobslist.com/community, hitmarker.net/esports-jobs,
 *                 jobgether.com/remote-jobs/community-manager …), or the entry
 *                 carries no company and its "role" is really a page title
 *                 ("31+ Crypto Community Jobs April 2026 | Hiring Now").
 *  2. location  — a REAL location, taken from scan-history.tsv (the scanner's
 *                 own column), fails portals.yml location_filter. Locations
 *                 parsed out of pipeline lines are NOT trusted: those lines
 *                 split page titles on "|", so field 4 is often title text.
 *  3. stale     — first seen more than --max-age-days ago (opt-in flag). Age
 *                 comes from scan-history's first_seen column: it is when the
 *                 scanner DISCOVERED the posting, the only date available for
 *                 every entry. Entries with no history date are kept.
 *  4. negative  — the title matches an explicit title_filter.negative term
 *                 ("Software Engineer", "Technical Program Manager"…).
 *                 The POSITIVE requirement is intentionally NOT applied: it
 *                 would drop legitimate variants such as "Community &
 *                 Marketing Manager" that no positive keyword matches exactly.
 *
 * Swept entries are marked done in place and recorded as `skipped` in
 * scan-history, so no future scan re-adds them.
 *
 * Usage:
 *   node sweep-inbox.mjs                          # dry run
 *   node sweep-inbox.mjs --apply                  # write (backs up first)
 *   node sweep-inbox.mjs --max-age-days 45        # also drop stale entries
 */
import { readFileSync, writeFileSync, copyFileSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
const USER_ROOT = getCareerOpsRoot();

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const ageArgIdx = process.argv.indexOf('--max-age-days');
const MAX_AGE_DAYS = ageArgIdx !== -1 ? parseInt(process.argv[ageArgIdx + 1], 10) : null;
if (ageArgIdx !== -1 && (!Number.isFinite(MAX_AGE_DAYS) || MAX_AGE_DAYS < 1)) {
  console.error('--max-age-days needs a positive number of days');
  process.exit(1);
}
const PIPELINE = resolve(USER_ROOT, 'data/pipeline.md');
const HISTORY = resolve(USER_ROOT, 'data/scan-history.tsv');

const { buildLocationFilter } = await import(pathToFileURL(resolve(ROOT, 'scan.mjs')).href);
const config = yaml.load(readFileSync(resolve(USER_ROOT, 'portals.yml'), 'utf8')) || {};
const locationOk = buildLocationFilter(config.location_filter);
const negatives = (config.title_filter?.negative || [])
  .filter(s => typeof s === 'string').map(s => s.toLowerCase().trim()).filter(Boolean);

// url → location, straight from the scanner's own history column.
const locByUrl = new Map();
const firstSeenByUrl = new Map();
try {
  for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
    const c = line.split('\t');
    // Column 7 is the scanner's location, but some writers put a DATE there.
    // A date is not a location: treating "2026-07-25" as one made the sweep
    // drop real roles (e.g. Ethereum Foundation — Community & Ecosystem Lead).
    const loc = (c[6] || '').trim();
    if (c[0] && loc && !/^\d{4}-\d{2}-\d{2}$/.test(loc)) locByUrl.set(c[0], loc);
    // first_seen (col 2) — earliest wins, since a URL can be recorded again.
    const seen = (c[1] || '').trim();
    if (c[0] && /^\d{4}-\d{2}-\d{2}$/.test(seen)) {
      const prev = firstSeenByUrl.get(c[0]);
      if (!prev || seen < prev) firstSeenByUrl.set(c[0], seen);
    }
  }
} catch { /* no history yet */ }

// A posting URL points at ONE job. These shapes are boards' own index pages.
const JUNK_URL = [
  /cryptojobslist\.com\/(community|marketing|talent|engineering|design|sales)\/?$/i,
  /cryptojobslist\.com\/talent\//i,
  /hitmarker\.net\/(esports-)?jobs\/?$/i,
  /jobgether\.com\/remote-jobs\/[a-z-]+$/i,
  /\/(jobs|careers|remote-jobs|search|browse|categories?)\/?$/i,
  /\?(q|query|search|keywords)=/i,
];
// Page titles that betray an index/article/social page rather than a role.
// Only applied when the entry has NO company — a real posting always has one.
const JUNK_TITLE = [
  /^[\d,]+\+?\s/,                              // "31+ Crypto Community Jobs …", "2,028 Gaming …"
  /^\$[\d,]+k?[-–]/i,                          // "$33k-$250k Web3 Jobs (NOW HIRING)"
  /\bjobs?\b.*\b(hiring now|open positions|vetted|profiles|updated daily)\b/i,
  /^(find|browse|search|hire|discover|best|top|how to|ways to|why|what)\b/i,
  /\b(jobs?|emplois?|offres?|vacatures|empleos)\b.*\bin\b\s+[A-Z]/i,   // "… jobs in United States"
  /\bjobs?\s+(in|for|at|paying|abroad)\b/i,
  /\|\s*(hitmarker|linkedin|glassdoor|wellfound|indeed(\.fr)?|dework|himalayas|working nomads|crypto jobs list|jobs3|web3vacancy|apec|work anywhere|telegram)\s*$/i,
  /\bon X:\s*"/i,                              // X/Twitter posts
  /\/\s*X\s*$/,                                // "… / Posts / X"
  /\(@[\w-]+\)/,                               // social handles
  /^offres? d'emploi/i,                        // FR listing pages
  /^emplois?\s*:/i,
  /\bfiche métier\b/i,
  /\b(alternance|intérim|stage)\b.*\(\d{5}\)/i, // FR city-code listing pages
  /\(\d{5}\)\s*[-–]/,                          // "Community manager Nice (06000) - offres…"
  /\bjob board\b/i,
  /\b(guide|career|careers|trends|salary|substack|blog)\b.*\b(20\d\d|web3|crypto)\b/i,
  /^\w+\.(com|io|co|net|xyz|social|substack\.com)\b/i, // bare domains
  /\bdao\b\s*\|\s*dework/i,
  /\b(icon|talent app|advancing crypto)\b/i,
];
// Same signals, but strong enough to drop even when a "company" was scraped —
// board pages often carry the board's own name in the company column.
const JUNK_TITLE_STRONG = [
  /^[\d,]+\+?\s.*\bjobs?\b/i,
  /^\$[\d,]+k?[-–].*\bjobs?\b/i,
  /\bjobs?\b\s*\|\s*(wellfound|hitmarker|glassdoor|dework|jobs3|web3vacancy|cryptic web3)/i,
  /\bon X:\s*"/i,
  /^offres? d'emploi/i,
  /^emplois?\s*:/i,
  /\bfiche métier\b/i,
  /\(\d{5}\)\s*[-–]/,
  /- Voir les dernières offres/i,
  /\boffres? d'emploi\b\s*$/i,
  /\bjobs at\b.*\b(cryptocurrency jobs|crypto jobs)\b/i,
];

const lines = readFileSync(PIPELINE, 'utf8').split('\n');
const out = [];
const dropped = [];
let kept = 0;

for (const raw of lines) {
  // pipeline.md is CRLF: strip the trailing \r for matching (`.` and `$` never
  // match it), but push the ORIGINAL line back when keeping, so the sweep
  // doesn't rewrite every line ending in the file.
  const line = raw.replace(/\r$/, '');
  const m = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]*?)\s*\|\s*(.+)$/);
  if (!m) { out.push(raw); continue; }
  const [, url, company, roleRaw] = m;
  const role = roleRaw.trim();
  const location = (locByUrl.get(url) || '').trim();
  const lowerRole = role.toLowerCase();

  const firstSeen = firstSeenByUrl.get(url) || '';
  const ageDays = firstSeen ? Math.floor((Date.now() - Date.parse(firstSeen + 'T00:00:00Z')) / 86_400_000) : null;

  let reason = null;
  if (JUNK_URL.some(re => re.test(url))) reason = 'junk-url';
  else if (JUNK_TITLE_STRONG.some(re => re.test(role))) reason = 'junk-title';
  else if (!company.trim() && JUNK_TITLE.some(re => re.test(role))) reason = 'junk-title';
  else if (location && !locationOk(location)) reason = 'location';
  else if (MAX_AGE_DAYS && ageDays != null && ageDays > MAX_AGE_DAYS) reason = 'stale';
  else if (negatives.some(n => lowerRole.includes(n))) reason = 'negative-title';

  if (!reason) { out.push(raw); kept++; continue; }
  const detail = reason === 'stale' ? ` (${ageDays}d old, first seen ${firstSeen})` : location ? ` (${location})` : '';
  dropped.push({ url, company: company.trim(), role, location, reason, ageDays });
  out.push(`- [x] ~~${url} | ${company.trim()} | ${role}~~ — swept: ${reason}${detail}`);
}

const byReason = dropped.reduce((a, d) => ((a[d.reason] = (a[d.reason] || 0) + 1), a), {});
console.log(`pending kept: ${kept} | swept: ${dropped.length} (${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`);
for (const r of Object.keys(byReason)) {
  console.log(`\n[${r}] examples:`);
  for (const d of dropped.filter(x => x.reason === r).slice(0, 6)) {
    console.log(`  ${d.company || '(no company)'} | ${d.role.slice(0, 60)}${d.reason === 'stale' ? ` | ${d.ageDays}d` : d.location ? ` | ${d.location}` : ''}`);
  }
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to sweep.');
  process.exit(0);
}
if (dropped.length === 0) process.exit(0);

copyFileSync(PIPELINE, PIPELINE + '.pre-sweep.bak');
writeFileSync(PIPELINE, out.join('\n'));
const today = new Date().toISOString().slice(0, 10);
appendFileSync(HISTORY, dropped.map(d =>
  [d.url, today, 'sweep', d.role, d.company, 'skipped', d.location].join('\t')).join('\n') + '\n');
console.log(`\n✅ swept ${dropped.length} entries · backup: data/pipeline.md.pre-sweep.bak`);
