#!/usr/bin/env node
/**
 * auto-triage.mjs — free-tier pre-scoring of fresh finds (fork-local).
 *
 * For every scan-history row ADDED today that has no prescore yet, fetch the
 * JD without a browser (fetch-jd.mjs) and run gemini-eval.mjs on the free
 * GEMINI_API_KEY tier to produce a first-pass score. Results are appended to
 * data/prescores.tsv; the web shows them on fresh-match cards so the paid
 * Claude evaluations are reserved for roles the user actually shortlists.
 *
 * Writes ONLY data/prescores.tsv — never the tracker, pipeline, or reports.
 *
 * Env:
 *   TRIAGE_MAX      max gemini calls per run (default 25)
 *   GEMINI_MODEL    passed through to gemini-eval.mjs
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const USER_ROOT = getCareerOpsRoot();
const PRESCORES = resolve(USER_ROOT, 'data/prescores.tsv');
const HISTORY = resolve(USER_ROOT, 'data/scan-history.tsv');
const HEADER = 'url\tdate\tscore\tlegitimacy\tconfidence\tmodel';

export function prescoredUrls() {
  if (!existsSync(PRESCORES)) return new Set();
  return new Set(
    readFileSync(PRESCORES, 'utf8').split('\n').slice(1).map((l) => l.split('\t')[0]).filter(Boolean),
  );
}

/** scan-history cols: url, first_seen, portal, title, company, status, location */
export function todaysCandidates(today = localToday()) {
  if (!existsSync(HISTORY)) return [];
  const out = [];
  for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
    const c = line.split('\t');
    if (!c[0] || !/^https?:\/\//i.test(c[0])) continue;
    if ((c[1] || '').trim() !== today) continue;
    if ((c[5] || '').trim() !== 'added') continue;
    out.push({ url: c[0], portal: c[2] || '', title: c[3] || '', company: c[4] || '', location: c[6] || '' });
  }
  return out;
}

function fetchJd(url) {
  const r = spawnSync(process.execPath, [join(CODE_ROOT, 'fetch-jd.mjs'), url], {
    cwd: CODE_ROOT, encoding: 'utf8', timeout: 60_000,
  });
  const text = (r.stdout || '').trim();
  return r.status === 0 && text.length > 200 ? text : null;
}

/** Parse `**Score:** 4.6 / 5` and `**Legitimacy:** High Confidence` from gemini-eval output. */
export function parseEval(output) {
  const score = output.match(/\*\*Score:\*\*\s*([0-9]+(?:\.[0-9]+)?)/);
  const legit = output.match(/\*\*Legitimacy:\*\*\s*([^\n|]+)/);
  return {
    score: score ? Number(score[1]) : null,
    legitimacy: legit ? legit[1].replace(/[*_`]/g, '').trim() : '',
  };
}

function runGeminiEval(jdText, index) {
  const tmp = join(tmpdir(), `co-triage-${process.pid}-${index}.txt`);
  writeFileSync(tmp, jdText);
  // --no-save: prescore ONLY. Without it gemini-eval persists a full report +
  // tracker-addition TSV, silently auto-evaluating every find into the tracker
  // (discovered 2026-09-08 — rows #308-310 were born that way).
  const r = spawnSync(process.execPath, [join(CODE_ROOT, 'gemini-eval.mjs'), '--file', tmp, '--no-save'], {
    cwd: CODE_ROOT, encoding: 'utf8', timeout: 180_000,
  });
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  return { ...parseEval(out), exit: r.status };
}

function hasGeminiKey() {
  if (process.env.GEMINI_API_KEY) return true;
  const envFile = resolve(USER_ROOT, '.env');
  return existsSync(envFile) && /^GEMINI_API_KEY=.+/m.test(readFileSync(envFile, 'utf8'));
}

export async function main() {
  if (!hasGeminiKey()) {
    console.log(JSON.stringify({ skipped: 'no GEMINI_API_KEY — free-tier triage disabled' }));
    return;
  }
  const cap = Math.max(1, Number(process.env.TRIAGE_MAX) || 25);
  // TRIAGE_DATE overrides the day being scored (backfills, testing).
  const day = process.env.TRIAGE_DATE || localToday();
  const done = prescoredUrls();
  const candidates = todaysCandidates(day).filter((c) => !done.has(c.url)).slice(0, cap);
  if (!existsSync(PRESCORES)) writeFileSync(PRESCORES, HEADER + '\n');

  let scored = 0;
  let titleOnly = 0;
  let failed = 0;
  const today = day;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const jd = fetchJd(c.url);
    const confidence = jd ? 'jd' : 'title-only';
    const input = jd
      ?? `Job posting (no full description retrievable — judge fit from these fields only, conservatively):\n` +
         `Title: ${c.title}\nCompany: ${c.company}\nLocation: ${c.location}\nSource: ${c.portal}\nURL: ${c.url}`;
    const r = runGeminiEval(input, i);
    if (r.score == null) {
      failed++;
      console.log(`  · ${c.title} — eval failed (exit ${r.exit})`);
      continue;
    }
    appendFileSync(
      PRESCORES,
      `${c.url}\t${today}\t${r.score}\t${r.legitimacy}\t${confidence}\t${process.env.GEMINI_MODEL || 'gemini-3.6-flash'}\n`,
    );
    scored++;
    if (!jd) titleOnly++;
    console.log(`  · ${r.score}/5 ${c.title} (${c.company})${jd ? '' : ' [title-only]'}`);
    // Free-tier RPM courtesy gap between calls.
    await new Promise((res) => setTimeout(res, 2_000));
  }
  console.log(JSON.stringify({ candidates: candidates.length, scored, titleOnly, failed }));
}

if (isMainModule(import.meta.url)) await main();
