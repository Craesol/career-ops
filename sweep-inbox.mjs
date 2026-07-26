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
 *  3. negative  — the title matches an explicit title_filter.negative term
 *                 ("Software Engineer", "Technical Program Manager"…).
 *                 The POSITIVE requirement is intentionally NOT applied: it
 *                 would drop legitimate variants such as "Community &
 *                 Marketing Manager" that no positive keyword matches exactly.
 *
 * Swept entries are marked done in place and recorded as `skipped` in
 * scan-history, so no future scan re-adds them.
 *
 * Usage:
 *   node sweep-inbox.mjs           # dry run
 *   node sweep-inbox.mjs --apply   # write (backs up pipeline.md first)
 */
import { readFileSync, writeFileSync, copyFileSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const PIPELINE = resolve(ROOT, 'data/pipeline.md');
const HISTORY = resolve(ROOT, 'data/scan-history.tsv');

const { buildLocationFilter } = await import(pathToFileURL(resolve(ROOT, 'scan.mjs')).href);
const config = yaml.load(readFileSync(resolve(ROOT, 'portals.yml'), 'utf8')) || {};
const locationOk = buildLocationFilter(config.location_filter);
const negatives = (config.title_filter?.negative || [])
  .filter(s => typeof s === 'string').map(s => s.toLowerCase().trim()).filter(Boolean);

// url → location, straight from the scanner's own history column.
const locByUrl = new Map();
try {
  for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
    const c = line.split('\t');
    // Column 7 is the scanner's location, but some writers put a DATE there.
    // A date is not a location: treating "2026-07-25" as one made the sweep
    // drop real roles (e.g. Ethereum Foundation — Community & Ecosystem Lead).
    const loc = (c[6] || '').trim();
    if (c[0] && loc && !/^\d{4}-\d{2}-\d{2}$/.test(loc)) locByUrl.set(c[0], loc);
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
// Page titles that betray an index page rather than a role.
const JUNK_TITLE = [
  /^\d+\+?\s/,                       // "31+ Crypto Community Jobs …"
  /\bjobs\b.*\b(hiring now|open positions|vetted|profiles)\b/i,
  /^(find|browse|search|hire|discover)\b/i,
  /\|\s*(hitmarker|linkedin|crypto jobs list|work anywhere)\s*$/i,
  /\bhiring\b.*\bin\b.*\|/i,
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

  let reason = null;
  if (JUNK_URL.some(re => re.test(url))) reason = 'junk-url';
  else if (!company.trim() && JUNK_TITLE.some(re => re.test(role))) reason = 'junk-title';
  else if (location && !locationOk(location)) reason = 'location';
  else if (negatives.some(n => lowerRole.includes(n))) reason = 'negative-title';

  if (!reason) { out.push(raw); kept++; continue; }
  dropped.push({ url, company: company.trim(), role, location, reason });
  out.push(`- [x] ~~${url} | ${company.trim()} | ${role}~~ — swept: ${reason}${location ? ` (${location})` : ''}`);
}

const byReason = dropped.reduce((a, d) => ((a[d.reason] = (a[d.reason] || 0) + 1), a), {});
console.log(`pending kept: ${kept} | swept: ${dropped.length} (${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`);
for (const r of Object.keys(byReason)) {
  console.log(`\n[${r}] examples:`);
  for (const d of dropped.filter(x => x.reason === r).slice(0, 6)) {
    console.log(`  ${d.company || '(no company)'} | ${d.role.slice(0, 70)}${d.location ? ` | ${d.location}` : ''}`);
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
