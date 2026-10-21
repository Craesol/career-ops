#!/usr/bin/env node
/**
 * mark-reposts.mjs — hide fresh finds that are a posting the user already has
 * (fork-local, 2026-10-21).
 *
 * THE GAP THIS CLOSES. Every scanner dedups on the URL as written, so one
 * posting reached the web three times on 2026-10-20/21: LinkedIn id 4480441301
 * as `www.linkedin.com/jobs/view/4480441301/` (session scan) and again as
 * `fr.linkedin.com/jobs/view/new-media-manager-…-4480441301` (feed), plus
 * Jobgether's Lever copy of the same role. And that role was Solana
 * Foundation's, applied to on 2026-09-16 (tracker #322): Jobgether re-lists
 * other companies' openings under its own name, so no company+role check sees it.
 *
 * Two rules, run over the `added` finds of the last few days:
 *   1. same-posting — an aggregator posting id (url-key.mjs: LinkedIn
 *      /jobs/view/{id} in any host or slug form, Indeed jk) that an EARLIER
 *      scan-history row already carried under another URL.
 *   2. already-applied — the title equals, word for word, the role of a tracker
 *      row at Applied or later. A short title ("Community Manager") is shared by
 *      many different openings, so a cross-company match needs 5+ words; a
 *      same-company match needs only the exact title.
 *
 * A match is written back as a `skipped` scan-history row — the dismissal the
 * web, the daily email and the ops-api already honour — so it disappears from
 * the fresh matches without touching the tracker, the pipeline or the original
 * row. Run after every scan step, before the triage steps spend requests on it.
 *
 * Usage:
 *   node mark-reposts.mjs            # finds from the last 3 days
 *   node mark-reposts.mjs --days 7   # widen the window
 *   node mark-reposts.mjs --dry-run  # report, write nothing
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { aggregatorPostingId } from './url-key.mjs';

const USAGE = `Usage: node mark-reposts.mjs [--days N] [--dry-run]

Marks fresh finds as skipped when they repeat a posting already seen under
another URL, or a role already applied to. Default window: 3 days.`;

const args = process.argv.slice(2);
if (args.some((a) => a === '--help' || a === '-h')) { console.log(USAGE); process.exit(0); }
const dryRun = args.includes('--dry-run');
const daysArg = args.indexOf('--days');
const DAYS = daysArg >= 0 ? Math.max(Number(args[daysArg + 1]) || 3, 1) : 3;

const ROOT = getCareerOpsRoot();
const HISTORY = resolve(ROOT, 'data', 'scan-history.tsv');
const APPLIED_OR_LATER = new Set(['applied', 'responded', 'assessment', 'interview', 'offer', 'hired', 'rejected']);
const DISMISSED = /^(skipped|skipped_expired|expired)$/;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const idKey = (url) => { const p = aggregatorPostingId(url); return p ? p.domain + ':' + p.id : null; };

function localDate(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function appliedRoles() {
  const path = resolveTrackerPath(ROOT);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => {
    const c = l.split('|').map((s) => s.trim());
    return { row: c[1], company: norm(c[3]), title: norm(c[4]), status: c[6].toLowerCase() };
  }).filter((r) => APPLIED_OR_LATER.has(r.status) && r.title);
}

function main() {
  if (!existsSync(HISTORY)) { console.log('mark-reposts: no scan-history yet'); return; }
  const rows = readFileSync(HISTORY, 'utf8').split('\n').slice(1).map((l) => l.split('\t'))
    .filter((c) => /^https?:\/\//.test(c[0] || ''));
  const today = localDate(new Date());
  const cutoff = localDate(new Date(Date.now() - (DAYS - 1) * 86_400_000));
  const dismissed = new Set(rows.filter((c) => DISMISSED.test((c[5] || '').trim())).map((c) => c[0]));
  const applied = appliedRoles();

  const firstUrlForId = new Map(); // aggregator id → first URL that carried it
  const hits = [];
  const marked = new Set();
  for (const c of rows) {
    const [url, date, , title, company] = c;
    const key = idKey(url);
    const isFresh = (c[5] || '').trim() === 'added' && (date || '') >= cutoff && !dismissed.has(url) && !marked.has(url);
    if (isFresh) {
      let why = null;
      if (key && firstUrlForId.has(key) && firstUrlForId.get(key) !== url) {
        why = 'same posting as ' + firstUrlForId.get(key);
      } else {
        const t = norm(title);
        const words = t ? t.split(' ').length : 0;
        const match = applied.find((r) => r.title === t && (r.company === norm(company) || words >= 5));
        if (match) why = 'already applied: tracker #' + match.row + ' (' + match.status + ')';
      }
      if (why) { hits.push({ url, title, company, why }); marked.add(url); }
    }
    if (key && !firstUrlForId.has(key)) firstUrlForId.set(key, url);
  }

  for (const h of hits) {
    console.log('  repost: ' + h.company + ' | ' + h.title + ' — ' + h.why);
    if (!dryRun) appendFileSync(HISTORY, [h.url, today, 'repost-check', h.title, h.company, 'skipped'].join('\t') + '\n');
  }
  console.log('mark-reposts: ' + hits.length + ' repost(s) in the last ' + DAYS + ' day(s)' + (dryRun ? ' (dry run, nothing written)' : ''));
}

main();
