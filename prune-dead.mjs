#!/usr/bin/env node
/**
 * prune-dead.mjs — remove postings that are no longer live from the inbox.
 *
 * Job ads expire fast, and data/pipeline.md accumulates them: an entry sits
 * there for weeks, gets triaged, gets evaluated — and only then turns out to be
 * gone. This checks pending entries against the posting's own ATS JSON API
 * (liveness-api.mjs, the same rung check-liveness.mjs uses first) and closes the
 * dead ones.
 *
 * COST: zero tokens, plain HTTP. Only ATS-hosted URLs are checkable this way;
 * everything else is left untouched (a browser check is expensive and a false
 * "expired" is worse than a slow one — it makes the user miss a real job).
 *
 * Only a DEFINITIVE expired verdict closes an entry. Network errors, rate
 * limits and "uncertain" all keep the posting.
 *
 * Usage:
 *   node prune-dead.mjs                 # dry run
 *   node prune-dead.mjs --apply
 *   node prune-dead.mjs --limit 200     # cap how many URLs are probed
 */
import { readFileSync, writeFileSync, copyFileSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const li = process.argv.indexOf('--limit');
const LIMIT = li !== -1 ? parseInt(process.argv[li + 1], 10) : Infinity;
const CONCURRENCY = 8;

const PIPELINE = resolve(ROOT, 'data/pipeline.md');
const HISTORY = resolve(ROOT, 'data/scan-history.tsv');
const { checkLivenessViaApi, isAtsPosting } = await import(pathToFileURL(resolve(ROOT, 'liveness-api.mjs')).href);

const lines = readFileSync(PIPELINE, 'utf8').split('\n');
const pending = [];
lines.forEach((raw, idx) => {
  const line = raw.replace(/\r$/, '');
  const m = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]*?)\s*\|\s*(.+)$/);
  if (m && isAtsPosting(m[1])) pending.push({ idx, url: m[1], company: m[2].trim(), role: m[3].trim() });
});

const targets = pending.slice(0, Number.isFinite(LIMIT) ? LIMIT : pending.length);
console.log(`pending ATS-checkable: ${pending.length} · probing ${targets.length} (${CONCURRENCY} at a time)`);

const dead = [];
let done = 0;
async function worker(queue) {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    try {
      const r = await checkLivenessViaApi(item.url);
      if (r?.result === 'expired') dead.push({ ...item, reason: r.reason || r.code || 'expired' });
    } catch {
      /* network/rate-limit → keep the posting */
    }
    if (++done % 25 === 0) process.stdout.write(`  ${done}/${targets.length}\r`);
  }
}
const queue = [...targets];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

console.log(`\nchecked ${done} · dead ${dead.length} · alive ${done - dead.length}`);
for (const d of dead.slice(0, 12)) console.log(`  x ${d.company} | ${d.role.slice(0, 60)}`);
if (dead.length > 12) console.log(`  … and ${dead.length - 12} more`);

if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to close them.'); process.exit(0); }
if (!dead.length) process.exit(0);

const byIdx = new Map(dead.map(d => [d.idx, d]));
const out = lines.map((raw, idx) => {
  const d = byIdx.get(idx);
  if (!d) return raw;
  const cr = raw.endsWith('\r') ? '\r' : '';
  return `- [x] ~~${d.url} | ${d.company} | ${d.role}~~ — closed: posting gone (${d.reason})${cr}`;
});
copyFileSync(PIPELINE, PIPELINE + '.pre-prune.bak');
writeFileSync(PIPELINE, out.join('\n'));
const today = new Date().toISOString().slice(0, 10);
appendFileSync(HISTORY, dead.map(d =>
  [d.url, today, 'prune', d.role, d.company, 'expired', ''].join('\t')).join('\n') + '\n');
console.log(`✅ closed ${dead.length} dead postings · backup: data/pipeline.md.pre-prune.bak`);
