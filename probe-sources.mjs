#!/usr/bin/env node
/**
 * probe-sources.mjs — ask a job_boards entry for its postings and print what
 * came back. READ-ONLY (fork-local, verification tool).
 *
 * WHY THIS EXISTS. `verify-pipeline.mjs` check 15 proves an entry resolves to a
 * provider and `audit-portals.mjs` audits `tracked_companies` — neither of them
 * tells you whether a `job_boards` entry actually returns anything. The only
 * other way to find out was to run `scan.mjs`, which writes
 * data/scan-history.tsv and data/pipeline.md, and only CAJITA may write
 * user-layer state. So: same provider modules, same ctx shape scan.mjs builds,
 * and not a single write.
 *
 * Usage:
 *   node probe-sources.mjs                       # every enabled job_boards entry
 *   node probe-sources.mjs --name "The Hub"      # one entry (substring match)
 *   node probe-sources.mjs --filtered            # also show how many survive
 *                                                # the title/location filters
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { buildTitleFilter, buildLocationFilter } from './scan.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = fileURLToPath(new URL('.', import.meta.url));

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

export async function main() {
  const cfg = yaml.load(readFileSync(resolve(getCareerOopsRootSafe(), 'portals.yml'), 'utf8'));
  const only = arg('name');
  const showFiltered = process.argv.includes('--filtered');

  const tf = buildTitleFilter(cfg.title_filter);
  const lf = buildLocationFilter(cfg.location_filter);

  const boards = (cfg.job_boards || []).filter((b) => b && b.enabled !== false
    && (!only || String(b.name || '').toLowerCase().includes(only.toLowerCase())));
  if (!boards.length) { console.log('no matching enabled job_boards entry'); return; }

  const providers = await loadProviders(resolve(CODE_ROOT, 'providers'));

  for (const board of boards) {
    // resolveProvider(entry, providers) — entry FIRST — and it returns
    // { provider } | { error } | null, never the provider itself.
    const label = String(board.name || board.provider || '?');
    const resolved = resolveProvider(board, providers);
    if (!resolved || !resolved.provider) {
      console.log('  ' + label.padEnd(34) + 'SIN PROVIDER'
        + (resolved && resolved.error ? '  (' + resolved.error + ')' : ''));
      continue;
    }
    const provider = resolved.provider;

    const ctx = {
      ...makeHttpCtx({ onRequest: () => {}, onResponse: () => {} }),
      sinceMs: 0,
      includeUndated: true,
      locationHints: cfg.location_filter,
    };

    const t0 = Date.now();
    let jobs;
    try {
      jobs = await provider.fetch(board, ctx);
    } catch (e) {
      console.log('  ' + label.padEnd(34) + 'ERROR  ' + String(e && e.message).slice(0, 90));
      continue;
    }
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    const list = Array.isArray(jobs) ? jobs : [];
    let tail = '';
    if (showFiltered) {
      const kept = list.filter((j) => tf(j.title || '') && lf(j.location || '', j.url || '', j.title || ''));
      tail = '  ->  ' + kept.length + ' pasan los filtros';
      if (kept.length) {
        tail += '\n' + kept.slice(0, 6).map((j) => '        ' + String(j.title || '?').slice(0, 56)
          + '  @ ' + String(j.location || '-').slice(0, 34)).join('\n');
      }
    }
    console.log('  ' + label.padEnd(34) + String(list.length).padStart(5) + ' ofertas  '
      + secs + 's' + tail);
  }
}

/** Keep working if path-resolver is unavailable for any reason. */
function getCareerOopsRootSafe() {
  try { return getCareerOpsRoot(); } catch { return CODE_ROOT; }
}

if (isMainModule(import.meta.url)) await main();
