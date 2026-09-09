#!/usr/bin/env node
// l3-writer.mjs — THE canonical writer for L3 web-search finds.
//
// stdin:  JSON array of proposed offers ({url, company, title, location, source, note})
// stdout: one-line JSON summary {added, rejected, offers, known, filtered, ...}
//
// Extracted 2026-09-10 from web/src/app/api/explore/l3/route.ts's embedded
// subprocess so the Claude route AND gemini-l3.mjs share ONE gate pipeline —
// a second copy would repeat the drift the web/#2666 mirrors already paid for.
//
// Gate order (each find): scan-history dedup → web3.career stale-id →
// LinkedIn sequential-id floor → title filter → location filter →
// proof-of-freshness policy (2026-09-09, after two zombie incidents):
//   pass     — ATS API says active, LinkedIn id above the cutoff, or JSON-LD
//              datePosted within 45d with no past validThrough/deadline
//   dead     — persisted 'skipped_expired' (permanent ban)
//   unproven — dropped, NOT persisted (stays visible as filtered 'unverified')
//   gate unavailable — fail CLOSED (nothing enters unchecked)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, buildTitleFilter, buildLocationFilter } from './scan.mjs';
import { w3cStaleFilter } from './prune-stale-web3career.mjs';
import { isStaleLinkedInJobUrl } from './lib/linkedin-stale.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';

const ROOT = getCareerOpsRoot();

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  const today = localToday();
  let offers;
  try {
    // ﻿ strip: a Windows shell piping test input prepends a BOM.
    offers = JSON.parse(input.replace(/^﻿/, '').trim());
    if (!Array.isArray(offers)) throw new Error('expected a JSON array');
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: 'bad input: ' + (e && e.message) }));
    return;
  }

  try {
    const cfg = yaml.load(readFileSync(resolve(ROOT, 'portals.yml'), 'utf8'));
    const tf = buildTitleFilter(cfg.title_filter);
    const lf = buildLocationFilter(cfg.location_filter);
    const stale = w3cStaleFilter();
    // url -> {date, status} from scan-history (cols: url, date, query, title, portal, status).
    // Known finds are RETURNED, not swallowed — the UI shows them with their
    // real status instead of an empty pane.
    const hist = new Map();
    for (const l of readFileSync(resolve(ROOT, 'data', 'scan-history.tsv'), 'utf8').split('\n')) {
      const c = l.split('\t');
      if (c[0]) hist.set(c[0], { date: c[1] || '', status: (c[5] || '').trim() });
    }

    const fresh = [];
    const knownOut = [];
    const filteredOut = [];
    const idStale = [];
    const rejected = { dup: 0, title: 0, location: 0, stale: 0, expired: 0 };
    for (const o of offers) {
      const k = hist.get(o.url);
      if (k) { rejected.dup++; knownOut.push({ ...o, knownSince: k.date, knownStatus: k.status }); continue; }
      if (stale.isStale(o.url)) { rejected.stale++; filteredOut.push({ ...o, filteredBy: 'stale' }); continue; }
      // Sequential-ID floor: a LinkedIn job id below the cutoff is months-to-years
      // old. Persisted as 'skipped' so dedup blocks every future re-proposal.
      if (isStaleLinkedInJobUrl(o.url)) { rejected.stale++; idStale.push(o); filteredOut.push({ ...o, filteredBy: 'stale' }); continue; }
      if (!tf(o.title)) { rejected.title++; filteredOut.push({ ...o, filteredBy: 'title' }); continue; }
      if (!lf(o.location, o.url, o.title)) { rejected.location++; filteredOut.push({ ...o, filteredBy: 'location' }); continue; }
      fresh.push(o);
    }

    let liveFresh = fresh;
    const deadFinds = [];
    let gateError = null;
    if (fresh.length) {
      liveFresh = [];
      try {
        const { checkLivenessViaApi } = await import('./liveness-api.mjs');
        const { assessPostingFreshness } = await import('./lib/posting-freshness.mjs');
        for (const o of fresh) {
          let outcome = 'unproven';
          let why = '';
          try {
            const api = await checkLivenessViaApi(o.url);
            if (api && api.result === 'expired') { outcome = 'dead'; why = 'ats api: expired'; }
            else if (api && api.result === 'active') { outcome = 'pass'; why = 'ats api: active'; }
            else {
              const f = await assessPostingFreshness(o.url);
              if (f.verdict === 'fresh') { outcome = 'pass'; why = f.reason; }
              else if (f.verdict === 'expired' || f.verdict === 'stale') { outcome = 'dead'; why = f.reason; }
              else { why = f.reason; }
            }
          } catch (e) {
            why = 'freshness check failed: ' + String((e && e.message) || e);
          }
          if (outcome === 'pass') {
            o.note = (o.note ? o.note + ' | ' : '') + why;
            liveFresh.push(o);
          } else if (outcome === 'dead') {
            rejected.expired++;
            deadFinds.push(o);
            filteredOut.push({ ...o, filteredBy: 'expired', note: why });
          } else {
            rejected.unverified = (rejected.unverified || 0) + 1;
            filteredOut.push({ ...o, filteredBy: 'unverified', note: why });
          }
        }
      } catch (e) {
        gateError = String((e && e.message) || e);
        liveFresh = [];
      }
    }

    if (idStale.length) appendToScanHistory(idStale, today, 'skipped');
    if (deadFinds.length) appendToScanHistory(deadFinds, today, 'skipped_expired');
    if (liveFresh.length) {
      appendToPipeline(liveFresh);
      appendToScanHistory(liveFresh, today, 'added');
    }
    process.stdout.write(JSON.stringify({
      added: liveFresh.length,
      rejected,
      offers: liveFresh,
      known: knownOut.slice(0, 40),
      filtered: filteredOut.slice(0, 40),
      ...(gateError ? { livenessGateUnavailable: gateError } : {}),
    }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
}

await main();
