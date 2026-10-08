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

function runGeminiEvalOnce(jdText, index) {
  const tmp = join(tmpdir(), `co-triage-${process.pid}-${index}.txt`);
  writeFileSync(tmp, jdText);
  // --no-save: prescore ONLY. Without it gemini-eval persists a full report +
  // tracker-addition TSV, silently auto-evaluating every find into the tracker
  // (discovered 2026-09-08 — rows #308-310 were born that way).
  const r = spawnSync(process.execPath, [join(CODE_ROOT, 'gemini-eval.mjs'), '--file', tmp, '--no-save'], {
    cwd: CODE_ROOT, encoding: 'utf8', timeout: 180_000,
  });
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  return { ...parseEval(out), exit: r.status, out };
}

// ---------------------------------------------------------------------------
// Transient-failure handling (2026-10-09)
//
// gemini-eval.mjs calls process.exit(1) from inside the catch around
// model.generateContent(). On Windows that tears the event loop down while
// the sockets of the fetch that just failed are still in UV_HANDLE_CLOSING,
// so libuv aborts the process:
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
// The child then dies with 0xC0000409 instead of exit 1, and this script used
// to log that bare number. There were 377 such lines in hourly-scan.log, and
// every one reproduced turned out to be a transient Gemini 503 (model
// experiencing high demand) or a free-tier rate limit. The real reason is
// always present in the child output, so read it from there and retry rather
// than reporting an exit code nobody can act on.
//
// gemini-eval.mjs is upstream-owned (NOT in config/local-paths.txt), so a fix
// made there is reverted by the next update-system.mjs apply. Everything below
// therefore assumes the child may still abort, and stays correct either way:
// the transient markers reach the output before the abort.
// ---------------------------------------------------------------------------

/** 0xC0000409, as both the unsigned and the signed value Node may report. */
const ABORT_EXITS = new Set([3221226505, -1073740791]);

const TRANSIENT_RE =
  /(\b503\b|\b429\b|overload|unavailable|high demand|rate limit|quota|try again later|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed)/i;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** The actionable line out of a failed gemini-eval run, for the log. */
export function failureReason(out, exit) {
  const api = out.match(/Gemini API error:\s*(.+)/);
  if (api) {
    const msg = api[1].trim().replace(/\s+/g, ' ');
    // Lead with the bracketed status when the SDK supplies one: its message
    // opens with the full endpoint URL, which pushes the status itself past
    // the truncation point and leaves the log line saying nothing.
    const status = msg.match(/\[(\d{3}[^\]]*)\]\s*(.*)/);
    if (status) return (status[1] + ' - ' + status[2]).trim().slice(0, 180);
    return msg.slice(0, 180);
  }
  const val = out.match(/Gemini output failed validation:\s*(.+)/);
  if (val) return 'output failed validation: ' + val[1].trim().slice(0, 140);
  if (ABORT_EXITS.has(exit)) return 'child aborted (0xC0000409) with no diagnostic';
  return 'exit ' + exit;
}

/** A failure worth retrying: the service was busy, not the input was bad. */
export function isTransient(out, exit) {
  if (TRANSIENT_RE.test(out)) return true;
  // An abort carrying no diagnostic is almost certainly that same error path
  // dying before it could flush, so treat it as transient. A validation
  // failure is deterministic and is never retried.
  return ABORT_EXITS.has(exit) && !/Gemini output failed validation/.test(out);
}

/**
 * Run one prescore, retrying transient failures with backoff. `deadline` caps
 * the whole run so a sustained outage cannot push auto-triage into the next
 * hourly scan.
 */
async function runGeminiEval(jdText, index, deadline, retries = 2) {
  let r;
  for (let attempt = 0; ; attempt++) {
    r = runGeminiEvalOnce(jdText, index);
    if (r.score != null) return { ...r, attempts: attempt + 1 };
    if (attempt >= retries) break;
    if (!isTransient(r.out, r.exit)) break;
    const wait = 15_000 * (attempt + 1);
    if (Date.now() + wait > deadline) break;
    console.log('      transient - retry ' + (attempt + 1) + '/' + retries +
                ' in ' + wait / 1000 + 's: ' + failureReason(r.out, r.exit));
    await sleep(wait);
  }
  return { ...r, attempts: retries + 1 };
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
  let transient = 0;
  let aborted = null;
  // Every candidate shares one free-tier quota, so once the service is clearly
  // down there is nothing to gain from walking the rest of the queue - they all
  // fail the same way. Stop, say so, and let the next hourly run retry them.
  let transientStreak = 0;
  const budgetMs = Math.max(60_000, Number(process.env.TRIAGE_BUDGET_MS) || 480_000);
  const deadline = Date.now() + budgetMs;
  const today = day;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const jd = fetchJd(c.url);
    const confidence = jd ? 'jd' : 'title-only';
    const input = jd
      ?? `Job posting (no full description retrievable — judge fit from these fields only, conservatively):\n` +
         `Title: ${c.title}\nCompany: ${c.company}\nLocation: ${c.location}\nSource: ${c.portal}\nURL: ${c.url}`;
    if (Date.now() > deadline) {
      aborted = 'time budget exhausted (' + budgetMs / 1000 + 's)';
      console.log('  · stopping: ' + aborted);
      break;
    }
    const r = await runGeminiEval(input, i, deadline);
    if (r.score == null) {
      failed++;
      const why = failureReason(r.out, r.exit);
      if (isTransient(r.out, r.exit)) {
        transient++;
        transientStreak++;
      } else {
        transientStreak = 0;
      }
      console.log(`  · ${c.title} — eval failed after ${r.attempts} attempt(s): ${why}`);
      if (transientStreak >= 3) {
        aborted = 'gemini unavailable (3 consecutive transient failures)';
        console.log('  · stopping: ' + aborted);
        break;
      }
      continue;
    }
    transientStreak = 0;
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
  console.log(JSON.stringify({
    candidates: candidates.length, scored, titleOnly, failed, transient,
    ...(aborted ? { aborted } : {}),
  }));
}

if (isMainModule(import.meta.url)) await main();
