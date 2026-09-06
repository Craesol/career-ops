#!/usr/bin/env node
// backfill-scan-runs.mjs — one-off recovery (2026-07-26): reconstruct historical
// scan runs from logs/scan.log (runs predate the introduction of scan-runs.tsv)
// and merge them into data/scan-runs.tsv so stats.mjs / the web Analytics see
// the full history. Honest-estimate caveat: the log records companies, found
// and new_added per run; the remainder (found - new_added) is attributed to
// filtered_title, which recent real rows show is ~94% of the filter volume.
// Idempotent: skips log runs whose timestamp is within 10 min of an existing row.
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
const USER_ROOT = getCareerOpsRoot();

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = resolve(ROOT, 'logs/scan.log');
const TSV = resolve(USER_ROOT, 'data/scan-runs.tsv');

// [Thu 05/07/2026  0:35:11.85] — US month/day, local time (Europe/Paris, +02 in summer)
function parseStamp(s) {
  const m = s.match(/\[\w+ (\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, MM, DD, YYYY, hh, mm, ss] = m;
  const iso = `${YYYY}-${MM}-${DD}T${String(hh).padStart(2, '0')}:${mm}:${ss}+02:00`;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

const logLines = readFileSync(LOG, 'utf8').split('\n');
const runs = [];
let cur = null;
for (const line of logLines) {
  if (line.includes('scan starting')) {
    const d = parseStamp(line);
    if (d) cur = { ts: d, companies: 0, found: 0, added: 0 };
    continue;
  }
  if (!cur) continue;
  const job = line.match(/^\[(?:greenhouse|ashby|lever|workday)[^\]]*\] (\d+) jobs/);
  if (job) { cur.companies += 1; cur.found += parseInt(job[1], 10); continue; }
  const found = line.match(/Found (\d+) new roles/);
  if (found) { cur.added = parseInt(found[1], 10); continue; }
  if (line.includes('scan finished')) { runs.push(cur); cur = null; }
}

const tsv = readFileSync(TSV, 'utf8').trimEnd().split('\n');
const header = tsv[0];
const existing = tsv.slice(1).filter(Boolean);
const existingTs = existing.map(l => Date.parse(l.split('\t')[0])).filter(Number.isFinite);
const TEN_MIN = 10 * 60 * 1000;

const backfill = runs.filter(r => !existingTs.some(t => Math.abs(t - r.ts.getTime()) < TEN_MIN));
const rows = backfill.map(r => [
  r.ts.toISOString(), 'completed', r.companies, 0, r.found,
  Math.max(0, r.found - r.added), 0, 0, 0, 0, 0, 0, r.added, 0,
].join('\t'));

copyFileSync(TSV, TSV + '.pre-backfill.bak');
const all = [...existing, ...rows]
  .sort((a, b) => Date.parse(a.split('\t')[0]) - Date.parse(b.split('\t')[0]));
writeFileSync(TSV, header + '\n' + all.join('\n') + '\n');
console.log(`log runs parsed: ${runs.length} | already recorded: ${runs.length - backfill.length} | backfilled: ${backfill.length} | total rows now: ${all.length}`);
console.log(`backup: ${TSV}.pre-backfill.bak`);
