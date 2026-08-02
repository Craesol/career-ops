#!/usr/bin/env node
/**
 * prune-stale-web3career.mjs — drop ancient web3.career postings from the
 * pending inbox by POSTING ID, not discovery date.
 *
 * WHY: L3 websearch (and any dateless source) rediscovers years-old
 * web3.career listings, and the system can only age entries by first_seen —
 * so a 2024 posting looks "found today" (see Seedify #84613, Sega/hitmarker).
 * web3.career URL ids are sequential, which gives us a real recency signal:
 * anything more than GAP ids behind the newest id ever seen in scan-history
 * is months old, whatever its first_seen says.
 *
 * The threshold self-updates: it is always (max id seen) − GAP, so no
 * hardcoded id rots. Entries are closed in pipeline.md and recorded as
 * `skipped` in scan-history via the core writer — web, digest email, and
 * future scans all hide them consistently.
 *
 * Usage:
 *   node prune-stale-web3career.mjs            # apply (cron-friendly)
 *   node prune-stale-web3career.mjs --dry-run  # report only
 * Env:
 *   W3C_STALE_ID_GAP (default 20000) — how far behind max id counts as stale
 */
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const GAP = parseInt(process.env.W3C_STALE_ID_GAP || '20000', 10);
const ID_RE = /web3\.career\/[^\s|~]*\/(\d{2,9})(?:[/?#]|\s|$)/;

const today = new Date().toISOString().slice(0, 10);
const histPath = resolve(ROOT, 'data/scan-history.tsv');
const pipePath = resolve(ROOT, 'data/pipeline.md');

// 1. Max id ever seen across scan-history (the recency anchor).
let maxId = 0;
for (const line of readFileSync(histPath, 'utf-8').split('\n')) {
  const m = line.split('\t')[0]?.match(ID_RE);
  if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
}
if (maxId === 0) {
  console.log('no web3.career ids in scan-history — nothing to do');
  process.exit(0);
}
const threshold = maxId - GAP;
console.log(`max web3.career id seen: ${maxId} · stale below: ${threshold} (gap ${GAP})`);

// 2. Walk pending pipeline entries.
const lines = readFileSync(pipePath, 'utf-8').split('\n');
const stale = [];
const out = lines.map(line => {
  if (!line.startsWith('- [ ]')) return line;
  const m = line.match(ID_RE);
  if (!m) return line;
  const id = parseInt(m[1], 10);
  if (id >= threshold) return line;
  const urlMatch = line.match(/https?:\/\/\S+/);
  stale.push({ url: urlMatch ? urlMatch[0] : '', id, line });
  const body = line.replace(/^- \[ \]\s*/, '');
  return `- [x] ~~${body}~~ — swept: stale (web3.career id ${id} < ${threshold})`;
});

if (stale.length === 0) {
  console.log('no stale web3.career postings pending — clean');
  process.exit(0);
}
for (const s of stale) console.log(`  stale: id ${s.id} · ${s.url}`);

if (DRY) {
  console.log(`DRY RUN — would sweep ${stale.length} entries`);
  process.exit(0);
}

// 3. Write: pipeline (with backup) + skipped rows via the core writer.
copyFileSync(pipePath, pipePath + '.pre-prune.bak');
writeFileSync(pipePath, out.join('\n'));
const { appendToScanHistory } = await import('./scan.mjs');
appendToScanHistory(
  stale.map(s => ({ url: s.url, company: '', title: '', location: '', source: 'w3c-id-prune', note: `stale id < ${threshold}` })),
  today,
  'skipped',
);
console.log(`✅ swept ${stale.length} stale web3.career postings · backup: data/pipeline.md.pre-prune.bak`);
