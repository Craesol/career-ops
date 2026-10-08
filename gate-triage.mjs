#!/usr/bin/env node
/**
 * gate-triage.mjs — apply the hard disqualifiers to today's finds in ONE free
 * request, before any paid evaluation is spent (fork-local).
 *
 * THE GAP THIS CLOSES. The title filter cannot see the JD body, and
 * auto-triage.mjs only scores — it never checks the gates. So a posting that
 * fails a hard gate (German required, a stage, unpaid, anchored to an APAC
 * audience, a stated ceiling under the 50k floor) costs a full paid evaluation
 * to discover. Two Metricool roles reached the inbox on 2026-10-08 exactly that
 * way: "German & French Markets", which the candidate cannot take.
 *
 * WHAT IT WILL NOT DO. It never deletes or rewrites a pipeline entry. A free
 * model's verdict is recorded and surfaced, never acted on silently — the
 * doctrine in modes/_custom.md says a free model gates nothing on its own,
 * because a false positive on the market gate discards a role the user wanted.
 * The verdict lands in data/gate-verdicts.tsv for the digest, the web and a
 * human to read.
 *
 * Usage:
 *   node gate-triage.mjs                 # today's un-gated finds, one batch
 *   node gate-triage.mjs --date 2026-10-08
 *   node gate-triage.mjs --max 25        # cap the batch (default 25)
 *   node gate-triage.mjs --dry           # show what would be sent, spend nothing
 *   node gate-triage.mjs --summary       # human output instead of JSON
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { classifyBatch, gateModel } from './lib/hard-gates.mjs';
import { status as budgetStatus } from './lib/openrouter-budget.mjs';

const CODE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const ROOT = getCareerOpsRoot();
const HISTORY = resolve(ROOT, 'data', 'scan-history.tsv');
const VERDICTS = resolve(ROOT, 'data', 'gate-verdicts.tsv');
const HEADER = 'url\tdate\tverdict\tgate\twhy\tmodel\tconfidence';

/** scan-history cols: url, first_seen, portal, title, company, status, location */
export function findsFor(day) {
  if (!existsSync(HISTORY)) return [];
  const out = [];
  for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
    const c = line.split('\t');
    if (!c[0] || !/^https?:\/\//i.test(c[0])) continue;
    if ((c[1] || '').trim() !== day) continue;
    if ((c[5] || '').trim() !== 'added') continue;
    out.push({ url: c[0], portal: c[2] || '', title: c[3] || '', company: c[4] || '', location: c[6] || '' });
  }
  return out;
}

export function alreadyGated() {
  if (!existsSync(VERDICTS)) return new Set();
  return new Set(
    readFileSync(VERDICTS, 'utf8').split('\n').slice(1).map((l) => l.split('\t')[0]).filter(Boolean),
  );
}

/** JD text from a known ATS at zero cost; null when no ATS answers. */
function fetchJd(url) {
  const r = spawnSync(process.execPath, [resolve(CODE_ROOT, 'fetch-jd.mjs'), url], {
    cwd: CODE_ROOT, encoding: 'utf8', timeout: 60_000,
  });
  const text = (r.stdout || '').trim();
  return r.status === 0 && text.length > 200 ? text : null;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

export async function main() {
  const day = arg('date', localToday());
  const max = Math.max(1, Number(arg('max')) || 25);
  const dry = process.argv.includes('--dry');
  const summary = process.argv.includes('--summary');

  const gated = alreadyGated();
  const candidates = findsFor(day).filter((f) => !gated.has(f.url)).slice(0, max);

  if (!candidates.length) {
    const r = { day, candidates: 0, skipped: 'nothing new to gate', budget: budgetStatus() };
    console.log(summary ? '  gate-triage: nothing new to gate for ' + day : JSON.stringify(r));
    return;
  }

  // One JD fetch each at zero token cost. A posting with no reachable JD is
  // still classified, on title + company + location — the prompt is told the
  // input is thin and to answer "pass" unless the title itself disqualifies.
  const items = candidates.map((c) => {
    const jd = fetchJd(c.url);
    const head = 'Title: ' + c.title + '\nCompany: ' + c.company + '\nLocation: ' + c.location;
    return {
      ...c,
      confidence: jd ? 'jd' : 'title-only',
      text: jd ? head + '\n\n' + jd.slice(0, 6000) : head + '\n(no job description retrievable)',
    };
  });

  if (dry) {
    console.log('would send ' + items.length + ' posting(s) in 1 request to ' + gateModel());
    for (const it of items) console.log('  [' + it.confidence + '] ' + it.title + ' - ' + it.company);
    console.log('budget: ' + JSON.stringify(budgetStatus()));
    return;
  }

  const res = await classifyBatch(items);
  if (!res.ok) {
    const r = { day, candidates: items.length, error: res.error, spent: res.spent, budget: res.budget };
    console.log(summary ? '  gate-triage FAILED: ' + res.error : JSON.stringify(r));
    // Not a fatal exit: a gate pass is an optimisation, and the nightly must
    // carry on without it rather than stop.
    return;
  }

  mkdirSync(dirname(VERDICTS), { recursive: true });
  if (!existsSync(VERDICTS)) writeFileSync(VERDICTS, HEADER + '\n');
  const model = gateModel();
  const rows = res.verdicts.map((v) => [
    v.item.url, day, v.verdict, v.gate, v.why.replace(/\t/g, ' '), model, v.item.confidence,
  ].join('\t'));
  if (rows.length) appendFileSync(VERDICTS, rows.join('\n') + '\n');

  const failed = res.verdicts.filter((v) => v.verdict === 'fail');
  const result = {
    day,
    candidates: items.length,
    classified: res.verdicts.length,
    failed: failed.length,
    passed: res.verdicts.length - failed.length,
    byGate: failed.reduce((a, v) => ({ ...a, [v.gate]: (a[v.gate] || 0) + 1 }), {}),
    spent: res.spent,
    budget: res.budget,
  };

  if (!summary) { console.log(JSON.stringify(result)); return; }
  console.log('  gate-triage ' + day + ': ' + result.classified + ' classified in ' + result.spent
    + ' request - ' + result.failed + ' hit a gate, ' + result.passed + ' passed');
  for (const v of failed) {
    console.log('    GATE[' + v.gate + '] ' + v.item.title + ' - ' + v.item.company + ' (' + v.why + ')');
  }
  console.log('    budget: ' + result.budget.used + '/' + result.budget.max + ' used, '
    + result.budget.remaining + ' left');
  console.log('    verdicts in data/gate-verdicts.tsv - nothing was removed from the pipeline');
}

if (isMainModule(import.meta.url)) await main();
